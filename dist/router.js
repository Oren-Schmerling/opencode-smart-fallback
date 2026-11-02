import { normalizeChain } from "./models.js";
export class FallbackRouter {
    options;
    chains = {};
    agents = {};
    reverseModelToHead = {};
    reverseModelToChain = {};
    sessionPrimaryHead = new Map();
    sessionAgent = new Map();
    sessionActiveTarget = new Map();
    constructor(options) {
        this.options = options;
        // 1. Normalize agent chains
        if (options.agents) {
            for (const [agent, models] of Object.entries(options.agents)) {
                if (Array.isArray(models) && models.length > 0) {
                    this.agents[agent] = [...models];
                    const head = models[0];
                    for (const m of models) {
                        this.reverseModelToHead[m] = head;
                        this.reverseModelToChain[m] = models;
                    }
                }
            }
        }
        // 2. Normalize primary model chains
        if (options.chains) {
            for (const [primary, targets] of Object.entries(options.chains)) {
                const fullChain = normalizeChain(primary, targets);
                this.chains[primary] = fullChain;
                for (const m of fullChain) {
                    this.reverseModelToHead[m] = primary;
                    this.reverseModelToChain[m] = fullChain;
                }
            }
        }
    }
    /**
     * Resolves the active chain for a session, checking agent first, then
     * tracked primary head, then model lookup.
     */
    getActiveChain(sessionID, agentName, currentModel) {
        // 1. Agent chain
        const effectiveAgent = agentName ?? (sessionID ? this.sessionAgent.get(sessionID) : undefined);
        if (effectiveAgent && this.agents[effectiveAgent]) {
            return this.agents[effectiveAgent];
        }
        // 2. Tracked primary head for session
        if (sessionID) {
            const trackedHead = this.sessionPrimaryHead.get(sessionID);
            if (trackedHead && this.chains[trackedHead]) {
                return this.chains[trackedHead];
            }
        }
        // 3. Reverse lookup by current model
        if (currentModel) {
            if (this.chains[currentModel])
                return this.chains[currentModel];
            if (this.reverseModelToChain[currentModel])
                return this.reverseModelToChain[currentModel];
        }
        return undefined;
    }
    /**
     * Returns the first healthy model in the chain whose cooldown is absent or expired.
     * If all models in the chain are cooling down, returns the paid floor (last model).
     */
    async resolveHealthyModel(chain, store, now = Date.now()) {
        if (chain.length === 0)
            return "";
        for (const model of chain) {
            const cd = await store.getCooldown(model, now);
            if (!cd) {
                return model;
            }
        }
        // All models in chain cooling down -> return paid floor
        return chain[chain.length - 1];
    }
    /**
     * Finds the next healthy model to retry after a failure, progressing downstream.
     */
    async findNextRetryModel(chain, failedModel, store, now = Date.now()) {
        if (chain.length === 0)
            return undefined;
        // Try models downstream from failed model in the waterfall
        const failedIdx = chain.indexOf(failedModel);
        const downstream = failedIdx >= 0 ? chain.slice(failedIdx + 1) : chain;
        for (const model of downstream) {
            if (model !== failedModel) {
                const cd = await store.getCooldown(model, now);
                if (!cd)
                    return model;
            }
        }
        // If no healthy model downstream, try any healthy model in chain
        for (const model of chain) {
            if (model !== failedModel) {
                const cd = await store.getCooldown(model, now);
                if (!cd)
                    return model;
            }
        }
        // Check if the paid floor (last in chain) is usable and not the failed model
        const floor = chain[chain.length - 1];
        if (floor && floor !== failedModel) {
            return floor;
        }
        return undefined;
    }
    /**
     * Finds up to 3 healthy OpenRouter models in the chain (for context options.models).
     */
    async findOpenRouterBackups(chain, currentModel, store, now = Date.now()) {
        const backups = [];
        for (const model of chain) {
            if (model !== currentModel && model.startsWith("openrouter/")) {
                const cd = await store.getCooldown(model, now);
                if (!cd) {
                    backups.push(model.slice("openrouter/".length));
                    if (backups.length >= 3)
                        break;
                }
            }
        }
        return backups;
    }
    /**
     * Cleans up tracking state for a deleted session.
     */
    cleanupSession(sessionID) {
        this.sessionPrimaryHead.delete(sessionID);
        this.sessionAgent.delete(sessionID);
        this.sessionActiveTarget.delete(sessionID);
    }
    /**
     * Generates markdown status report for the /fb command.
     */
    async formatStatusReport(store, sessionID, currentModel) {
        const now = Date.now();
        const cooldowns = await store.getAllCooldowns(now);
        const lines = ["### 🔄 Smart Fallback Status\n"];
        if (sessionID) {
            const active = currentModel ?? this.sessionActiveTarget.get(sessionID) ?? "unknown";
            const head = this.sessionPrimaryHead.get(sessionID) ?? "none";
            lines.push(`**Current Session (${sessionID.slice(0, 8)}...)**: Active: \`${active}\` | Primary Head: \`${head}\`\n`);
        }
        // Configured chains
        lines.push("#### Fallback Waterfall Chains");
        if (Object.keys(this.chains).length === 0 && Object.keys(this.agents).length === 0) {
            lines.push("_No fallback chains configured._\n");
        }
        else {
            lines.push("| Chain / Agent | Waterfall Models | Current Target |");
            lines.push("| :--- | :--- | :--- |");
            for (const [primary, fullChain] of Object.entries(this.chains)) {
                const healthy = await this.resolveHealthyModel(fullChain, store, now);
                const chainStr = fullChain.map((m) => `\`${m}\``).join(" → ");
                lines.push(`| **Model:** \`${primary}\` | ${chainStr} | \`${healthy}\` |`);
            }
            for (const [agent, fullChain] of Object.entries(this.agents)) {
                const healthy = await this.resolveHealthyModel(fullChain, store, now);
                const chainStr = fullChain.map((m) => `\`${m}\``).join(" → ");
                lines.push(`| **Agent:** \`${agent}\` | ${chainStr} | \`${healthy}\` |`);
            }
            lines.push("");
        }
        // Active cooldowns
        lines.push("#### Active Cooldowns");
        const activeEntries = Object.entries(cooldowns);
        if (activeEntries.length === 0) {
            lines.push("✅ _All models are currently healthy (no active cooldowns)._\n");
        }
        else {
            lines.push("| Model | Remaining Cooldown | Reason |");
            lines.push("| :--- | :--- | :--- |");
            for (const [model, entry] of activeEntries) {
                const remainingSec = Math.max(0, Math.ceil((entry.until - now) / 1000));
                const remStr = remainingSec > 3600
                    ? `${Math.floor(remainingSec / 3600)}h ${Math.floor((remainingSec % 3600) / 60)}m`
                    : `${remainingSec}s`;
                lines.push(`| \`${model}\` | ⏳ ${remStr} | ${entry.reason} |`);
            }
            lines.push("");
        }
        return lines.join("\n");
    }
}

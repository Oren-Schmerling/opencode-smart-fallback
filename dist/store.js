export class CooldownStore {
    storage;
    cache = {};
    loaded = false;
    constructor(storage) {
        this.storage = storage;
    }
    /**
     * Initializes store from persistent ctx.storage.
     */
    async load() {
        if (this.loaded)
            return;
        try {
            const persisted = await this.storage?.get("cooldowns");
            if (persisted && typeof persisted === "object") {
                this.cache = { ...persisted };
            }
        }
        catch {
            // Storage load is best-effort
        }
        this.loaded = true;
    }
    /**
     * Retrieves active cooldown for a model, or undefined if absent or expired.
     */
    async getCooldown(model, now = Date.now()) {
        await this.load();
        const entry = this.cache[model];
        if (!entry)
            return undefined;
        if (entry.until > now)
            return entry;
        // Prune expired entry
        delete this.cache[model];
        await this.persist();
        return undefined;
    }
    /**
     * Sets cooldown for a model and persists to storage.
     */
    async setCooldown(model, reason, until) {
        await this.load();
        this.cache[model] = { until, reason };
        await this.persist();
    }
    /**
     * Clears cooldown for a specific model.
     */
    async clearCooldown(model) {
        await this.load();
        if (this.cache[model]) {
            delete this.cache[model];
            await this.persist();
        }
    }
    /**
     * Returns all active cooldowns, pruning expired entries.
     */
    async getAllCooldowns(now = Date.now()) {
        await this.load();
        let pruned = false;
        for (const [model, entry] of Object.entries(this.cache)) {
            if (entry.until <= now) {
                delete this.cache[model];
                pruned = true;
            }
        }
        if (pruned) {
            await this.persist();
        }
        return { ...this.cache };
    }
    /**
     * Persists current cache to ctx.storage.
     */
    async persist() {
        try {
            await this.storage?.set("cooldowns", this.cache);
        }
        catch {
            // Storage persist is best-effort
        }
    }
}

import type { CooldownStore } from "./store.js";
import type { SmartFallbackOptions } from "./types.js";
export declare class FallbackRouter {
    readonly options: SmartFallbackOptions;
    readonly chains: Record<string, string[]>;
    readonly agents: Record<string, string[]>;
    readonly reverseModelToHead: Record<string, string>;
    readonly reverseModelToChain: Record<string, string[]>;
    readonly sessionPrimaryHead: Map<string, string>;
    readonly sessionAgent: Map<string, string>;
    readonly sessionActiveTarget: Map<string, string>;
    constructor(options: SmartFallbackOptions);
    /**
     * Resolves the active chain for a session, checking agent first, then
     * tracked primary head, then model lookup.
     */
    getActiveChain(sessionID?: string, agentName?: string, currentModel?: string): string[] | undefined;
    /**
     * Returns the first healthy model in the chain whose cooldown is absent or expired.
     * If all models in the chain are cooling down, returns the paid floor (last model).
     */
    resolveHealthyModel(chain: string[], store: CooldownStore, now?: number): Promise<string>;
    /**
     * Finds the next healthy model to retry after a failure, progressing downstream.
     */
    findNextRetryModel(chain: string[], failedModel: string, store: CooldownStore, now?: number): Promise<string | undefined>;
    /**
     * Finds up to 3 healthy OpenRouter models in the chain (for context options.models).
     */
    findOpenRouterBackups(chain: string[], currentModel: string, store: CooldownStore, now?: number): Promise<string[]>;
    /**
     * Cleans up tracking state for a deleted session.
     */
    cleanupSession(sessionID: string): void;
    /**
     * Generates markdown status report for the /fb command.
     */
    formatStatusReport(store: CooldownStore, sessionID?: string, currentModel?: string): Promise<string>;
}
//# sourceMappingURL=router.d.ts.map
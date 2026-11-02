import type { CooldownMap, ModelCooldown } from "./types.js";
export interface StorageAdapter {
    get: (key: string) => Promise<unknown>;
    set: (key: string, value: unknown) => Promise<void>;
    remove?: (key: string) => Promise<void>;
}
export declare class CooldownStore {
    private storage?;
    private cache;
    private loaded;
    constructor(storage?: StorageAdapter | undefined);
    /**
     * Initializes store from persistent ctx.storage.
     */
    load(): Promise<void>;
    /**
     * Retrieves active cooldown for a model, or undefined if absent or expired.
     */
    getCooldown(model: string, now?: number): Promise<ModelCooldown | undefined>;
    /**
     * Sets cooldown for a model and persists to storage.
     */
    setCooldown(model: string, reason: string, until: number): Promise<void>;
    /**
     * Clears cooldown for a specific model.
     */
    clearCooldown(model: string): Promise<void>;
    /**
     * Returns all active cooldowns, pruning expired entries.
     */
    getAllCooldowns(now?: number): Promise<CooldownMap>;
    /**
     * Persists current cache to ctx.storage.
     */
    private persist;
}
//# sourceMappingURL=store.d.ts.map
import type { CooldownMap, ModelCooldown } from "./types.js";

export interface StorageAdapter {
  get: (key: string) => Promise<unknown>;
  set: (key: string, value: unknown) => Promise<void>;
  remove?: (key: string) => Promise<void>;
}

export class CooldownStore {
  private cache: CooldownMap = {};
  private loaded = false;

  constructor(private storage?: StorageAdapter) {}

  /**
   * Initializes store from persistent ctx.storage.
   */
  async load(): Promise<void> {
    if (this.loaded) return;
    try {
      const persisted = await this.storage?.get("cooldowns");
      if (persisted && typeof persisted === "object") {
        this.cache = { ...(persisted as CooldownMap) };
      }
    } catch {
      // Storage load is best-effort
    }
    this.loaded = true;
  }

  /**
   * Retrieves active cooldown for a model, or undefined if absent or expired.
   */
  async getCooldown(model: string, now = Date.now()): Promise<ModelCooldown | undefined> {
    await this.load();
    const entry = this.cache[model];
    if (!entry) return undefined;
    if (entry.until > now) return entry;

    // Prune expired entry
    delete this.cache[model];
    await this.persist();
    return undefined;
  }

  /**
   * Sets cooldown for a model and persists to storage.
   */
  async setCooldown(model: string, reason: string, until: number): Promise<void> {
    await this.load();
    this.cache[model] = { until, reason };
    await this.persist();
  }

  /**
   * Clears cooldown for a specific model.
   */
  async clearCooldown(model: string): Promise<void> {
    await this.load();
    if (this.cache[model]) {
      delete this.cache[model];
      await this.persist();
    }
  }

  /**
   * Returns all active cooldowns, pruning expired entries.
   */
  async getAllCooldowns(now = Date.now()): Promise<CooldownMap> {
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
  private async persist(): Promise<void> {
    try {
      await this.storage?.set("cooldowns", this.cache);
    } catch {
      // Storage persist is best-effort
    }
  }
}

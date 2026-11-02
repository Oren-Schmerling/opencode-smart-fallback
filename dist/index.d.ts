import { Plugin } from "@opencode/plugin";
import { FallbackRouter } from "./router.js";
import { CooldownStore } from "./store.js";
import type { SmartFallbackOptions } from "./types.js";
export * from "./types.js";
export { FallbackRouter } from "./router.js";
export { CooldownStore } from "./store.js";
export { parseModel, formatModel, normalizeChain } from "./models.js";
export { isRetryableError, calculateCooldownTtl } from "./errors.js";
export declare function resolveOptions(ctx: any, rawOptions?: SmartFallbackOptions): SmartFallbackOptions;
export declare function createSmartFallbackRouter(ctx: any, rawOptions?: SmartFallbackOptions): {
    name: string;
    store: CooldownStore;
    router: FallbackRouter;
    prompt: (event: any) => Promise<void>;
    executeBefore: (event: any) => Promise<void>;
    context: (event: any) => Promise<void>;
    retry: (event: any) => Promise<void>;
    setup: () => Promise<() => Promise<void>>;
};
declare const _default: Plugin.Plugin;
export default _default;
//# sourceMappingURL=index.d.ts.map
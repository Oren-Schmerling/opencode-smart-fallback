import type { ModelRef } from "./types.js";
/**
 * Parses a "provider/model" or "provider/sub/model" string into a ModelRef.
 */
export declare function parseModel(modelStr: string | undefined): ModelRef | undefined;
/**
 * Formats a model reference into a "provider/id" string.
 */
export declare function formatModel(ref: {
    providerID?: string;
    id?: string;
} | ModelRef | undefined): string | undefined;
/**
 * Normalizes a configured chain so the primary head model is always at index 0,
 * followed by any configured fallbacks without duplicates.
 */
export declare function normalizeChain(head: string, targets: string[] | string): string[];
//# sourceMappingURL=models.d.ts.map
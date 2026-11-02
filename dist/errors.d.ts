import type { SmartFallbackOptions } from "./types.js";
export declare const DEFAULT_RETRY_ON_ERRORS: number[];
export declare const DEFAULT_RETRYABLE_PATTERNS: string[];
export declare const DEFAULT_QUOTA_PATTERNS: string[];
export declare const DEFAULT_COOLDOWN_SECONDS = 60;
export declare const DEFAULT_QUOTA_COOLDOWN_SECONDS = 14400;
/**
 * Extracts numeric HTTP status code from an error object or nested response.
 */
export declare function extractStatus(error: unknown): number | undefined;
/**
 * Serializes error information into searchable lowercase text.
 */
export declare function errorToString(error: unknown): string;
/**
 * Checks whether an error is quota exhaustion (warrants 4h tier cooldown).
 */
export declare function isQuotaExhausted(error: unknown, options: SmartFallbackOptions): boolean;
/**
 * Checks whether an error is retryable via failover.
 */
export declare function isRetryableError(error: unknown, options: SmartFallbackOptions): boolean;
/**
 * Extracts Retry-After delay in seconds from error headers or message.
 */
export declare function extractRetryAfter(error: unknown): number | undefined;
/**
 * Computes tiered cooldown TTL and human-readable reason.
 */
export declare function calculateCooldownTtl(error: unknown, options: SmartFallbackOptions): {
    ttlSeconds: number;
    reason: string;
};
//# sourceMappingURL=errors.d.ts.map
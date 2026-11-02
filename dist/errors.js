export const DEFAULT_RETRY_ON_ERRORS = [429, 402, 503, 529];
export const DEFAULT_RETRYABLE_PATTERNS = [
    "rate[ -]?limit",
    "too many requests",
    "overloaded",
    "quota_exceeded",
    "resource_exhausted",
    "capacity",
    "service[ -]?unavailable",
    "model.*unavailable",
    "provider\\.rate-limit",
];
export const DEFAULT_QUOTA_PATTERNS = [
    "free_tier_requests",
    "insufficient_quota",
    "FreeUsageLimitError",
    "daily.*limit",
    "monthly.*limit",
    "quota.*exhausted",
    "credits?.*depleted",
    "billing",
];
export const DEFAULT_COOLDOWN_SECONDS = 60;
export const DEFAULT_QUOTA_COOLDOWN_SECONDS = 14400; // 4 hours
/**
 * Extracts numeric HTTP status code from an error object or nested response.
 */
export function extractStatus(error) {
    if (!error || typeof error !== "object")
        return undefined;
    const err = error;
    const val = err.status ??
        err.statusCode ??
        err.code ??
        err.response?.status ??
        err.data?.status;
    if (typeof val === "number" && !isNaN(val))
        return val;
    if (typeof val === "string" && /^\d+$/.test(val))
        return Number(val);
    return undefined;
}
/**
 * Serializes error information into searchable lowercase text.
 */
export function errorToString(error) {
    if (!error)
        return "";
    if (typeof error === "string")
        return error.toLowerCase();
    if (error instanceof Error) {
        const parts = [error.name, error.message];
        const anyErr = error;
        if (anyErr.type)
            parts.push(String(anyErr.type));
        if (anyErr.response && typeof anyErr.response === "object") {
            parts.push(JSON.stringify(anyErr.response));
        }
        return parts.join(" ").toLowerCase();
    }
    try {
        return JSON.stringify(error).toLowerCase();
    }
    catch {
        return String(error).toLowerCase();
    }
}
/**
 * Checks whether an error is quota exhaustion (warrants 4h tier cooldown).
 */
export function isQuotaExhausted(error, options) {
    const status = extractStatus(error);
    if (status === 402)
        return true;
    const text = errorToString(error);
    const patterns = options.quota_error_patterns ?? DEFAULT_QUOTA_PATTERNS;
    return patterns.some((p) => {
        try {
            return new RegExp(p, "i").test(text);
        }
        catch {
            return text.includes(p.toLowerCase());
        }
    });
}
/**
 * Checks whether an error is retryable via failover.
 */
export function isRetryableError(error, options) {
    if (!error)
        return false;
    const anyErr = error;
    if (anyErr.type === "provider.rate-limit")
        return true;
    const status = extractStatus(error);
    const retryStatuses = options.retry_on_errors ?? DEFAULT_RETRY_ON_ERRORS;
    if (status && retryStatuses.includes(status))
        return true;
    if (isQuotaExhausted(error, options))
        return true;
    const text = errorToString(error);
    const patterns = options.retryable_error_patterns ?? DEFAULT_RETRYABLE_PATTERNS;
    return patterns.some((p) => {
        try {
            return new RegExp(p, "i").test(text);
        }
        catch {
            return text.includes(p.toLowerCase());
        }
    });
}
/**
 * Extracts Retry-After delay in seconds from error headers or message.
 */
export function extractRetryAfter(error) {
    if (!error || typeof error !== "object")
        return undefined;
    const err = error;
    // Check headers
    const headers = err.headers ??
        err.response?.headers;
    let rawHeader;
    if (headers) {
        if (typeof headers.get === "function") {
            rawHeader = headers.get("retry-after");
        }
        else {
            rawHeader = headers["retry-after"] ?? headers["Retry-After"];
        }
    }
    if (rawHeader === undefined) {
        rawHeader = err.retryAfter ?? err.retry_after;
    }
    if (typeof rawHeader === "number" && rawHeader > 0) {
        return Math.ceil(rawHeader);
    }
    if (typeof rawHeader === "string") {
        if (/^\d+$/.test(rawHeader)) {
            const sec = Number(rawHeader);
            if (sec > 0)
                return sec;
        }
        const parsedDate = Date.parse(rawHeader);
        if (!isNaN(parsedDate)) {
            const diffSec = Math.ceil((parsedDate - Date.now()) / 1000);
            if (diffSec > 0)
                return diffSec;
        }
    }
    // Regex check in message
    const text = errorToString(error);
    const match = text.match(/retry[ -]?after[:\s]+(\d+)/i) ?? text.match(/try again in[:\s]+(\d+)\s*s/i);
    if (match?.[1]) {
        const sec = Number(match[1]);
        if (sec > 0)
            return sec;
    }
    return undefined;
}
/**
 * Computes tiered cooldown TTL and human-readable reason.
 */
export function calculateCooldownTtl(error, options) {
    const retryAfter = extractRetryAfter(error);
    if (retryAfter && retryAfter > 0) {
        return { ttlSeconds: retryAfter, reason: `Retry-After (${retryAfter}s)` };
    }
    if (isQuotaExhausted(error, options)) {
        const ttl = options.quota_cooldown_seconds ?? DEFAULT_QUOTA_COOLDOWN_SECONDS;
        return { ttlSeconds: ttl, reason: "Quota exhausted (daily/billing)" };
    }
    const ttl = options.cooldown_seconds ?? DEFAULT_COOLDOWN_SECONDS;
    const typeStr = error?.type;
    const reason = typeof typeStr === "string" ? typeStr : "Rate limit (RPM/TPM)";
    return { ttlSeconds: ttl, reason };
}

/**
 * Smart Fallback options passed via OpenCode config (`~/.config/opencode/opencode.json`):
 * `"plugins": [{ "package": "opencode-smart-fallback", "options": { ... } }]`
 */
export interface SmartFallbackOptions {
  /**
   * Ordered fallback chains mapping a primary "provider/model" to an array of
   * fallback "provider/model" strings (e.g. free tiers -> OpenRouter -> paid floor).
   * Also accepts a single string for 1-to-1 compatibility.
   */
  chains?: Record<string, string[] | string>;
  /**
   * Optional per-agent ordered model chains (e.g. { "scout": ["google/gemini-2.5-flash", "openrouter/free"] }).
   * First item in the array is the preferred primary model for that agent.
   */
  agents?: Record<string, string[]>;
  /** HTTP status codes that trigger failover. Default: [429, 402, 503, 529] */
  retry_on_errors?: number[];
  /** Regex patterns matching rate-limit or transient errors. */
  retryable_error_patterns?: string[];
  /** Regex patterns matching daily/monthly quota exhaustion for long cooldowns. */
  quota_error_patterns?: string[];
  /** Cooldown for standard RPM/TPM rate limits in seconds. Default: 60 */
  cooldown_seconds?: number;
  /** Cooldown for daily/quota exhaustion in seconds. Default: 14400 (4 hours) */
  quota_cooldown_seconds?: number;
  /** Log route changes to OpenCode server logs. Default: true */
  notify_on_fallback?: boolean;
}

export interface ModelCooldown {
  until: number;
  reason: string;
}

export type CooldownMap = Record<string, ModelCooldown>;

export interface ModelRef {
  providerID: string;
  id: string;
}

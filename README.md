# opencode-smart-fallback

> **Zero-Cancellation Multi-Hop Model Waterfall & Failover Plugin for OpenCode V2**

[![CI](https://github.com/Oren-Schmerling/opencode-smart-fallback/actions/workflows/ci.yml/badge.svg)](https://github.com/Oren-Schmerling/opencode-smart-fallback/actions/workflows/ci.yml)
[![npm version](https://img.shields.io/npm/v/opencode-smart-fallback.svg)](https://www.npmjs.com/package/opencode-smart-fallback)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

`opencode-smart-fallback` provides production-grade, in-fiber model waterfall routing, multi-hop free-tier draining, per-agent chains, tiered cooldowns (RPM vs. daily quota), and subagent-safe failover for OpenCode V2 (`@opencode/plugin`).

---

## Why OpenCode V2 Needs In-Fiber Failover

In OpenCode V1 and early plugins, error handlers typically called reactive primitives such as `session.abort()`, `session.revert()`, or `session.promptAsync()`.

### The Problem
In OpenCode V2, sessions and subagents run inside structured **Effect fibers** (`s.block`, `SessionRunner`). When a subagent encounters a rate limit or transient error:
1. Calling `abort()` tears down the entire fiber hierarchy, killing parent agent coordinators and discarding in-flight subagent context.
2. Calling `promptAsync()` spins up a new disconnected session lifecycle rather than repairing the active turn.
3. Hooking into `aisdk.hook("language")` operates below the session orchestration layer, leaving session state inconsistent.

### The Solution: Zero-Cancellation In-Fiber Retry
`opencode-smart-fallback` intercepts errors within the active fiber via `ctx.session.hook("retry")`:
1. Classifies the error and sets a persistent cooldown in `ctx.storage`.
2. Switches the session to the next healthy model via `ctx.session.switchModel()`.
3. Sets `event.decision = { retry: true, delay: 0 }`.

OpenCode's `SessionRunner` fiber immediately rebuilds and replays the request against the new provider **inside the existing fiber**, keeping parent agent coordinators and subagent trees 100% intact.

---

## Features

- 🌊 **Multi-Hop Waterfalls:** Chain free tiers (e.g. Gemini AI Studio → Groq → OpenRouter Free) down to a paid floor (Claude 3.5 Sonnet / GPT-4o).
- 🤖 **Per-Agent Chains:** Assign specialized waterfalls to individual subagents (e.g. fast free models for `scout`, reasoning models for `build`).
- ⏱️ **Tiered Cooldowns:**
  - Standard rate limits (429 / TPM / RPM): **60 seconds** cooldown (or provider `Retry-After`).
  - Quota exhaustion (402, `free_tier_requests`, `insufficient_quota`, `FreeUsageLimitError`): **4 hours** cooldown.
- 🔄 **Automatic Head Recovery:** Subsequent prompts automatically return to your primary preferred model the moment its cooldown expires.
- 🛡️ **Subagent Admission Rewriting:** Rewrites `subagent` and `task` tool inputs before spawning, preventing subagents from launching on known dead models.
- 🌐 **OpenRouter In-Flight Safety Net:** Attaches up to 3 healthy OpenRouter backup models to `event.options.models` via the `context` hook.
- 📊 **Transparency Command (`/fb`):** Run `/fb` inside OpenCode to view an interactive Markdown report of your waterfall chains, active models, and remaining cooldown timers.

---

## Installation

Add `opencode-smart-fallback` to your `~/.config/opencode/opencode.json`:

```json
{
  "plugins": [
    {
      "package": "opencode-smart-fallback",
      "options": {
        "chains": {
          "google/gemini-2.5-flash": [
            "groq/llama-3.3-70b",
            "cerebras/llama-3.3-70b",
            "openrouter/meta-llama/llama-3.3-70b-instruct:free",
            "anthropic/claude-3-5-sonnet"
          ]
        }
      }
    }
  ]
}
```

---

## Configuration Reference

| Option | Type | Default | Description |
| :--- | :--- | :--- | :--- |
| `chains` | `Record<string, string[] \| string>` | `{}` | Mappings of primary `"provider/model"` to ordered fallback models. |
| `agents` | `Record<string, string[]>` | `{}` | Per-agent model chains. Index 0 is the primary model for that agent. |
| `retry_on_errors` | `number[]` | `[429, 402, 503, 529]` | HTTP status codes triggering failover. |
| `retryable_error_patterns` | `string[]` | Rate limit defaults | Regex patterns matching transient/rate-limit errors. |
| `quota_error_patterns` | `string[]` | Quota defaults | Regex patterns matching daily/monthly quota exhaustion. |
| `cooldown_seconds` | `number` | `60` | Cooldown for standard RPM/TPM rate limits. |
| `quota_cooldown_seconds` | `number` | `14400` (4h) | Cooldown for quota exhaustion. |
| `notify_on_fallback` | `boolean` | `true` | Log routing and failover events to OpenCode server logs. |

---

## Example: Draining Free Tiers into a Paid Floor

Drain free provider quotas completely before falling back to your paid API key:

```json
{
  "plugins": [
    {
      "package": "opencode-smart-fallback",
      "options": {
        "chains": {
          "google/gemini-2.5-flash": [
            "groq/llama-3.3-70b",
            "cerebras/llama-3.3-70b",
            "openrouter/meta-llama/llama-3.3-70b-instruct:free",
            "anthropic/claude-3-5-sonnet"
          ]
        },
        "agents": {
          "scout": [
            "google/gemini-2.5-flash",
            "groq/llama-3.3-70b",
            "openrouter/meta-llama/llama-3.3-70b-instruct:free"
          ],
          "reviewer": [
            "anthropic/claude-3-5-sonnet",
            "openai/gpt-4o"
          ]
        },
        "cooldown_seconds": 60,
        "quota_cooldown_seconds": 14400,
        "notify_on_fallback": true
      }
    }
  ]
}
```

---

## Slash Command: `/fb`

Type `/fb` in any OpenCode session to view waterfall chains and active cooldowns:

```markdown
### 🔄 Smart Fallback Status

**Current Session (8e4951db...)**: Active: `groq/llama-3.3-70b` | Primary Head: `google/gemini-2.5-flash`

#### Fallback Waterfall Chains
| Chain / Agent | Waterfall Models | Current Target |
| :--- | :--- | :--- |
| **Model:** `google/gemini-2.5-flash` | `google/gemini-2.5-flash` → `groq/llama-3.3-70b` → `anthropic/claude-3-5-sonnet` | `groq/llama-3.3-70b` |
| **Agent:** `scout` | `google/gemini-2.5-flash` → `groq/llama-3.3-70b` | `groq/llama-3.3-70b` |

#### Active Cooldowns
| Model | Remaining Cooldown | Reason |
| :--- | :--- | :--- |
| `google/gemini-2.5-flash` | ⏳ 42s | Rate limit (RPM/TPM) |
```

---

## Troubleshooting & Cache Clearing

When updating the plugin locally or after publishing a new version, clear OpenCode's package cache:

```bash
rm -rf ~/.cache/opencode/packages/opencode-smart-fallback
```

---

## License

MIT © [Oren Schmerling](https://github.com/Oren-Schmerling)

# OpenCode Smart Fallback & Agent Router

An advanced, zero-build model fallback router and primary agent manager for OpenCode.

Unlike naive fallback solutions that simply retry or break mid-turn tool loops, this plugin intercepts requests at the agent level, tracks independent fallback chains per subagent, natively integrates with OpenCode's UI, accurately parses provider quotas and rate limits, and features hybrid recovery (revert vs. continue) to rescue long-running workflows without losing context.

## 🌟 Key Features

- **Zero-Build TypeScript:** Runs natively in OpenCode via Bun. No `dist/` folders, no build steps, instant reloads.
- **Per-Agent Fallback Chains:** Define distinct model failover hierarchies tailored to each agent role (`plan`, `build`, `deep-review`, `fast-patch`, `general`, `explore`, `*`).
- **Smart Quota & Retry-After Parser:**
  - Parses Google and OpenRouter error messages like `"Please retry in 5h31m1.95s"`.
  - Distinguishes hard/daily quota exhaustion (`free_tier_requests`, `requests per day`, `insufficient_quota`) from transient per-minute/rolling-window rate limits (`per minute limit exceeded`, `rate-limits`).
  - Quarantines hard quotas for at least `quotaCooldownMs` (default 4h) and per-minute rate limits for at least `cooldownMs` (default 60s), honoring a longer provider retry-after when present. This prevents a short `"retry in 2s"` hint from un-quarantining a dead model before the next subagent is spawned.
  - Unknown errors, `"try again later"` responses with no timer, and HTTP `426 Upgrade Required` fall back to `quarantineAfterFallbackMs` (default 4h) so a blocked model is not re-selected every couple of minutes.
  - Bypasses remaining retry attempts immediately when hard quota limits are hit.
- **Hybrid Mid-Turn Recovery:**
  - If a model hits an error mid-turn after completing tool executions, the plugin detects progress and sends a *continue* directive.
  - If a model fails before any tool work was executed, it reverts cleanly to the prompt state before replaying.
- **Persistent Health State:** Quarantines and cooldowns are synced to `~/.local/share/opencode/model-fallback-health.json`, persisting across sessions and CLI invocations.
- **Automatic Model Resolution:** Primary agents (`plan`, `build`, `deep-review`, `fast-patch`) automatically point directly to the first healthy model in their configured fallback chain, cleanly integrating with OpenCode's native model selector without dummy entries or synthetic provider injection.
- **In-Session Dashboard & Control:**
  - Slash command `/fb` (and tool `fallback_ctl`) to inspect real-time agent chains, global model health, and event tails.
  - Always hydrates active session state so the dashboard never renders empty or missing info.

---

## 🚀 Installation

Because OpenCode executes plugins directly using Bun, you can point your configuration directly to the TypeScript source.

1. **Clone or copy into your OpenCode plugins directory:**
   ```bash
   mkdir -p ~/.config/opencode/plugins
   cd ~/.config/opencode/plugins
   git clone https://github.com/Oren-Schmerling/opencode-smart-fallback.git model-fallback
   ```

2. **Register the plugin and command in `~/.config/opencode/opencode.jsonc`:**
   ```jsonc
   {
     "$schema": "https://opencode.ai/config.json",
     "plugin": [
       "file:///home/<your-user>/.config/opencode/plugins/model-fallback"
     ],
     "command": {
       "fb": {
         "description": "Inspect or control model fallback health (status | tail | reset | quarantine)",
         "template": "$ARGUMENTS"
       }
     }
   }
   ```

3. **Configure fallback chains in `~/.config/opencode/model-fallback.json`** (see below).

---

## ⚙️ Configuration (`model-fallback.json`)

Place this file at `~/.config/opencode/model-fallback.json`:

```json
{
  "enabled": true,
  "defaults": {
    "retriesBeforeFallback": 0,
    "quarantineAfterFallbackMs": 14400000,
    "cooldownMs": 60000,
    "quotaCooldownMs": 14400000,
    "maxFallbackDepth": 4,
    "strategy": "auto",
    "abortTimeoutMs": 15000,
    "revertTimeoutMs": 15000,
    "replayTimeoutMs": 600000
  },
  "primaryAgents": {
    "plan": {
      "description": "Architecture & planning primary agent (read-only orchestration)",
      "temperature": 0.2,
      "tools": {
        "write": false,
        "edit": false,
        "patch": false,
        "bash": false,
        "read": true,
        "list": true,
        "grep": false,
        "glob": false
      }
    },
    "build": {
      "description": "Full-access implementation primary agent with automatic model failover",
      "temperature": 0.1,
      "tools": {
        "write": true,
        "edit": true,
        "patch": true,
        "bash": true,
        "read": true,
        "list": true
      }
    },
    "deep-review": {
      "description": "High-reasoning code review & security audit primary agent",
      "temperature": 0.1,
      "tools": {
        "write": false,
        "edit": false,
        "bash": false,
        "read": true,
        "list": true,
        "grep": true,
        "glob": true
      }
    },
    "fast-patch": {
      "description": "Low-latency surgical editing primary agent on fast flash tiers",
      "temperature": 0.0,
      "tools": {
        "write": true,
        "edit": true,
        "bash": true,
        "read": true,
        "list": true
      }
    }
  },
  "agents": {
    "plan": {
      "strategy": "auto",
      "retriesBeforeFallback": 0,
      "chain": [
        "openrouter/~deepseek/deepseek-flash-latest",
        "google/gemini-3.8-flash",
        "google/gemini-3.8-flash-lite",
        "openrouter/openrouter/free"
      ]
    },
    "build": {
      "strategy": "auto",
      "retriesBeforeFallback": 0,
      "chain": [
        "openrouter/~deepseek/deepseek-flash-latest",
        "google/gemini-3.8-flash",
        "google/gemini-3.8-flash-lite",
        "openrouter/openrouter/free"
      ]
    },
    "deep-review": {
      "strategy": "auto",
      "retriesBeforeFallback": 0,
      "chain": [
        "openrouter/~deepseek/deepseek-flash-latest",
        "google/gemini-3.8-flash",
        "openrouter/openrouter/free"
      ]
    },
    "fast-patch": {
      "strategy": "continue",
      "retriesBeforeFallback": 0,
      "chain": [
        "google/gemini-3.8-flash-lite",
        "openrouter/~deepseek/deepseek-flash-latest",
        "google/gemini-3.8-flash",
        "openrouter/openrouter/free"
      ]
    },
    "general": {
      "strategy": "auto",
      "retriesBeforeFallback": 0,
      "chain": [
        "openrouter/~deepseek/deepseek-flash-latest",
        "google/gemini-3.8-flash-lite",
        "google/gemini-3.8-flash",
        "openrouter/openrouter/free"
      ]
    },
    "explore": {
      "strategy": "continue",
      "retriesBeforeFallback": 0,
      "chain": [
        "google/gemini-3.8-flash-lite",
        "openrouter/~deepseek/deepseek-flash-latest",
        "openrouter/openrouter/free"
      ]
    },
    "*": {
      "strategy": "auto",
      "retriesBeforeFallback": 0,
      "chain": [
        "openrouter/~deepseek/deepseek-flash-latest",
        "google/gemini-3.8-flash-lite",
        "google/gemini-3.8-flash",
        "openrouter/openrouter/free"
      ]
    }
  }
}
```

---

## 🎯 Model Configuration & Chain Resolution

OpenCode's model selector natively reflects the primary model assigned to each agent. The fallback plugin configures each agent at startup to point directly to the first healthy model defined in its fallback chain:
- The model selector displays standard, selectable model entries without synthetic locks or dummy models.
- If a model is quarantined due to rate limits or quota exhaustion, requests automatically route to the next healthy model in the chain while preserving turn progress.
- Primary agents can be declared normally in `opencode.jsonc`, and `model-fallback` will ensure they start at the head of their respective fallback chains.

---

## 🛠️ Usage & Commands

### Slash Command: `/fb`
- `/fb status` (or `/fb`): Renders full dashboard showing active session state, per-agent chain routing, and model health.
- `/fb tail [N]`: Shows the last $N$ fallback events (defaults to 15, max 50).
- `/fb reset [all | <provider/model>]`: Clears quarantines globally or for a specific model.
- `/fb quarantine <provider/model> [seconds]`: Manually quarantines a flaky model (defaults to 300s).

### Tool: `fallback_ctl`
The plugin registers a native OpenCode tool `fallback_ctl` callable by agents for programmatic inspection or management:
```json
{
  "action": "status"
}
```

---

## 🧪 Testing

Run unit tests via Bun:
```bash
bun test
```

## 📄 License
MIT License

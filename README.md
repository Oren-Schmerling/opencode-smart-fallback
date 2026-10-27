# OpenCode Smart Fallback & Agent Router

An advanced, zero-build model fallback router and primary agent manager for OpenCode.

Unlike naive fallback solutions that simply retry or break mid-turn tool loops, this plugin intercepts requests at the agent level, tracks independent fallback chains per subagent, natively integrates with OpenCode's UI, accurately parses provider quotas and rate limits, and features hybrid recovery (revert vs. continue) to rescue long-running workflows without losing context.

## 🌟 Key Features

- **Zero-Build TypeScript:** Runs natively in OpenCode via Bun. No `dist/` folders, no build steps, instant reloads.
- **Per-Agent Fallback Chains:** Define distinct model failover hierarchies tailored to each agent role (`plan`, `build`, `deep-review`, `fast-patch`, `general`, `explore`, `*`).
- **Smart Quota & Retry-After Parser:**
  - Parses Google and OpenRouter error messages like `"Please retry in 5h31m1.95s"`.
  - Detects daily free-tier quota exhaustion (`free_tier_requests`, `requests per day`, `exceeded your current quota`, `insufficient_quota`).
  - Quarantines the exhausted model for the exact duration specified by the provider rather than a generic 60-second cooldown, preventing wasted retries on dead quotas.
  - Bypasses remaining retry attempts immediately when hard quota limits are hit.
- **Hybrid Mid-Turn Recovery:**
  - If a model hits an error mid-turn after completing tool executions, the plugin detects progress and sends a *continue* directive.
  - If a model fails before any tool work was executed, it reverts cleanly to the prompt state before replaying.
- **Persistent Health State:** Quarantines and cooldowns are synced to `~/.local/share/opencode/model-fallback-health.json`, persisting across sessions and CLI invocations.
- **Primary Agent UI Lock:** Registers primary agents (`plan`, `build`, `deep-review`, `fast-patch`) under connected providers (e.g. `google/agent-lock-<agent>`), surfacing `🔒 Agent: <agent>` in the model dropdown and preventing accidental model desynchronization.
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
   git clone https://github.com/YOUR_GITHUB_USERNAME/opencode-smart-fallback.git model-fallback
   ```

2. **Register the plugin and command in `~/.config/opencode/opencode.jsonc`:**
   ```jsonc
   {
     "$schema": "https://opencode.ai/config.json",
     "plugin": [
       "file:///home/YOUR_USER/.config/opencode/plugins/model-fallback/index.ts"
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
  "lockModelDropdownForPrimaryAgents": true,
  "hostProviderForLockedModels": "google",
  "defaults": {
    "retriesBeforeFallback": 0,
    "quarantineAfterFallbackMs": 120000,
    "cooldownMs": 60000,
    "quotaCooldownMs": 1800000,
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
      "lockModelSelector": true,
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
      "lockModelSelector": true,
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
      "lockModelSelector": true,
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
      "lockModelSelector": true,
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

## 🔒 Primary Agent Lock & UI Integration

To enable the locked model dropdown for primary agents in OpenCode's TUI/GUI:

1. **In `opencode.jsonc`**, declare the synthetic locked models under `provider.<hostProvider>.models`:
   ```jsonc
   "provider": {
     "google": {
       "models": {
         "agent-lock-plan": {
           "id": "gemini-3.8-flash-lite",
           "name": "🔒 Agent: plan",
           "attachment": true,
           "reasoning": true,
           "temperature": true,
           "tool_call": true
         },
         "agent-lock-build": {
           "id": "gemini-3.8-flash-lite",
           "name": "🔒 Agent: build",
           "attachment": true,
           "reasoning": true,
           "temperature": true,
           "tool_call": true
         },
         "agent-lock-deep-review": {
           "id": "gemini-3.8-flash-lite",
           "name": "🔒 Agent: deep-review",
           "attachment": true,
           "reasoning": true,
           "temperature": true,
           "tool_call": true
         },
         "agent-lock-fast-patch": {
           "id": "gemini-3.8-flash-lite",
           "name": "🔒 Agent: fast-patch",
           "attachment": true,
           "reasoning": true,
           "temperature": true,
           "tool_call": true
         }
       }
     }
   }
   ```

2. Point primary agents to these locked model keys in `agent`:
   ```jsonc
   "agent": {
     "plan": { "mode": "primary", "model": "google/agent-lock-plan" },
     "build": { "mode": "primary", "model": "google/agent-lock-build" },
     "deep-review": { "mode": "primary", "model": "google/agent-lock-deep-review" },
     "fast-patch": { "mode": "primary", "model": "google/agent-lock-fast-patch" }
   }
   ```

3. **Client-Side UI Lock script (`ui-lock.js`)**: Included in the repository to observe the DOM and disable model switching buttons whenever a locked primary agent is active.

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

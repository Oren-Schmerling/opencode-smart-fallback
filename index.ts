import { type Plugin, tool } from "@opencode-ai/plugin";
import { mkdirSync, appendFileSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";

export const MODEL_KEY_REGEX = /^[a-zA-Z0-9_-]{1,100}\/[a-zA-Z0-9._~\/:-]{1,200}$/;
export const LOCKED_MODEL_PREFIX = "agent-lock-";

export type RecoveryStrategy = "auto" | "continue" | "revert";

export interface PrimaryAgentDef {
  description?: string;
  temperature?: number;
  lockModelSelector?: boolean;
  hostProvider?: string;
  prompt?: string;
  tools?: Record<string, boolean>;
}

export interface AgentChainObject {
  chain: string[];
  strategy?: RecoveryStrategy;
  retriesBeforeFallback?: number;
  quarantineAfterFallbackMs?: number;
}

export type AgentChainConfig = string[] | AgentChainObject;

export interface FallbackConfig {
  enabled: boolean;
  defaults: {
    retriesBeforeFallback: number;
    quarantineAfterFallbackMs: number;
    cooldownMs: number;
    quotaCooldownMs: number;
    maxFallbackDepth: number;
    strategy: RecoveryStrategy;
    abortTimeoutMs: number;
    revertTimeoutMs: number;
    replayTimeoutMs: number;
  };
  primaryAgents: Record<string, PrimaryAgentDef>;
  agents: Record<string, AgentChainConfig>;
  logPath: string;
  statePath: string;
  lockModelDropdownForPrimaryAgents?: boolean;
  hostProviderForLockedModels?: string;
}

interface NormalizedAgentPolicy {
  chain: string[];
  strategy: RecoveryStrategy;
  retriesBeforeFallback: number;
  quarantineAfterFallbackMs: number;
}

interface ModelHealthEntry {
  state: "healthy" | "quarantined" | "cooldown" | "quota_exhausted" | "retired";
  until: number;
  reason: string;
  statusCode?: number;
  failures: number;
  lastFailureAt: number;
}

interface SessionTrack {
  epoch: number;
  depth: number;
  activeModel?: string;
  agent: string;
  parentID?: string;
  isSubagent?: boolean;
  lastUserText?: string;
  lastUserMessageID?: string;
  recovering: boolean;
  history: Array<{ at: string; agent: string; from: string; to: string; reason: string; strategy: string }>;
}

interface LogEvent {
  ts: string;
  event: string;
  sessionID?: string;
  agent?: string;
  from?: string;
  to?: string;
  attempt?: number;
  statusCode?: number;
  strategy?: string;
  detail?: string;
}

const DEFAULT_CONFIG: FallbackConfig = {
  enabled: true,
  defaults: {
    retriesBeforeFallback: 0,
    quarantineAfterFallbackMs: 14_400_000,
    cooldownMs: 60_000,
    quotaCooldownMs: 14_400_000,
    maxFallbackDepth: 4,
    strategy: "auto",
    abortTimeoutMs: 15_000,
    revertTimeoutMs: 15_000,
    replayTimeoutMs: 600_000,
  },
  primaryAgents: {
    plan: {
      description: "Architecture & planning primary agent (read-only orchestration)",
      temperature: 0.2,
    },
    build: {
      description: "Full-access implementation primary agent with automatic model failover",
      temperature: 0.1,
    },
    "deep-review": {
      description: "High-reasoning code review & security audit primary agent",
      temperature: 0.1,
    },
    "fast-patch": {
      description: "Low-latency surgical editing primary agent on fast flash tiers",
      temperature: 0.0,
    },
  },
  agents: {
    "*": [
      "openrouter/~deepseek/deepseek-flash-latest",
      "google/gemini-3.8-flash-lite",
      "google/gemini-3.8-flash",
      "openrouter/openrouter/free",
    ],
  },
  logPath: join(homedir(), ".local/share/opencode/logs/model-fallback.jsonl"),
  statePath: join(homedir(), ".local/share/opencode/model-fallback-health.json"),
};

export function loadConfig(): FallbackConfig {
  const candidates = [
    join(process.cwd(), ".opencode/model-fallback.json"),
    join(homedir(), ".config/opencode/model-fallback.json"),
  ];
  for (const p of candidates) {
    if (existsSync(p)) {
      try {
        const raw = JSON.parse(readFileSync(p, "utf8"));
        return {
          ...DEFAULT_CONFIG,
          ...raw,
          defaults: { ...DEFAULT_CONFIG.defaults, ...(raw.defaults ?? {}) },
          primaryAgents: { ...DEFAULT_CONFIG.primaryAgents, ...(raw.primaryAgents ?? {}) },
          agents: { ...DEFAULT_CONFIG.agents, ...(raw.agents ?? {}) },
        };
      } catch {}
    }
  }
  return DEFAULT_CONFIG;
}

export function normalizeAgentPolicy(
  config: FallbackConfig,
  agentName?: string
): NormalizedAgentPolicy {
  const raw = (agentName && config.agents[agentName]) ?? config.agents["*"] ?? [];
  if (Array.isArray(raw)) {
    return {
      chain: raw.filter((m) => MODEL_KEY_REGEX.test(m)),
      strategy: config.defaults.strategy,
      retriesBeforeFallback: config.defaults.retriesBeforeFallback,
      quarantineAfterFallbackMs: config.defaults.quarantineAfterFallbackMs,
    };
  }
  return {
    chain: (raw.chain ?? []).filter((m) => MODEL_KEY_REGEX.test(m)),
    strategy: raw.strategy ?? config.defaults.strategy,
    retriesBeforeFallback:
      typeof raw.retriesBeforeFallback === "number"
        ? Math.max(0, Math.min(10, Math.trunc(raw.retriesBeforeFallback)))
        : config.defaults.retriesBeforeFallback,
    quarantineAfterFallbackMs:
      typeof raw.quarantineAfterFallbackMs === "number"
        ? raw.quarantineAfterFallbackMs
        : config.defaults.quarantineAfterFallbackMs,
  };
}

export function splitModelKey(
  key: string
): { providerID: string; modelID: string; id: string } | null {
  if (!MODEL_KEY_REGEX.test(key)) return null;
  const idx = key.indexOf("/");
  const providerID = key.slice(0, idx);
  const modelID = key.slice(idx + 1);
  return {
    providerID,
    modelID,
    id: modelID,
  };
}

export function isSyntheticAgentModel(modelKey?: string): boolean {
  if (!modelKey) return false;
  if (modelKey.startsWith("agent-locked/")) return true;
  const parsed = splitModelKey(modelKey);
  return Boolean(parsed && parsed.modelID.startsWith(LOCKED_MODEL_PREFIX));
}

export function extractAgentFromSyntheticModel(modelKey?: string): string | null {
  if (!modelKey) return null;
  if (modelKey.startsWith("agent-locked/")) return modelKey.slice("agent-locked/".length);
  const parsed = splitModelKey(modelKey);
  if (parsed && parsed.modelID.startsWith(LOCKED_MODEL_PREFIX)) {
    return parsed.modelID.slice(LOCKED_MODEL_PREFIX.length);
  }
  return null;
}

/**
 * Parses Google / OpenRouter retry durations like "Please retry in 5h31m1.955s"
 * and detects hard daily quota exhaustion ("free_tier_requests", "requests per day").
 */
export function parseQuotaAndRetryMs(reason: string): {
  isHardQuota: boolean;
  isRateLimit: boolean;
  retryAfterMs?: number;
} {
  // Per-minute / rolling-window limits are transient. Google phrases these as
  // "You exceeded your current quota", so they must be detected *before* the
  // hard-quota regex or they get quarantined for only the tiny retry-after
  // (often 2-10s) and are immediately re-selected by the next subagent.
  const isRateLimit = /per minute|per_minute|tokens per minute|rate.?limit/i.test(reason);

  const isHardQuota =
    !isRateLimit &&
    /free_tier_requests|requests per day|exceeded your current quota|billing details|insufficient_quota|freeusagelimiterror|free usage limit|opencode\.ai\/go|timed?\s*out|timeout|deadline_exceeded/i.test(
      reason
    );

  // Match patterns like "retry in 5h31m1.95s", "retry in 42m10s", "retry in 35.5s"
  const retryMatch = reason.match(
    /retry in\s+(?:(\d+)h)?(?:(\d+)m)?(?:(\d+(?:\.\d+)?)s)?/i
  );
  if (retryMatch && (retryMatch[1] || retryMatch[2] || retryMatch[3])) {
    const hours = Number(retryMatch[1] || 0);
    const mins = Number(retryMatch[2] || 0);
    const secs = Number(retryMatch[3] || 0);
    const totalMs = Math.ceil((hours * 3600 + mins * 60 + secs) * 1000);
    if (totalMs > 0) {
      return {
        isHardQuota: isHardQuota || totalMs >= 300_000,
        isRateLimit,
        retryAfterMs: totalMs,
      };
    }
  }

  return { isHardQuota, isRateLimit };
}

/**
 * Computes how long a model should be quarantined and in which state.
 * Hard/daily quotas always get at least `quotaCooldownMs`; transient
 * per-minute rate limits always get at least `cooldownMs`. This prevents a
 * provider's short "retry in Ns" hint from un-quarantining a dead model
 * before the next subagent is spawned.
 */
export function computeQuarantine(
  parsedQuota: { isHardQuota: boolean; isRateLimit: boolean; retryAfterMs?: number },
  statusCode: number | undefined,
  baseDurationMs: number,
  defaults: { cooldownMs: number; quotaCooldownMs: number }
): { duration: number; state: ModelHealthEntry["state"] } {
  let duration = baseDurationMs;
  let state: ModelHealthEntry["state"] = "quarantined";

  if (statusCode === 410 || statusCode === 404) {
    duration = Number.POSITIVE_INFINITY;
    state = "retired";
  } else if (statusCode === 402 || statusCode === 426 || parsedQuota.isHardQuota) {
    // 426 Upgrade Required means the tier is blocked until the account is
    // upgraded, so keep it out of rotation for the full quota cooldown.
    duration = Math.max(duration, defaults.quotaCooldownMs);
    state = "quota_exhausted";
  } else if (statusCode === 429 || parsedQuota.isRateLimit) {
    duration = Math.max(duration, defaults.cooldownMs);
    state = "cooldown";
  }

  return { duration, state };
}

function formatDuration(ms: number): string {
  if (!Number.isFinite(ms)) return "∞ (Retired)";
  const totalSec = Math.max(1, Math.ceil(ms / 1000));
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  if (h > 0) return `${h}h${m}m`;
  if (m > 0) return `${m}m${s}s`;
  return `${s}s`;
}

async function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`Timeout after ${ms}ms in ${label}`)), ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export const SmartFallbackPlugin: Plugin = async ({ client }, options) => {
  const fileConfig = loadConfig();
  const config: FallbackConfig = {
    ...fileConfig,
    ...(options as any),
    defaults: { ...fileConfig.defaults, ...((options as any)?.defaults ?? {}) },
    primaryAgents: { ...fileConfig.primaryAgents, ...((options as any)?.primaryAgents ?? {}) },
    agents: { ...fileConfig.agents, ...((options as any)?.agents ?? {}) },
  };
  const health = new Map<string, ModelHealthEntry>();
  const sessions = new Map<string, SessionTrack>();
  const ringBuffer: LogEvent[] = [];
  let lastActiveSessionID: string | undefined;

  mkdirSync(dirname(config.logPath), { recursive: true });
  mkdirSync(dirname(config.statePath), { recursive: true });

  const getConfig = (): FallbackConfig => {
    const file = loadConfig();
    return {
      ...file,
      ...(options as any),
      defaults: { ...file.defaults, ...((options as any)?.defaults ?? {}) },
      primaryAgents: { ...file.primaryAgents, ...((options as any)?.primaryAgents ?? {}) },
      agents: { ...file.agents, ...((options as any)?.agents ?? {}) },
    };
  };

  const syncHealthFromDisk = () => {
    if (!existsSync(config.statePath)) return;
    try {
      const data = JSON.parse(readFileSync(config.statePath, "utf8")) as Record<string, ModelHealthEntry>;
      const now = Date.now();
      health.clear();
      for (const [k, v] of Object.entries(data)) {
        if (v.until > now) health.set(k, v);
      }
    } catch {}
  };

  const persistHealthToDisk = () => {
    try {
      const now = Date.now();
      const out: Record<string, ModelHealthEntry> = {};
      for (const [k, v] of health.entries()) {
        if (v.until > now && Number.isFinite(v.until)) out[k] = v;
      }
      writeFileSync(config.statePath, JSON.stringify(out, null, 2));
    } catch {}
  };

  syncHealthFromDisk();

  const log = (entry: Omit<LogEvent, "ts">) => {
    const full: LogEvent = { ts: new Date().toISOString(), ...entry };
    ringBuffer.push(full);
    if (ringBuffer.length > 100) ringBuffer.shift();
    try {
      appendFileSync(config.logPath, JSON.stringify(full) + "\n");
    } catch {}
  };

  const toast = async (
    message: string,
    variant: "info" | "warning" | "error" | "success" = "info"
  ) => {
    try {
      await client.tui.showToast({ body: { message, variant } });
    } catch {}
  };

  const isUsable = (modelKey: string): boolean => {
    if (isSyntheticAgentModel(modelKey)) return false;
    syncHealthFromDisk();
    const entry = health.get(modelKey);
    if (!entry) return true;
    if (Date.now() >= entry.until) {
      health.delete(modelKey);
      persistHealthToDisk();
      return true;
    }
    return false;
  };

  const resolveFirstHealthyModel = (agentName?: string, currentModel?: string): string | null => {
    const policy = normalizeAgentPolicy(getConfig(), agentName);
    const chain = policy.chain;
    if (!chain.length) return null;

    if (!currentModel || isSyntheticAgentModel(currentModel)) {
      for (const candidate of chain) {
        if (isUsable(candidate)) return candidate;
      }
      return chain[0] ?? null;
    }

    const idx = chain.indexOf(currentModel);
    const ordered = idx >= 0 ? [...chain.slice(idx + 1), ...chain.slice(0, idx)] : chain;
    for (const candidate of ordered) {
      if (candidate !== currentModel && isUsable(candidate)) {
        return candidate;
      }
    }
    return null;
  };

  const getOrInitSession = (
    sessionID: string,
    defaultAgent = "build",
    parentID?: string
  ): SessionTrack => {
    lastActiveSessionID = sessionID;
    let s = sessions.get(sessionID);
    if (!s) {
      const initialModel = resolveFirstHealthyModel(defaultAgent) ?? undefined;
      s = {
        epoch: 0,
        depth: 0,
        agent: defaultAgent,
        activeModel: initialModel,
        recovering: false,
        history: [],
        parentID,
        isSubagent: Boolean(parentID) || !config.primaryAgents[defaultAgent],
      };
      sessions.set(sessionID, s);
    } else {
      if (parentID && !s.parentID) {
        s.parentID = parentID;
        s.isSubagent = true;
      }
    }
    return s;
  };

  const hydrateSession = async (sessionID?: string): Promise<SessionTrack> => {
    const targetID = sessionID ?? lastActiveSessionID ?? "active-session";
    const s = getOrInitSession(targetID);
    if (sessionID) {
      try {
        const res = await client.session.messages({ path: { id: sessionID } });
        const msgs = Array.isArray(res.data) ? res.data : [];
        for (let i = msgs.length - 1; i >= 0; i--) {
          const info = (msgs[i] as any)?.info ?? msgs[i];
          if ((info?.type === "user" || info?.role === "user") && (info.text || info.payload?.text) && !s.lastUserText) {
            s.lastUserText = info.text || info.payload?.text;
            s.lastUserMessageID = info.id;
          }
          if (info?.agent) {
            s.agent = info.agent;
          }
          if (info?.model?.providerID && (info?.model?.modelID || info?.model?.id)) {
            const mid = info.model.modelID ?? info.model.id;
            const fullKey = `${info.model.providerID}/${mid}`;
            const lockedAgent = extractAgentFromSyntheticModel(fullKey);
            if (lockedAgent) {
              s.agent = lockedAgent;
              s.activeModel = resolveFirstHealthyModel(lockedAgent) ?? s.activeModel;
            } else {
              s.activeModel = fullKey;
            }
            break;
          }
        }
      } catch {}
    }
    if (!s.activeModel) {
      s.activeModel = resolveFirstHealthyModel(s.agent) ?? undefined;
    }
    return s;
  };

  const quarantineModel = (
    modelKey: string,
    reason: string,
    statusCode?: number,
    customDurationMs?: number,
    agentName?: string
  ) => {
    if (!modelKey || isSyntheticAgentModel(modelKey)) return;
    const policy = normalizeAgentPolicy(getConfig(), agentName);
    const now = Date.now();
    const prev = health.get(modelKey);
    const parsedQuota = parseQuotaAndRetryMs(reason);

    const baseDuration =
      customDurationMs ??
      parsedQuota.retryAfterMs ??
      policy.quarantineAfterFallbackMs;
    const { duration, state } = computeQuarantine(
      parsedQuota,
      statusCode,
      baseDuration,
      config.defaults
    );

    if (duration <= 0) return;

    health.set(modelKey, {
      state,
      until: duration === Number.POSITIVE_INFINITY ? Number.POSITIVE_INFINITY : now + duration,
      reason: reason.replace(/\s+/g, " ").slice(0, 160),
      statusCode,
      failures: (prev?.failures ?? 0) + 1,
      lastFailureAt: now,
    });
    persistHealthToDisk();
    log({
      event: "model.quarantined",
      agent: agentName,
      from: modelKey,
      statusCode,
      detail: `${state} for ${formatDuration(duration)} (${reason.slice(0, 80)})`,
    });
  };

  const hasMidTurnProgress = async (
    sessionID: string,
    agentName?: string,
    lastUserMessageID?: string
  ): Promise<boolean> => {
    const policy = normalizeAgentPolicy(getConfig(), agentName);
    if (policy.strategy === "continue") return true;
    if (policy.strategy === "revert") return false;
    try {
      const res = await client.session.messages({ path: { id: sessionID } });
      const msgs = Array.isArray(res.data) ? res.data : [];
      let afterUser = !lastUserMessageID;
      for (const m of msgs as any[]) {
        const id = m.info?.id ?? m.id;
        if (id === lastUserMessageID) {
          afterUser = true;
          continue;
        }
        if (afterUser && (m.info?.role === "assistant" || m.role === "assistant" || m.type === "assistant")) {
          const parts = m.parts ?? m.content ?? [];
          if (
            parts.some(
              (p: any) =>
                p.type === "tool" || p.type === "tool-invocation" || p.type === "patch"
            )
          ) {
            return true;
          }
        }
      }
    } catch {}
    return false;
  };

  const triggerFallback = async (
    sessionID: string,
    reason: string,
    statusCode?: number,
    attempt?: number
  ) => {
    const s = await hydrateSession(sessionID);
    if (s.recovering) return;

    const currentModel = s.activeModel ?? resolveFirstHealthyModel(s.agent);
    if (!currentModel) return;

    const policy = normalizeAgentPolicy(getConfig(), s.agent);
    const parsedQuota = parseQuotaAndRetryMs(reason);

    // Never defer fallback if the provider explicitly states daily/hard quota is exceeded
    if (
      !parsedQuota.isHardQuota &&
      typeof attempt === "number" &&
      attempt <= policy.retriesBeforeFallback
    ) {
      log({
        event: "retry.deferred",
        sessionID,
        agent: s.agent,
        from: currentModel,
        attempt,
        statusCode,
        detail: `Deferred ${attempt}/${policy.retriesBeforeFallback}`,
      });
      await toast(
        `⏳ [${s.agent}] Retry ${attempt}/${policy.retriesBeforeFallback} on ${currentModel}`,
        "info"
      );
      return;
    }

    s.recovering = true;
    const myEpoch = ++s.epoch;

    try {
      quarantineModel(currentModel, reason, statusCode, undefined, s.agent);

      const isSubagent = s.isSubagent || Boolean(s.parentID) || !config.primaryAgents[s.agent];

      if (s.depth >= config.defaults.maxFallbackDepth) {
        log({
          event: "fallback.exhausted.depth",
          sessionID,
          agent: s.agent,
          from: currentModel,
          detail: "Max depth reached",
        });
        await withTimeout(
          client.session.abort({ path: { sessionID, id: sessionID }, sessionID }),
          config.defaults.abortTimeoutMs,
          "abort"
        ).catch(() => {});
        await toast(`🛑 Max fallback depth (${s.depth}) reached. Session aborted.`, "error");
        return;
      }

      let nextModel = resolveFirstHealthyModel(s.agent, currentModel);
      while (nextModel) {
        const parsed = splitModelKey(nextModel);
        if (!parsed) break;

        s.depth += 1;
        s.activeModel = nextModel;
        const midTurn = await hasMidTurnProgress(sessionID, s.agent, s.lastUserMessageID);
        const strategyUsed = midTurn ? "continue" : "revert";

        s.history.push({
          at: new Date().toISOString().slice(11, 19),
          agent: s.agent,
          from: currentModel,
          to: nextModel,
          reason: statusCode ? `HTTP ${statusCode}` : reason.slice(0, 40),
          strategy: strategyUsed,
        });

        log({
          event: isSubagent ? "fallback.subagent.route" : "fallback.reactive",
          sessionID,
          agent: s.agent,
          from: currentModel,
          to: nextModel,
          statusCode,
          strategy: strategyUsed,
        });

        await toast(
          `🔀 [${isSubagent ? "Subagent: " : ""}${s.agent} ${s.depth}/${config.defaults.maxFallbackDepth}] ${currentModel.split("/").pop()} → ${nextModel.split("/").pop()} (${strategyUsed})`,
          "warning"
        );

        try {
          if (!isSubagent) {
            await withTimeout(
              client.session.abort({ path: { sessionID, id: sessionID }, sessionID }),
              config.defaults.abortTimeoutMs,
              "abort"
            ).catch(() => {});

            if (!midTurn && s.lastUserMessageID) {
              await withTimeout(
                client.session.revert({
                  path: { sessionID, id: sessionID },
                  sessionID,
                  body: { messageID: s.lastUserMessageID },
                  messageID: s.lastUserMessageID,
                }),
                config.defaults.revertTimeoutMs,
                "revert"
              ).catch(() => {});
            }
          }

          if (client.session?.switchModel) {
            await withTimeout(
              client.session.switchModel({
                path: { sessionID, id: sessionID },
                sessionID,
                body: { model: parsed },
                model: parsed,
              }),
              config.defaults.abortTimeoutMs,
              "switchModel"
            ).catch(() => {});
          }

          const replayText = midTurn
            ? `[System Fallback: Previous model (${currentModel}) failed mid-turn (${statusCode ? `HTTP ${statusCode}` : reason.slice(0, 100)}). Review completed tool outputs in this turn and continue where you left off without repeating completed steps.]`
            : s.lastUserText || "Continue.";

          await withTimeout(
            client.session.promptAsync({
              path: { sessionID, id: sessionID },
              sessionID,
              body: {
                ...(s.agent ? { agent: s.agent } : {}),
                agent: s.agent,
                model: parsed,
                text: replayText,
                parts: [{ type: "text", text: replayText }],
              },
            }),
            config.defaults.replayTimeoutMs,
            "promptAsync"
          );
          return;
        } catch (replayErr: any) {
          const errMsg = replayErr?.message || String(replayErr);
          log({
            event: "fallback.replay.failed",
            sessionID,
            agent: s.agent,
            target: nextModel,
            error: errMsg,
          });
          if (/(?:quota|rate.?limit|402|404|410|426|429|500|502|503|504|529)/i.test(errMsg)) {
            quarantineModel(
              nextModel,
              `Replay failed: ${errMsg}`,
              undefined,
              undefined,
              s.agent
            );
          }
          nextModel = resolveFirstHealthyModel(s.agent, nextModel);
        }
      }

      log({ event: "fallback.exhausted.chain", sessionID, agent: s.agent, from: currentModel });
      await withTimeout(
        client.session.abort({ path: { sessionID, id: sessionID }, sessionID }),
        config.defaults.abortTimeoutMs,
        "abort-exhausted"
      ).catch(() => {});
      await toast(`🛑 Fallback chain exhausted for agent "${s.agent}". Aborted.`, "error");
    } finally {
      if (s.epoch === myEpoch) {
        s.recovering = false;
      }
    }
  };

  const renderDashboard = async (sessionID?: string, subcmd = "status", arg?: string): Promise<string> => {
    syncHealthFromDisk();
    const s = await hydrateSession(sessionID);
    const now = Date.now();

    if (subcmd === "reset") {
      if (!arg || arg === "all") {
        health.clear();
        persistHealthToDisk();
        s.depth = 0;
        s.activeModel = resolveFirstHealthyModel(s.agent) ?? undefined;
        return `### ✅ Fallback State Reset\nCleared all model quarantines and reset session depth for agent \`${s.agent}\`.`;
      }
      health.delete(arg);
      persistHealthToDisk();
      return `### ✅ Model Cleared\nRemoved quarantine/cooldown for \`${arg}\`.`;
    }

    if (subcmd === "quarantine" && arg) {
      const [modelKey, secStr] = arg.split(/\s+/);
      const secs = Number(secStr) || 300;
      quarantineModel(modelKey, "Manual quarantine via /fb", undefined, secs * 1000, s.agent);
      s.activeModel = resolveFirstHealthyModel(s.agent) ?? undefined;
      return `### 🔒 Quarantined \`${modelKey}\` for ${secs}s\nNext active model for \`${s.agent}\`: \`${s.activeModel ?? "none"}\``;
    }

    if (subcmd === "tail") {
      const count = Math.min(Number(arg) || 15, 50);
      const recent = ringBuffer.slice(-count).reverse();
      if (!recent.length) return `### 📋 Fallback Event Log\n_No fallback events recorded yet._`;
      const rows = recent
        .map(
          (e) =>
            `| \`${e.ts.slice(11, 19)}\` | \`${e.agent ?? "-"}\` | \`${e.event}\` | \`${e.from ?? "-"}\` → \`${e.to ?? "-"}\` | ${e.strategy ?? "-"} | ${e.detail ?? (e.statusCode ? `HTTP ${e.statusCode}` : "-")} |`
        )
        .join("\n");
      return `### 📋 Recent Fallback Events (Last ${recent.length})\n| Time | Agent | Event | Transition | Strategy | Detail |\n| :--- | :--- | :--- | :--- | :--- | :--- |\n${rows}`;
    }

    const activePol = normalizeAgentPolicy(getConfig(), s.agent);
    const resolvedNow = s.activeModel ?? resolveFirstHealthyModel(s.agent) ?? "none";

    const agentRows = Object.keys(config.agents)
      .map((agentKey) => {
        const pol = normalizeAgentPolicy(getConfig(), agentKey);
        const modeLabel = config.primaryAgents[agentKey] ? "Primary" : "Subagent / Rule";
        const activeHead = resolveFirstHealthyModel(agentKey) ?? "_EXHAUSTED_";
        const marker = agentKey === s.agent ? "👉 " : "";
        return `| ${marker}\`${agentKey}\` | ${modeLabel} | \`${activeHead}\` | \`${pol.strategy}\` | \`${pol.retriesBeforeFallback}\` | ${pol.chain.map((m) => `\`${m.split("/").pop()}\``).join(" → ")} |`;
      })
      .join("\n");

    const allModels = new Set<string>();
    Object.keys(config.agents).forEach((a) =>
      normalizeAgentPolicy(getConfig(), a).chain.forEach((m) => allModels.add(m))
    );
    health.forEach((_, m) => allModels.add(m));

    const modelRows = [...allModels]
      .map((m) => {
        const h = health.get(m);
        if (!h || now >= h.until) {
          return `| \`${m}\` | 🟢 **Healthy** | — | ${h?.failures ?? 0} | — |`;
        }
        const rem = formatDuration(h.until - now);
        const icon =
          h.state === "retired"
            ? "⚫ **Retired**"
            : h.state === "quota_exhausted"
            ? "🔴 **Quota Exhausted**"
            : "🟠 **Quarantined**";
        return `| \`${m}\` | ${icon} | \`${rem}\` | ${h.failures} | ${h.reason} |`;
      })
      .join("\n");

    const sessionInfo = [
      `**Session:** \`${sessionID ?? lastActiveSessionID ?? "current"}\``,
      `**Active Agent:** \`${s.agent}\``,
      `**Resolved Model:** \`${resolvedNow}\``,
      `**Depth:** \`${s.depth}/${config.defaults.maxFallbackDepth}\``,
      `**Strategy:** \`${activePol.strategy}\``,
    ].join(" | ");

    return [
      `## 🛡️ Model Fallback & Agent Chain Status`,
      sessionInfo,
      ``,
      `### Configured Agent Chains`,
      `| Agent | Type | Next Healthy Model | Strategy | Retries | Chain |`,
      `| :--- | :--- | :--- | :--- | :--- | :--- |`,
      agentRows,
      ``,
      `### Global Model Health`,
      `| Model | Status | Remaining | Failures | Last Reason |`,
      `| :--- | :--- | :--- | :--- | :--- |`,
      modelRows || `| _None_ | — | — | — | — |`,
      ``,
      `> **Commands:** \`/fb status\` · \`/fb tail 20\` · \`/fb reset [all|model]\` · \`/fb quarantine <model> <secs>\``,
    ].join("\n");
  };

  return {
    config: async (cfg: any) => {
      if (!config.enabled) return;
      cfg.agent = cfg.agent ?? {};

      for (const [agentName, def] of Object.entries(config.primaryAgents)) {
        const headModel = resolveFirstHealthyModel(agentName);
        const existing = cfg.agent[agentName] ?? {};

        cfg.agent[agentName] = {
          ...existing,
          description: def.description ?? existing.description ?? `Primary agent: ${agentName}`,
          mode: "primary",
          hidden: false,
          ...(typeof def.temperature === "number" ? { temperature: def.temperature } : {}),
          ...(def.prompt ? { prompt: def.prompt } : {}),
          ...(def.tools ? { tools: { ...(existing.tools ?? {}), ...def.tools } } : {}),
          model: headModel ?? existing.model ?? undefined,
        };
      }
    },

    "chat.message": async (input: any, output: any) => {
      if (!config.enabled) return;
      const sessionID = input.sessionID;
      const requestedKey = input.model
        ? `${input.model.providerID}/${input.model.modelID}`
        : undefined;

      const syntheticAgent = extractAgentFromSyntheticModel(requestedKey);
      const activeAgent =
        input.agent ?? output?.message?.agent ?? syntheticAgent ?? "build";

      const s = getOrInitSession(sessionID, activeAgent);
      s.agent = activeAgent;
      s.lastUserMessageID = input.messageID ?? output?.message?.id;

      const textParts = (output?.parts ?? [])
        .filter((p: any) => p.type === "text" && typeof p.text === "string")
        .map((p: any) => p.text);
      if (textParts.length > 0) {
        s.lastUserText = textParts.join("\n");
        s.depth = 0;
      }

      const isLegacySynthetic = isSyntheticAgentModel(requestedKey);
      const policy = normalizeAgentPolicy(getConfig(), activeAgent);
      const isNotInChain = Boolean(
        requestedKey && policy.chain.length > 0 && !policy.chain.includes(requestedKey)
      );

      if (isLegacySynthetic || !requestedKey || !isUsable(requestedKey) || isNotInChain) {
        const target = resolveFirstHealthyModel(
          activeAgent,
          isLegacySynthetic || isNotInChain ? undefined : requestedKey
        );
        if (target) {
          const parsed = splitModelKey(target);
          if (parsed && output?.message) {
            output.message.model = parsed;
            if (input.model) {
              input.model.providerID = parsed.providerID;
              input.model.modelID = parsed.modelID;
            }
            s.activeModel = target;

            log({
              event: "agent.chain.route",
              sessionID,
              agent: activeAgent,
              from: requestedKey ?? target,
              to: target,
            });
            return;
          }
        }
      }

      if (requestedKey) {
        s.activeModel = requestedKey;
      }
    },

    event: async ({ event }: any) => {
      if (!config.enabled || !event) return;

      if (event.type === "session.created" || event.type === "session.updated") {
        const info = event.properties?.info;
        const sid = info?.id ?? event.properties?.sessionID;
        if (sid) {
          const s = getOrInitSession(sid, info?.agent ?? "build", info?.parentID);
          if (info?.parentID) {
            s.parentID = info.parentID;
            s.isSubagent = true;
          }
          if (info?.agent) s.agent = info.agent;

          const currentModel =
            s.activeModel ??
            (info?.model?.providerID && (info?.model?.modelID || info?.model?.id)
              ? `${info.model.providerID}/${info.model.modelID ?? info.model.id}`
              : resolveFirstHealthyModel(s.agent));
          if (currentModel && !isUsable(currentModel)) {
            const target = resolveFirstHealthyModel(s.agent, currentModel);
            if (target) {
              const parsed = splitModelKey(target);
              if (parsed) {
                s.activeModel = target;
                if (client?.session?.switchModel) {
                  await client.session
                    .switchModel({
                      path: { sessionID: sid, id: sid },
                      sessionID: sid,
                      body: { model: parsed },
                      model: parsed,
                    })
                    .catch(() => {});
                }
                log({
                  event: "session.create.route",
                  sessionID: sid,
                  agent: s.agent,
                  from: currentModel,
                  to: target,
                });
              }
            }
          }
        }
      }

      if (
        event.type === "session.status" ||
        event.type === "session.next.retried" ||
        event.type === "session.retry.scheduled"
      ) {
        const { sessionID, status } = event.properties ?? {};
        if (sessionID) getOrInitSession(sessionID);
        const attempt =
          typeof status?.attempt === "number"
            ? status.attempt
            : typeof event.properties?.attempt === "number"
            ? event.properties.attempt
            : undefined;
        const msg =
          status?.message ||
          event.properties?.error?.message ||
          event.properties?.message ||
          "Provider retry triggered";
        const codeMatch = msg.match(/\b(402|404|408|409|410|426|429|500|502|503|504|529)\b/);
        const statusCode = codeMatch ? Number(codeMatch[1]) : undefined;
        await triggerFallback(sessionID, msg, statusCode, attempt);
      }

      if (
        event.type === "session.error" ||
        event.type === "session.next.step.failed" ||
        event.type === "session.step.failed" ||
        event.type === "session.execution.failed" ||
        (event.type === "session.idle" && event.properties?.outcome === "failed")
      ) {
        const sid =
          event.properties?.sessionID ?? event.sessionID ?? event.data?.sessionID;
        if (!sid) return;
        const errObj =
          event.properties?.error ?? event.error ?? event.data?.error;
        const errName = errObj?.name || "";
        const errMsg =
          errObj?.data?.message ||
          errObj?.message ||
          (typeof errObj === "string" ? errObj : JSON.stringify(errObj || "Session failed"));
        if (/abort|cancel/i.test(errName) || /abort|cancel/i.test(errMsg)) return;

        const statusCode = errObj?.data?.statusCode ?? errObj?.statusCode;
        await triggerFallback(sid, errMsg, statusCode, undefined);
      }
    },

    "command.execute.before": async (input: any, output: any) => {
      if (input.command !== "fb" && input.command !== "fallback-status") return;
      const args = (input.arguments || "").trim().split(/\s+/).filter(Boolean);
      const subcmd = args[0] || "status";
      const rest = args.slice(1).join(" ");
      const report = await renderDashboard(input.sessionID, subcmd, rest);

      await toast(`Fallback (${subcmd}) updated`, "info");

      if (Array.isArray(output?.parts)) {
        output.parts.splice(0, output.parts.length, {
          type: "text",
          text: `Output the following Markdown report verbatim with no extra commentary:\n\n${report}`,
        });
      }
    },

    "session.generate": async (payload: any) => {
      if (!config.enabled || !payload?.model) return;
      const providerID = payload.model.providerID;
      const modelID = payload.model.id ?? payload.model.modelID;
      if (!providerID || !modelID) return;
      const currentKey = `${providerID}/${modelID}`;
      if (isUsable(currentKey)) return;

      const sid = payload.sessionID;
      const s = await hydrateSession(sid);
      const target = resolveFirstHealthyModel(s.agent, currentKey);
      if (!target) return;
      const parsed = splitModelKey(target);
      if (!parsed) return;

      payload.model.providerID = parsed.providerID;
      payload.model.id = parsed.modelID;
      if ("modelID" in payload.model) payload.model.modelID = parsed.modelID;
      s.activeModel = target;

      if (client?.session?.switchModel && sid) {
        await client.session
          .switchModel({
            path: { sessionID: sid, id: sid },
            sessionID: sid,
            body: { model: parsed },
            model: parsed,
          })
          .catch(() => {});
      }
      log({
        event: "agent.chain.route",
        sessionID: sid,
        agent: s.agent,
        from: currentKey,
        to: target,
      });
    },

    tool: {
      fallback_ctl: tool({
        description:
          "Inspect or control the OpenCode model fallback router and per-agent chains (status, tail, reset, quarantine).",
        args: {
          action: tool.schema.enum(["status", "tail", "reset", "quarantine"]).default("status"),
          target: tool.schema
            .string()
            .optional()
            .describe("Model key (provider/model), 'all', or count for tail"),
        },
        async execute(args, ctx) {
          return await renderDashboard(ctx.sessionID, args.action, args.target);
        },
      }),
    },
  };
};

export const plugin = {
  id: "model-fallback",
  setup: async (ctx: any) => {
    let hooks: any;
    try {
      hooks = await (plugin.server ?? SmartFallbackPlugin)(
        {
          client: {
            tui: ctx.client?.tui ?? { showToast: async () => ({}) },
            session: {
              messages: async (p: any) => {
                const sid = p.path?.sessionID ?? p.path?.id ?? p.sessionID;
                if (ctx.session?.context) {
                  const res = await ctx.session.context({ sessionID: sid }).catch(() => null);
                  if (res?.data) return res;
                  if (Array.isArray(res)) return { data: res };
                }
                if (ctx.client?.session?.messages) {
                  return await ctx.client.session.messages({ path: { sessionID: sid, id: sid } }).catch(() => ({ data: [] }));
                }
                if (ctx.client?.session?.message?.list) {
                  return await ctx.client.session.message.list({ path: { sessionID: sid } }).catch(() => ({ data: [] }));
                }
                return { data: [] };
              },
              abort: async (p: any) => {
                const sid = p.path?.sessionID ?? p.path?.id ?? p.sessionID;
                if (ctx.session?.interrupt) {
                  await ctx.session.interrupt({ sessionID: sid }).catch(() => {});
                }
                if (ctx.client?.session?.interrupt) {
                  await ctx.client.session.interrupt({ path: { sessionID: sid } }).catch(() => {});
                } else if (ctx.client?.session?.abort) {
                  await ctx.client.session.abort({ path: { sessionID: sid, id: sid } }).catch(() => {});
                }
              },
              revert: async (p: any) => {
                const sid = p.path?.sessionID ?? p.path?.id ?? p.sessionID;
                const messageID = p.body?.messageID ?? p.messageID;
                if (ctx.session?.revert) {
                  return await ctx.session.revert({ sessionID: sid, messageID }).catch(() => ({}));
                }
                if (ctx.client?.session?.revert?.stage) {
                  return await ctx.client.session.revert.stage({ path: { sessionID: sid }, body: { messageID } }).catch(() => ({}));
                }
                return {};
              },
              switchAgent: async (p: any) => {
                const sid = p.path?.sessionID ?? p.path?.id ?? p.sessionID;
                const agent = p.body?.agent ?? p.agent;
                if (ctx.session?.switchAgent && agent) {
                  await ctx.session.switchAgent({ sessionID: sid, agent }).catch(() => {});
                }
                if (ctx.client?.session?.switchAgent && agent) {
                  await ctx.client.session.switchAgent({ path: { sessionID: sid }, body: { agent } }).catch(() => {});
                }
              },
              switchModel: async (p: any) => {
                const sid = p.path?.sessionID ?? p.path?.id ?? p.sessionID;
                const m = p.body?.model ?? p.model;
                if (!m) return;
                const parsed = { providerID: m.providerID, id: m.id ?? m.modelID };
                if (ctx.session?.switchModel) {
                  await ctx.session.switchModel({ sessionID: sid, model: parsed }).catch(() => {});
                }
                if (ctx.client?.session?.switchModel) {
                  await ctx.client.session.switchModel({ path: { sessionID: sid }, body: { model: parsed } }).catch(() => {});
                }
              },
              promptAsync: async (p: any) => {
                const sid = p.path?.sessionID ?? p.path?.id ?? p.sessionID;
                const text =
                  p.body?.text ??
                  p.text ??
                  p.body?.parts?.find((part: any) => part.type === "text")?.text ??
                  "Continue.";
                const agent = p.body?.agent ?? p.agent;
                if (agent) {
                  if (ctx.session?.switchAgent) {
                    await ctx.session.switchAgent({ sessionID: sid, agent }).catch(() => {});
                  }
                  if (ctx.client?.session?.switchAgent) {
                    await ctx.client.session.switchAgent({ path: { sessionID: sid }, body: { agent } }).catch(() => {});
                  }
                }
                const m = p.body?.model ?? p.model;
                if (m) {
                  const parsed = { providerID: m.providerID, id: m.id ?? m.modelID };
                  if (ctx.session?.switchModel) {
                    await ctx.session.switchModel({ sessionID: sid, model: parsed }).catch(() => {});
                  }
                  if (ctx.client?.session?.switchModel) {
                    await ctx.client.session.switchModel({ path: { sessionID: sid }, body: { model: parsed } }).catch(() => {});
                  }
                }
                if (ctx.session?.prompt) {
                  return await ctx.session.prompt({ sessionID: sid, text });
                }
                if (ctx.client?.session?.prompt) {
                  return await ctx.client.session.prompt({ path: { sessionID: sid }, body: { text } });
                }
              },
            },
          } as any,
          project: (ctx.project ?? {}) as any,
          directory: ctx.directory ?? process.cwd(),
          worktree: ctx.worktree ?? process.cwd(),
          experimental_workspace: (ctx.experimental_workspace ?? {}) as any,
          serverUrl: ctx.serverUrl ?? new URL("http://localhost:4096"),
          $: ctx.$ ?? ({} as any),
        },
        ctx.options
      );
    } catch (e) {
      console.error("[model-fallback] Failed to initialize plugin:", e);
      return;
    }

    // Subscribe to OpenCode v2 event stream
    if (ctx.event?.subscribe && hooks.event) {
      (async () => {
        try {
          const stream = ctx.event.subscribe();
          if (stream && typeof stream[Symbol.asyncIterator] === "function") {
            for await (const event of stream) {
              try {
                await hooks.event?.({ event });
              } catch {}
            }
          }
        } catch {}
      })();
    }

    // Direct session retry hook
    if (ctx.session?.hook) {
      try {
        await ctx.session.hook("retry", async (payload: any) => {
          if (payload?.sessionID && payload?.error) {
            const errMsg = payload.error?.message || String(payload.error);
            const codeMatch = errMsg.match(/\b(402|404|408|409|410|426|429|500|502|503|504|529)\b/);
            const statusCode =
              payload.error?.statusCode ?? (codeMatch ? Number(codeMatch[1]) : undefined);
            await hooks.event?.({
              event: {
                type: "session.status",
                properties: {
                  sessionID: payload.sessionID,
                  status: {
                    type: "retry",
                    attempt: payload.attempt,
                    message: errMsg,
                  },
                },
              } as any,
            });
          }
        });
      } catch {}
    }

    // Preemptive generation hook: route away from quarantined models before model call
    if (ctx.session?.hook && hooks["session.generate"]) {
      try {
        await ctx.session.hook("generate", async (payload: any) => {
          await hooks["session.generate"](payload);
        });
      } catch {}
    }

    // Register /fb command
    if (ctx.command?.transform && hooks["command.execute.before"]) {
      try {
        await ctx.command.transform((editor: any) => {
          editor.add({
            name: "fb",
            description:
              "Inspect or control model fallback health (status | tail | reset | quarantine)",
            execute: async ({ sessionID, prompt }: any) => {
              const output: any = { parts: [] };
              await hooks["command.execute.before"]?.(
                {
                  command: "fb",
                  arguments: prompt?.text || "",
                  sessionID,
                },
                output
              );
              if (output.parts?.length && ctx.session?.prompt) {
                await ctx.session.prompt({
                  sessionID,
                  text: output.parts.map((p: any) => p.text).join("\n"),
                });
              }
            },
          });
        });
      } catch {}
    }

    // Register fallback_ctl tool with required name property
    if (ctx.tool?.transform && hooks.tool?.fallback_ctl) {
      try {
        await ctx.tool.transform((editor: any) => {
          editor.add({
            id: "fallback_ctl",
            name: "fallback_ctl",
            description:
              "Inspect or control the OpenCode model fallback router and per-agent chains (status, tail, reset, quarantine).",
            parameters: hooks.tool!.fallback_ctl.parameters,
            execute: (args: any, execCtx: any) =>
              hooks.tool!.fallback_ctl.execute(args, execCtx),
          });
        });
      } catch {}
    }
  },
  server: SmartFallbackPlugin,
};

export default plugin;


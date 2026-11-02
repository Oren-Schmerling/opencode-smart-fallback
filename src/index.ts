import { Plugin } from "@opencode/plugin";
import { calculateCooldownTtl, isRetryableError } from "./errors.js";
import { formatModel, parseModel } from "./models.js";
import { FallbackRouter } from "./router.js";
import { CooldownStore } from "./store.js";
import type { SmartFallbackOptions } from "./types.js";

export * from "./types.js";
export { FallbackRouter } from "./router.js";
export { CooldownStore } from "./store.js";
export { parseModel, formatModel, normalizeChain } from "./models.js";
export { isRetryableError, calculateCooldownTtl } from "./errors.js";

export function createSmartFallbackRouter(ctx: any, rawOptions?: SmartFallbackOptions) {
  const options = (rawOptions ?? (ctx.options as SmartFallbackOptions) ?? {}) as SmartFallbackOptions;
  const store = new CooldownStore(ctx.storage);
  const router = new FallbackRouter(options);
  const retryingSessions = new Set<string>();

  function notify(title: string, message: string) {
    if (options.notify_on_fallback !== false) {
      console.warn(`[smart-fallback] ${title}: ${message}`);
    }
  }

  // Hook 1: Preemptive Prompt Routing
  async function prompt(event: any) {
    const sessionID = event?.sessionID;
    if (!sessionID) return;

    const session = await ctx.session.get({ sessionID }).catch(() => undefined);
    const agentName = session?.agent;
    const currentModelStr = formatModel(session?.model);
    if (!currentModelStr) return;

    if (agentName) router.sessionAgent.set(sessionID, agentName);

    if (!router.sessionPrimaryHead.has(sessionID)) {
      const head = router.reverseModelToHead[currentModelStr] || currentModelStr;
      if (router.chains[head]) {
        router.sessionPrimaryHead.set(sessionID, head);
      }
    }

    const chain = router.getActiveChain(sessionID, agentName, currentModelStr);
    if (!chain || chain.length === 0) return;

    const targetModel = await router.resolveHealthyModel(chain, store);
    if (!targetModel || targetModel === currentModelStr) return;

    const targetRef = parseModel(targetModel);
    if (!targetRef) return;

    await ctx.session.switchModel({
      sessionID,
      model: targetRef,
    });

    const previousTarget = router.sessionActiveTarget.get(sessionID);
    router.sessionActiveTarget.set(sessionID, targetModel);

    const isRecovery =
      targetModel === router.chains[router.sessionPrimaryHead.get(sessionID) ?? ""]?.[0] ||
      targetModel === router.agents[agentName ?? ""]?.[0];

    notify(
      isRecovery ? "Model Recovered" : "Model Fallback",
      previousTarget
        ? `${previousTarget} -> ${targetModel}`
        : `Using ${targetModel} instead of ${currentModelStr}`
    );
  }

  // Hook 2: Subagent Admission
  async function executeBefore(event: any) {
    if (event.tool !== "subagent" && event.tool !== "task") return;
    const input = event.input as Record<string, any> | undefined;
    if (!input || typeof input !== "object") return;

    const subagentType = input.subagent_type || input.agent;
    let chain: string[] | undefined;

    if (subagentType && router.agents[subagentType]) {
      chain = router.agents[subagentType];
    } else if (input.model) {
      const modelStr = typeof input.model === "string" ? input.model : formatModel(input.model);
      if (modelStr) {
        chain = router.getActiveChain(undefined, undefined, modelStr);
      }
    }

    if (chain && chain.length > 0) {
      const healthyModel = await router.resolveHealthyModel(chain, store);
      if (healthyModel) {
        if (typeof input.model === "object" && input.model !== null) {
          const parsed = parseModel(healthyModel);
          if (parsed) input.model = parsed;
        } else {
          input.model = healthyModel;
        }
      }
    }
  }

  // Hook 3: OpenRouter In-Flight Safety Net
  async function context(event: any) {
    if (event.model?.providerID !== "openrouter") return;
    const currentModelStr = formatModel(event.model);
    if (!currentModelStr) return;

    const chain = router.getActiveChain(event.sessionID, event.agent, currentModelStr);
    if (!chain || chain.length === 0) return;

    const backups = await router.findOpenRouterBackups(chain, currentModelStr, store);
    if (backups.length > 0) {
      event.options = {
        ...event.options,
        models: backups,
      };
    }
  }

  // Hook 4: In-Fiber Reactive Failover
  async function retry(event: any) {
    const sessionID = event.sessionID;
    if (!sessionID || retryingSessions.has(sessionID)) return;
    if (!isRetryableError(event.error, options)) return;

    const failedModelStr = formatModel(event.model);
    if (!failedModelStr) return;

    const { ttlSeconds, reason } = calculateCooldownTtl(event.error, options);
    const now = Date.now();
    await store.setCooldown(failedModelStr, reason, now + ttlSeconds * 1000);

    const chain = router.getActiveChain(sessionID, event.agent, failedModelStr);
    if (!chain || chain.length === 0) return;

    const nextModelStr = await router.findNextRetryModel(chain, failedModelStr, store, now);
    if (!nextModelStr || nextModelStr === failedModelStr) {
      notify("Waterfall Exhausted", `No healthy fallback models left for chain [${chain.join(" -> ")}]`);
      return;
    }

    const nextRef = parseModel(nextModelStr);
    if (!nextRef) return;

    retryingSessions.add(sessionID);
    try {
      await ctx.session.switchModel({
        sessionID,
        model: nextRef,
      });
      router.sessionActiveTarget.set(sessionID, nextModelStr);
      event.decision = { retry: true, delay: 0 };
      notify("Failover Activated", `${failedModelStr} -> ${nextModelStr} (${reason}) [in-fiber retry]`);
    } finally {
      retryingSessions.delete(sessionID);
    }
  }

  // Transparency Command: /fb
  async function setupCommand() {
    if (!ctx.command?.transform) return;
    await ctx.command.transform((editor: any) => {
      editor.add({
        name: "fb",
        description: "Display model fallback waterfall chains and active cooldown timers",
        execute: async ({ sessionID }: { sessionID: string }) => {
          const session = sessionID ? await ctx.session.get({ sessionID }).catch(() => undefined) : undefined;
          const currentModel = formatModel(session?.model);
          const report = await router.formatStatusReport(store, sessionID, currentModel);
          await ctx.session.synthetic({ sessionID, text: report });
        },
      });
    });
  }

  async function setup() {
    await store.load();
    await setupCommand();

    const promptHook = ctx.session?.hook ? await ctx.session.hook("prompt", prompt) : undefined;
    const toolHook = ctx.tool?.hook ? await ctx.tool.hook("execute.before", executeBefore) : undefined;
    const contextHook = ctx.session?.hook ? await ctx.session.hook("context", context) : undefined;
    const retryHook = ctx.session?.hook ? await ctx.session.hook("retry", retry) : undefined;

    const controller = new AbortController();
    const eventLoop = (async () => {
      try {
        if (ctx.event?.subscribe) {
          for await (const e of ctx.event.subscribe({
            signal: controller.signal,
            types: ["session.deleted"],
          })) {
            const sid = e?.data?.sessionID;
            if (sid) {
              router.cleanupSession(sid);
              retryingSessions.delete(sid);
            }
          }
        }
      } catch {
        // Ignored on abort
      }
    })();

    return async () => {
      controller.abort();
      await eventLoop.catch(() => {});
      await promptHook?.dispose?.();
      await toolHook?.dispose?.();
      await contextHook?.dispose?.();
      await retryHook?.dispose?.();
    };
  }

  return {
    name: "opencode-smart-fallback",
    store,
    router,
    prompt,
    executeBefore,
    context,
    retry,
    setup,
  };
}

export default Plugin.define({
  id: "smart-fallback",
  async setup(ctx) {
    const router = createSmartFallbackRouter(ctx);
    return router.setup();
  },
});

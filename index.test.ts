import { describe, expect, test } from "bun:test";
import {
  MODEL_KEY_REGEX,
  LOCKED_MODEL_PREFIX,
  parseQuotaAndRetryMs,
  computeQuarantine,
  normalizeAgentPolicy,
  loadConfig,
  SmartFallbackPlugin,
} from "./index";

describe("Model Fallback Router Plugin", () => {
  test("accepts relaxed model keys", () => {
    expect(MODEL_KEY_REGEX.test("openrouter/~deepseek/deepseek-flash-latest")).toBe(true);
    expect(MODEL_KEY_REGEX.test("google/gemini-3.8-flash")).toBe(true);
  });

  test("parseQuotaAndRetryMs accurately parses quota error and retry duration", () => {
    const errorMsg =
      "Quota exceeded for metric: generativelanguage.googleapis.com/generate_content_free_tier_requests, limit: 20, model: gemini-3.8-flash ... Please retry in 5h31m1.955150363s.";
    const result = parseQuotaAndRetryMs(errorMsg);
    expect(result.isHardQuota).toBe(true);
    expect(result.retryAfterMs).toBeDefined();
    // 5h 31m 1.955s -> 5 * 3600 + 31 * 60 + 1.955150363 = 19861.95515s = ~19861956 ms
    expect(result.retryAfterMs).toBe(19861956);
  });

  test("parseQuotaAndRetryMs treats per-minute token quota as a transient rate limit", () => {
    const errorMsg =
      "You exceeded your current quota, please check your plan and billing details. For more information on this error, head to: https://ai.google.dev/gemini-api/docs/rate-limits. \n* Quota exceeded for metric: generativelanguage.googleapis.com/generate_content_free_tier_input_token_count, limit: 250000, model: gemini-3.5-flash-lite, description: Generate content input tokens per minute limit exceeded on Free Tier. \nPlease retry in 10.099206206s.";
    const result = parseQuotaAndRetryMs(errorMsg);
    expect(result.isHardQuota).toBe(false);
    expect(result.isRateLimit).toBe(true);
    expect(result.retryAfterMs).toBe(10100);
  });

  test("computeQuarantine enforces a minimum cooldown for per-minute rate limits", () => {
    const parsed = parseQuotaAndRetryMs(
      "Generate content input tokens per minute limit exceeded on Free Tier. Please retry in 2.5s."
    );
    const { duration, state } = computeQuarantine(parsed, undefined, parsed.retryAfterMs!, {
      cooldownMs: 60_000,
      quotaCooldownMs: 1_800_000,
    });
    // A 2.5s provider hint must not un-quarantine the model before the next subagent.
    expect(duration).toBe(60_000);
    expect(state).toBe("cooldown");
  });

  test("computeQuarantine enforces the quota cooldown for hard quotas even with a short retry hint", () => {
    const parsed = parseQuotaAndRetryMs(
      "You exceeded your current quota, please check your plan and billing details. Please retry in 2s."
    );
    const { duration, state } = computeQuarantine(parsed, undefined, parsed.retryAfterMs!, {
      cooldownMs: 60_000,
      quotaCooldownMs: 1_800_000,
    });
    expect(duration).toBe(1_800_000);
    expect(state).toBe("quota_exhausted");
  });

  test("computeQuarantine honors a long provider retry-after over the quota cooldown", () => {
    const parsed = parseQuotaAndRetryMs(
      "Quota exceeded for metric: generativelanguage.googleapis.com/generate_content_free_tier_requests, limit: 20. Please retry in 5h31m1.955150363s."
    );
    const { duration, state } = computeQuarantine(parsed, undefined, parsed.retryAfterMs!, {
      cooldownMs: 60_000,
      quotaCooldownMs: 1_800_000,
    });
    expect(duration).toBe(19_861_956);
    expect(state).toBe("quota_exhausted");
  });

  test("computeQuarantine uses the fallback quarantine for unknown errors with no timer", () => {
    const parsed = parseQuotaAndRetryMs("Service unavailable, please try again later.");
    expect(parsed.retryAfterMs).toBeUndefined();
    const { duration, state } = computeQuarantine(parsed, undefined, 14_400_000, {
      cooldownMs: 60_000,
      quotaCooldownMs: 14_400_000,
    });
    expect(duration).toBe(14_400_000);
    expect(state).toBe("quarantined");
  });

  test("computeQuarantine treats HTTP 426 Upgrade Required as a long quota block", () => {
    const parsed = parseQuotaAndRetryMs("Upgrade Required");
    const { duration, state } = computeQuarantine(parsed, 426, 120_000, {
      cooldownMs: 60_000,
      quotaCooldownMs: 14_400_000,
    });
    expect(duration).toBe(14_400_000);
    expect(state).toBe("quota_exhausted");
  });

  test("/fb command always shows hydrated active session state even before first chat message", async () => {
    const hooks = await SmartFallbackPlugin({
      client: {
        tui: { showToast: async () => ({}) },
        session: {
          messages: async () => ({ data: [] }),
          abort: async () => ({}),
          revert: async () => ({}),
          promptAsync: async () => ({}),
        },
      } as any,
      project: {} as any,
      directory: process.cwd(),
      worktree: process.cwd(),
      $: {} as any,
    });

    const cmdOut: any = { parts: [{ type: "text", text: "" }] };
    await hooks["command.execute.before"]!(
      { command: "fb", arguments: "status", sessionID: "fresh-session-1" } as any,
      cmdOut
    );

    expect(cmdOut.parts[0].text).toContain("Active Agent:");
    expect(cmdOut.parts[0].text).toContain("Resolved Model:");
    expect(cmdOut.parts[0].text).not.toContain("No active fallback state for current session");
  });

  test("config sets true active model for primary agents pointing directly at head of fallback chain", async () => {
    const hooks = await SmartFallbackPlugin(
      {
        client: {
          tui: { showToast: async () => ({}) },
          session: {
            messages: async () => ({ data: [] }),
            abort: async () => ({}),
            revert: async () => ({}),
            promptAsync: async () => ({}),
          },
        } as any,
        project: {} as any,
        directory: process.cwd(),
        worktree: process.cwd(),
        $: {} as any,
      },
      {
        agents: {
          plan: { chain: ["openrouter/anthropic/claude-sonnet-5.5"] },
        },
      }
    );

    const openCodeCfg: any = { agent: {}, provider: { google: { models: {} } } };
    await hooks.config!(openCodeCfg);

    expect(openCodeCfg.agent.plan.mode).toBe("primary");
    expect(openCodeCfg.agent.plan.model).toBe("openrouter/anthropic/claude-sonnet-5.5");
    expect(openCodeCfg.provider.google.models[`${LOCKED_MODEL_PREFIX}plan`]).toBeUndefined();

    const output: any = {
      message: {
        id: "msg-1",
        agent: "plan",
        model: { providerID: "openrouter", modelID: "anthropic/claude-sonnet-5.5" },
      },
      parts: [{ type: "text", text: "Hello" }],
    };
    await hooks["chat.message"]!(
      {
        sessionID: "sess-1",
        agent: "plan",
        messageID: "msg-1",
        model: { providerID: "openrouter", modelID: "anthropic/claude-sonnet-5.5" },
      } as any,
      output
    );

    expect(output.message.model).toEqual({
      providerID: "openrouter",
      modelID: "anthropic/claude-sonnet-5.5",
    });
  });

  test("parseQuotaAndRetryMs treats timeout as hard failure requiring quota cooldown", () => {
    const parsed = parseQuotaAndRetryMs("Timed out waiting for response headers");
    expect(parsed.isHardQuota).toBe(true);
  });

  test("plugin default export satisfies OpenCode v2 schema with id and setup", async () => {
    const { default: defaultExport, plugin } = await import("./index");
    expect(defaultExport).toBeDefined();
    expect(defaultExport.id).toBe("model-fallback");
    expect(typeof defaultExport.setup).toBe("function");
    expect(typeof defaultExport.server).toBe("function");
    expect(plugin).toBe(defaultExport);

    let promptArgs: any;
    let switchedAgent: any;
    let switchedModel: any;

    // Verify setup runs without errors when given a v2 ctx
    const mockCtx: any = {
      session: {
        context: async () => ({
          data: [
            { id: "msg-1", type: "user", text: "Hello from user" },
            { id: "msg-2", type: "agent-switched", agent: "build" },
          ],
        }),
        prompt: async (args: any) => {
          promptArgs = args;
          return { data: { id: "msg-3" } };
        },
        switchAgent: async (args: any) => {
          switchedAgent = args;
        },
        switchModel: async (args: any) => {
          switchedModel = args;
        },
        hook: async () => {},
      },
      event: { subscribe: () => [] },
      command: { transform: async (fn: any) => fn({ add: () => {} }) },
      tool: { transform: async (fn: any) => fn({ add: () => {} }) },
    };

    let serverSetup: any;
    const origServer = defaultExport.server;
    (defaultExport as any).server = async (ctx: any, opts: any) => {
      serverSetup = ctx;
      return origServer(ctx, opts);
    };

    await defaultExport.setup(mockCtx);
    expect(serverSetup).toBeDefined();

    // Call promptAsync through the shim
    await serverSetup.client.session.promptAsync({
      path: { id: "sess-v2-1" },
      body: {
        agent: "build",
        model: { providerID: "openrouter", modelID: "deepseek/deepseek-flash" },
        parts: [{ type: "text", text: "Retry prompt" }],
      },
    });

    expect(switchedAgent).toEqual({ sessionID: "sess-v2-1", agent: "build" });
    expect(switchedModel).toEqual({
      sessionID: "sess-v2-1",
      model: { providerID: "openrouter", id: "deepseek/deepseek-flash" },
    });
    // Prompt must NOT include agents array with raw strings (avoids Expected Prompt.AgentAttachment)
    expect(promptArgs).toEqual({ sessionID: "sess-v2-1", text: "Retry prompt" });

    // Restore server
    (defaultExport as any).server = origServer;
  });

  test("subagent session falls back to next model and replays prompt on quota error", async () => {
    let switchedModel: any;
    let prompted: any;

    const hooks = await SmartFallbackPlugin(
      {
        client: {
          tui: { showToast: async () => ({}) },
          session: {
            messages: async () => ({
              data: [
                {
                  id: "msg-user",
                  type: "user",
                  text: "Inspect the repo and run checks",
                },
                {
                  id: "msg-assistant",
                  type: "assistant",
                  agent: "scout",
                  model: { providerID: "google", id: "gemini-flash-lite-latest" },
                  finish: "error",
                },
              ],
            }),
            abort: async () => ({}),
            revert: async () => ({}),
            switchModel: async (args: any) => {
              switchedModel = args;
            },
            promptAsync: async (args: any) => {
              prompted = args;
            },
          },
        } as any,
        project: {} as any,
        directory: process.cwd(),
        worktree: process.cwd(),
        $: {} as any,
      },
      {
        agents: {
          scout: {
            strategy: "continue",
            retriesBeforeFallback: 0,
            chain: [
              "google/gemini-flash-lite-latest",
              "openrouter/openrouter/free",
            ],
          },
        },
      }
    );

    // Register subagent session
    await hooks.event!({
      event: {
        type: "session.created",
        properties: {
          info: {
            id: "sub-ses-1",
            agent: "scout",
            parentID: "parent-build-ses",
          },
        },
      },
    });

    // Subagent step fails with Gemini free tier quota limit
    await hooks.event!({
      event: {
        type: "session.error",
        properties: {
          sessionID: "sub-ses-1",
          error: {
            name: "AI.Error.QuotaExceeded",
            message:
              "Generate content requests per minute limit exceeded on Free Tier. Please retry in 31s.",
            statusCode: 429,
          },
        },
      },
    });

    // Subagent should NOT be abandoned with an early return; it must switch to openrouter/free and prompt
    expect(switchedModel).toBeDefined();
    expect(switchedModel.body?.model ?? switchedModel.model).toEqual(
      expect.objectContaining({
        providerID: "openrouter",
        id: "openrouter/free",
        modelID: "openrouter/free",
      })
    );
    expect(prompted).toBeDefined();
    expect(prompted.sessionID).toBe("sub-ses-1");
  });
});

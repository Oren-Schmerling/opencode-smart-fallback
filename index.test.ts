import { describe, expect, test } from "bun:test";
import {
  MODEL_KEY_REGEX,
  LOCKED_MODEL_PREFIX,
  parseQuotaAndRetryMs,
  normalizeAgentPolicy,
  loadConfig,
  SmartFallbackPlugin,
} from "./index";

describe("Model Fallback & Primary Agent Lock Plugin", () => {
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

  test("config and chat.message rewrite google/agent-lock-plan to the first healthy model in plan's chain", async () => {
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

    const openCodeCfg: any = { agent: {}, provider: { google: { models: {} } } };
    await hooks.config!(openCodeCfg);

    expect(openCodeCfg.agent.plan.mode).toBe("primary");
    expect(openCodeCfg.agent.plan.model).toBe(`google/${LOCKED_MODEL_PREFIX}plan`);
    expect(openCodeCfg.provider.google.models[`${LOCKED_MODEL_PREFIX}plan`].name).toBe("🔒 Agent: plan");

    const output: any = {
      message: {
        id: "msg-1",
        agent: "plan",
        model: { providerID: "google", modelID: `${LOCKED_MODEL_PREFIX}plan` },
      },
      parts: [{ type: "text", text: "Hello" }],
    };
    await hooks["chat.message"]!(
      {
        sessionID: "sess-1",
        agent: "plan",
        messageID: "msg-1",
        model: { providerID: "google", modelID: `${LOCKED_MODEL_PREFIX}plan` },
      } as any,
      output
    );

    expect(output.message.model).toEqual({
      providerID: "openrouter",
      modelID: "~deepseek/deepseek-flash-latest",
    });
  });
});

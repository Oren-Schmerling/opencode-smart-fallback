import { describe, expect, it } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import {
  calculateCooldownTtl,
  createSmartFallbackRouter,
  extractRetryAfter,
  isQuotaExhausted,
  isRetryableError,
} from "../src/index.js";

function createMockContext(
  initialModel = { providerID: "google", id: "gemini-2.5-flash" },
  initialAgent?: string
) {
  const storageMap = new Map<string, any>();
  const sessionHooks: Record<string, Function> = {};
  const toolHooks: Record<string, Function> = {};
  let currentModel = { ...initialModel };
  let currentAgent = initialAgent;
  const synthetics: string[] = [];
  const commands: any[] = [];

  const ctx = {
    options: {},
    storage: {
      get: async (k: string) => storageMap.get(k),
      set: async (k: string, v: any) => {
        storageMap.set(k, v);
      },
      remove: async (k: string) => {
        storageMap.delete(k);
      },
    },
    session: {
      get: async ({ sessionID }: { sessionID: string }) => ({
        id: sessionID,
        agent: currentAgent,
        model: currentModel,
      }),
      switchModel: async ({ sessionID, model }: { sessionID: string; model: any }) => {
        currentModel = { ...model };
      },
      synthetic: async ({ sessionID, text }: { sessionID: string; text: string }) => {
        synthetics.push(text);
      },
      hook: async (name: string, handler: Function) => {
        sessionHooks[name] = handler;
        return { dispose: () => delete sessionHooks[name] };
      },
    },
    tool: {
      hook: async (name: string, handler: Function) => {
        toolHooks[name] = handler;
        return { dispose: () => delete toolHooks[name] };
      },
    },
    command: {
      transform: async (cb: (editor: any) => void) => {
        cb({
          add: (def: any) => commands.push(def),
        });
      },
    },
    getCurrentModel: () => currentModel,
    setCurrentModel: (m: any) => {
      currentModel = { ...m };
    },
    setCurrentAgent: (a: string | undefined) => {
      currentAgent = a;
    },
    getSessionHooks: () => sessionHooks,
    getToolHooks: () => toolHooks,
    getSynthetics: () => synthetics,
    getCommands: () => commands,
  };

  return ctx;
}

describe("OpenCode Smart Fallback V2", () => {
  it("verifies multi-hop waterfall progression with in-fiber retry (delay: 0)", async () => {
    const ctx = createMockContext({ providerID: "google", id: "gemini-2.5-flash" });
    const instance = createSmartFallbackRouter(ctx, {
      chains: {
        "google/gemini-2.5-flash": [
          "groq/llama-3.3-70b",
          "anthropic/claude-3-5-sonnet",
        ],
      },
      notify_on_fallback: false,
    });
    await instance.setup();

    // Hop 1: Primary Model A fails with 429
    const retryEvent1: any = {
      sessionID: "sess-1",
      agent: undefined,
      model: { providerID: "google", id: "gemini-2.5-flash" },
      error: { status: 429, message: "Too many requests" },
      attempt: 1,
      decision: { retry: false },
    };
    await instance.retry(retryEvent1);

    expect(retryEvent1.decision).toEqual({ retry: true, delay: 0 });
    expect(ctx.getCurrentModel()).toEqual({ providerID: "groq", id: "llama-3.3-70b" });

    // Hop 2: Model B fails with 402 Quota
    const retryEvent2: any = {
      sessionID: "sess-1",
      agent: undefined,
      model: { providerID: "groq", id: "llama-3.3-70b" },
      error: { status: 402, message: "insufficient_quota" },
      attempt: 2,
      decision: { retry: false },
    };
    await instance.retry(retryEvent2);

    expect(retryEvent2.decision).toEqual({ retry: true, delay: 0 });
    expect(ctx.getCurrentModel()).toEqual({ providerID: "anthropic", id: "claude-3-5-sonnet" });
  });

  it("classifies tiered cooldowns: 60s RPM vs 4h quota vs Retry-After header", () => {
    const opts = {};

    // Standard RPM 429
    const rpm = calculateCooldownTtl({ status: 429 }, opts);
    expect(rpm.ttlSeconds).toBe(60);

    // 402 status
    const payment = calculateCooldownTtl({ status: 402 }, opts);
    expect(payment.ttlSeconds).toBe(14400);

    // Quota patterns
    const freeTier = calculateCooldownTtl({ message: "free_tier_requests exceeded" }, opts);
    expect(freeTier.ttlSeconds).toBe(14400);

    const limitErr = calculateCooldownTtl({ message: "FreeUsageLimitError: daily limit reached" }, opts);
    expect(limitErr.ttlSeconds).toBe(14400);

    // Retry-After header
    const retryAfter = calculateCooldownTtl(
      { status: 429, headers: { "retry-after": "75" } },
      opts
    );
    expect(retryAfter.ttlSeconds).toBe(75);
    expect(retryAfter.reason).toContain("75s");

    // Retry-After property
    const directProp = calculateCooldownTtl({ status: 429, retryAfter: 90 }, opts);
    expect(directProp.ttlSeconds).toBe(90);
  });

  it("automatically recovers back to Model A on prompt hook once cooldown expires", async () => {
    const ctx = createMockContext({ providerID: "groq", id: "llama-3.3-70b" });
    const instance = createSmartFallbackRouter(ctx, {
      chains: {
        "google/gemini-2.5-flash": ["groq/llama-3.3-70b"],
      },
      notify_on_fallback: false,
    });
    await instance.setup();

    // Mark Model A with a cooldown that expires in 100ms
    const now = Date.now();
    await instance.store.setCooldown("google/gemini-2.5-flash", "test", now + 100);

    // Prompt before cooldown expires: should stay on Model B
    await instance.prompt({ sessionID: "session-rec" });
    expect(ctx.getCurrentModel()).toEqual({ providerID: "groq", id: "llama-3.3-70b" });

    // Wait 120ms for cooldown to expire
    await new Promise((resolve) => setTimeout(resolve, 120));

    // Prompt after cooldown expires: recovers to Model A!
    await instance.prompt({ sessionID: "session-rec" });
    expect(ctx.getCurrentModel()).toEqual({ providerID: "google", id: "gemini-2.5-flash" });
  });

  it("rewrites subagent models on execute.before and caps OpenRouter backups to 3", async () => {
    const ctx = createMockContext({ providerID: "openrouter", id: "primary" });
    const instance = createSmartFallbackRouter(ctx, {
      agents: {
        scout: ["google/gemini-2.5-flash", "groq/llama-3.3-70b"],
      },
      chains: {
        "openrouter/primary": [
          "openrouter/backup-1",
          "openrouter/backup-2",
          "openrouter/backup-3",
          "openrouter/backup-4",
        ],
      },
      notify_on_fallback: false,
    });
    await instance.setup();

    // Subagent admission rewrite
    const toolEvent: any = {
      tool: "subagent",
      input: {
        subagent_type: "scout",
        model: "arbitrary/model",
      },
    };
    await instance.executeBefore(toolEvent);
    expect(toolEvent.input.model).toBe("google/gemini-2.5-flash");

    // When primary scout model cools down, subagent gets healthy fallback
    await instance.store.setCooldown("google/gemini-2.5-flash", "test", Date.now() + 10000);
    const toolEvent2: any = {
      tool: "subagent",
      input: {
        agent: "scout",
        model: "arbitrary/model",
      },
    };
    await instance.executeBefore(toolEvent2);
    expect(toolEvent2.input.model).toBe("groq/llama-3.3-70b");

    // OpenRouter in-flight safety net (context hook)
    const contextEvent: any = {
      sessionID: "sess-or",
      model: { providerID: "openrouter", id: "primary" },
      options: {},
    };
    await instance.context(contextEvent);
    expect(contextEvent.options.models).toBeDefined();
    // OpenRouter enforces strict 3-backup limit
    expect(contextEvent.options.models).toEqual(["backup-1", "backup-2", "backup-3"]);
  });

  it("handles /fb command and displays transparency markdown report", async () => {
    const ctx = createMockContext({ providerID: "google", id: "gemini-2.5-flash" });
    const instance = createSmartFallbackRouter(ctx, {
      chains: {
        "google/gemini-2.5-flash": ["groq/llama-3.3-70b"],
      },
      notify_on_fallback: false,
    });
    await instance.setup();

    const cmd = ctx.getCommands().find((c) => c.name === "fb");
    expect(cmd).toBeDefined();

    await cmd.execute({ sessionID: "s-cmd" });
    const output = ctx.getSynthetics();
    expect(output.length).toBeGreaterThan(0);
    expect(output[0]).toContain("Smart Fallback Status");
    expect(output[0]).toContain("google/gemini-2.5-flash");
  });

  it("enforces strict under 350 lines per file for all source files", () => {
    const srcDir = join(__dirname, "../src");
    const files = readdirSync(srcDir).filter((f) => f.endsWith(".ts"));

    expect(files.length).toBeGreaterThanOrEqual(4);
    for (const file of files) {
      const content = readFileSync(join(srcDir, file), "utf-8");
      const lineCount = content.split("\n").length;
      expect(lineCount).toBeLessThanOrEqual(350);
    }
  });
});

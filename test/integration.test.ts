import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import csmPlugin from "../src/index.js";

// Integration test: drives the REAL src/index.ts hook wiring, the part no unit test imports. The
// three openclaw/plugin-sdk subpaths are aliased to local stubs (vitest.config.ts), so this needs no
// built clone. The fake llm.complete throws if it ever receives agentId/model, which is exactly what
// the host facade does: a re-add at the real call fails the propagation check.

type Hook = (
  event: Record<string, unknown>,
  ctx: Record<string, unknown>,
) => { prependSystemContext?: string } | undefined;

const plugin = csmPlugin as unknown as { register(api: unknown): void };

function makeApi(ownerAllowFrom: Array<string | number>, pluginConfig: Record<string, unknown> = {}) {
  const calls: Array<Record<string, unknown>> = [];
  const hooks = new Map<string, Hook>();
  const api = {
    pluginConfig,
    logger: { warn: () => {}, debug: () => {} },
    runtime: {
      config: { current: () => ({ commands: { ownerAllowFrom } }) },
      llm: {
        complete: async (params: Record<string, unknown>) => {
          calls.push(params);
          if ("agentId" in params || "model" in params) {
            throw new Error("Plugin LLM completion cannot override the target agent/model.");
          }
          const messages = params.messages as Array<{ content?: unknown }> | undefined;
          const content = String(messages?.[0]?.content ?? "");
          return content.includes("blue")
            ? { text: JSON.stringify([{ fact_key: "favorite_color", value: "blue", importance: 0.7, op: "ADD" }]) }
            : { text: "[]" };
        },
      },
    },
    on: (name: string, handler: Hook) => {
      hooks.set(name, handler);
    },
  };
  return { api, calls, getHook: (name: string) => hooks.get(name) };
}

const ctxFor = (senderId: string, suffix: string, channel = "slack") => ({
  agentId: "main",
  sessionKey: `agent:main:${channel}:direct:${suffix}`,
  senderId,
  channel,
});

const flush = () => new Promise((resolve) => setTimeout(resolve, 10)); // let the detached write settle

describe("integration: real index.ts wiring through a faithful fake SDK", () => {
  let stateDir: string;

  beforeEach(() => {
    stateDir = mkdtempSync(join(tmpdir(), "csm-itest-"));
    process.env.CSM_TEST_STATE_DIR = stateDir;
  });

  afterEach(() => {
    delete process.env.CSM_TEST_STATE_DIR;
    rmSync(stateDir, { recursive: true, force: true });
  });

  it("propagates an owner fact across sessions and never overrides agent/model at the SDK boundary", async () => {
    const { api, calls, getHook } = makeApi(["slack:U1"]);
    plugin.register(api);
    const hook = getHook("before_prompt_build")!;
    expect(hook).toBeTypeOf("function");

    hook({ prompt: "My favorite color is blue", messages: [] }, ctxFor("u1", "a"));
    await flush();
    const result = hook({ prompt: "what is my color?", messages: [] }, ctxFor("u1", "b"));

    expect(calls.length).toBeGreaterThan(0);
    for (const params of calls) {
      expect(params).not.toHaveProperty("agentId");
      expect(params).not.toHaveProperty("model");
    }
    expect(result?.prependSystemContext).toContain("favorite color: blue");
  });

  it("recognizes the owner across channels only when scoped per channel", async () => {
    // The same human enumerated on each channel; cross-channel recall works, bare ids do not.
    const { api, getHook } = makeApi(["whatsapp:u1", "telegram:u1"]);
    plugin.register(api);
    const hook = getHook("before_prompt_build")!;

    hook({ prompt: "My favorite color is blue", messages: [] }, ctxFor("u1", "wa", "whatsapp"));
    await flush();

    const result = hook({ prompt: "what is my color?", messages: [] }, ctxFor("u1", "tg", "telegram"));
    expect(result?.prependSystemContext).toContain("favorite color: blue");
  });

  it("is inert (no capture, no injection) for a bare, non-channel-scoped owner id", async () => {
    // The host documents bare ids as valid; this plugin requires channel-scoping and warns at
    // register. The behavior is deliberate, so the operator gets a dead-but-loud plugin, not a leak.
    const { api, calls, getHook } = makeApi(["+15551234567"]);
    plugin.register(api);
    const hook = getHook("before_prompt_build")!;

    const ctx = { agentId: "main", sessionKey: "agent:main:whatsapp:direct:x", senderId: "+15551234567", channel: "whatsapp" };
    hook({ prompt: "My favorite color is blue", messages: [] }, ctx);
    await flush();

    expect(calls).toHaveLength(0); // never extracted
    expect(hook({ prompt: "what is my color?", messages: [] }, ctx)).toBeUndefined(); // never injected
  });

  it("does not inject the owner's private memory into a group turn", async () => {
    const { api, getHook } = makeApi(["slack:U1"]);
    plugin.register(api);
    const hook = getHook("before_prompt_build")!;

    hook({ prompt: "My favorite color is blue", messages: [] }, ctxFor("u1", "a"));
    await flush();

    // A group session for the same owner: capture-side gate would still pass, but injection must not.
    const groupCtx = { agentId: "main", sessionKey: "agent:main:slack:group:team42", senderId: "u1", channel: "slack" };
    expect(hook({ prompt: "what is my color?", messages: [] }, groupCtx)).toBeUndefined();
  });

  it("fails closed under a wildcard owner: one sender's fact never reaches another", async () => {
    const { api, getHook } = makeApi(["*"]);
    plugin.register(api);
    const hook = getHook("before_prompt_build")!;

    hook({ prompt: "My favorite color is blue", messages: [] }, ctxFor("u1", "a"));
    await flush();

    expect(hook({ prompt: "color?", messages: [] }, ctxFor("u2", "b"))).toBeUndefined();
    expect(hook({ prompt: "color?", messages: [] }, ctxFor("u1", "c"))).toBeUndefined();
  });

  it("registers no hooks when disabled", () => {
    const { api, getHook } = makeApi(["slack:U1"], { enabled: false });
    plugin.register(api);
    expect(getHook("before_prompt_build")).toBeUndefined();
  });

  it("registers only the prompt-injection hook, never a conversation hook", () => {
    const { api, getHook } = makeApi(["slack:U1"]);
    plugin.register(api);
    expect(getHook("before_prompt_build")).toBeTypeOf("function");
    // llm_output is a conversation hook; a non-bundled plugin cannot register it without an operator
    // grant, so this plugin no longer registers it at all (reply capture removed).
    expect(getHook("llm_output")).toBeUndefined();
  });
});

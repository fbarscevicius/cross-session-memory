import { describe, expect, it, vi } from "vitest";
import { DEFAULT_OPTIONS } from "../src/core/defaults.js";
import { observe } from "../src/core/observe.js";
import { FactStore } from "../src/core/store.js";

const AGENT = "main";
const OWNER = "owner-1";
const options = { ...DEFAULT_OPTIONS };
const isOwner = (s: string | undefined | null, _ch: string | undefined | null) => s === OWNER;

describe("idempotency and loop safety", () => {
  it("extracts a repeated identical message only once", async () => {
    const store = new FactStore(":memory:");
    const now = () => 1_000_000;
    const complete = vi.fn(async () => JSON.stringify([{ fact_key: "favorite_color", value: "blue", importance: 0.7, op: "ADD" }]));

    const input = { prompt: "My favorite color is blue", senderId: OWNER, agentId: AGENT, sessionKey: "agent:main:whatsapp:direct:x", channel: "whatsapp" };
    await observe({ store, complete, now, isOwner, options }, input);
    await observe({ store, complete, now, isOwner, options }, input);

    expect(complete).toHaveBeenCalledTimes(1);
  });

  it("dedupes two identical turns racing in the same tick to one model call", async () => {
    const store = new FactStore(":memory:");
    const now = () => 1_000_000;
    const complete = vi.fn(async () => JSON.stringify([{ fact_key: "favorite_color", value: "blue", importance: 0.7, op: "ADD" }]));

    const input = { prompt: "My favorite color is blue", senderId: OWNER, agentId: AGENT, sessionKey: "agent:main:whatsapp:direct:x", channel: "whatsapp" };
    // Both start before either awaits; markSeen runs synchronously before the await, so the second
    // observes the claim and short-circuits. Guards the markSeen-before-await invariant against a
    // future refactor that inserts an await ahead of the claim.
    await Promise.all([
      observe({ store, complete, now, isOwner, options }, input),
      observe({ store, complete, now, isOwner, options }, input),
    ]);

    expect(complete).toHaveBeenCalledTimes(1);
  });

  it("treats an identical key and value as a no-op write (loop backstop)", () => {
    const store = new FactStore(":memory:");
    expect(store.applyOp({ factKey: "favorite_color", value: "blue", importance: 0.7, op: "ADD" }, { agentId: AGENT, observedAt: 1000 })).toBe("added");
    expect(store.applyOp({ factKey: "favorite_color", value: "blue", importance: 0.7, op: "UPDATE" }, { agentId: AGENT, observedAt: 2000 })).toBe("noop");
    expect(store.readAllForAgent(AGENT)[0]!.superseded).toHaveLength(0);
  });

  it("re-extracts after a failed extraction (claim released)", async () => {
    const store = new FactStore(":memory:");
    const now = () => 1_000_000;
    let calls = 0;
    const complete = vi.fn(async () => {
      calls += 1;
      if (calls === 1) throw new Error("transient model error");
      return JSON.stringify([{ fact_key: "favorite_color", value: "blue", importance: 0.7, op: "ADD" }]);
    });
    const input = { prompt: "My favorite color is blue", senderId: OWNER, agentId: AGENT, sessionKey: "agent:main:whatsapp:direct:x", channel: "whatsapp" };

    await expect(observe({ store, complete, now, isOwner, options }, input)).rejects.toThrow("transient");
    expect(store.readAllForAgent(AGENT)).toHaveLength(0); // nothing stored on failure

    await observe({ store, complete, now, isOwner, options }, input); // retry re-extracts
    expect(complete).toHaveBeenCalledTimes(2);
    expect(store.readAllForAgent(AGENT)[0]!.value).toBe("blue");
  });

  it("releases the claim when an applyOp write fails, so a retry re-extracts", async () => {
    const store = new FactStore(":memory:");
    const now = () => 1_000_000;
    const complete = vi.fn(async () => JSON.stringify([{ fact_key: "favorite_color", value: "blue", importance: 0.7, op: "ADD" }]));
    const input = { prompt: "My favorite color is blue", senderId: OWNER, agentId: AGENT, sessionKey: "agent:main:whatsapp:direct:x", channel: "whatsapp" };

    const realApply = store.applyOp.bind(store);
    let fail = true;
    store.applyOp = ((op, ctx) => {
      if (fail) throw new Error("disk full");
      return realApply(op, ctx);
    }) as typeof store.applyOp;

    await expect(observe({ store, complete, now, isOwner, options }, input)).rejects.toThrow("disk full");
    expect(store.readAllForAgent(AGENT)).toHaveLength(0); // nothing committed

    fail = false;
    await observe({ store, complete, now, isOwner, options }, input); // claim released => re-extracts
    expect(complete).toHaveBeenCalledTimes(2);
    expect(store.readAllForAgent(AGENT)[0]!.value).toBe("blue");
  });
});

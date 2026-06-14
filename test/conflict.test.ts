import { describe, expect, it } from "vitest";
import { DEFAULT_OPTIONS } from "../src/core/defaults.js";
import { inject } from "../src/core/inject.js";
import { observe } from "../src/core/observe.js";
import { FactStore } from "../src/core/store.js";

const AGENT = "main";
const OWNER = "owner-1";
const options = { ...DEFAULT_OPTIONS };
const isOwner = (s: string | undefined | null, _ch: string | undefined | null) => s === OWNER;

const complete = async ({ user }: { user: string; system: string }) => {
  if (user.includes("green")) return JSON.stringify([{ fact_key: "favorite_color", value: "green", importance: 0.7, op: "UPDATE" }]);
  if (user.includes("blue")) return JSON.stringify([{ fact_key: "favorite_color", value: "blue", importance: 0.7, op: "ADD" }]);
  return "[]";
};

describe("conflict resolution", () => {
  it("lets the most recently stated value win and retains the prior with provenance", async () => {
    const store = new FactStore(":memory:");
    let clock = 1_000_000;
    const now = () => clock;

    clock = 1_000_000;
    await observe(
      { store, complete, now, isOwner, options },
      { prompt: "My favorite color is blue", senderId: OWNER, agentId: AGENT, sessionKey: "agent:main:whatsapp:direct:x", channel: "whatsapp" },
    );

    clock = 1_000_000 + 10_000;
    await observe(
      { store, complete, now, isOwner, options },
      { prompt: "Actually my favorite color is green now", senderId: OWNER, agentId: AGENT, sessionKey: "agent:main:slack:direct:y", channel: "slack" },
    );

    const facts = store.readAllForAgent(AGENT);
    expect(facts).toHaveLength(1);
    expect(facts[0]!.value).toBe("green");
    expect(facts[0]!.superseded[0]?.value).toBe("blue");

    const injected = inject({ store, now, isOwner, options }, { senderId: OWNER, channel: "slack", agentId: AGENT });
    expect(injected).toContain("favorite color: green");
    expect(injected).toContain("was blue");
  });

  it("does not let an older observation overwrite a newer one (statement-time CAS)", () => {
    const store = new FactStore(":memory:");
    expect(store.applyOp({ factKey: "k", value: "new", importance: 0.5, op: "ADD" }, { agentId: AGENT, observedAt: 2000 })).toBe("added");
    expect(store.applyOp({ factKey: "k", value: "old", importance: 0.5, op: "UPDATE" }, { agentId: AGENT, observedAt: 1000 })).toBe("noop");
    expect(store.readAllForAgent(AGENT)[0]!.value).toBe("new");
  });
});

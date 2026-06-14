import { describe, expect, it, vi } from "vitest";
import { DEFAULT_OPTIONS } from "../src/core/defaults.js";
import { inject } from "../src/core/inject.js";
import { observe } from "../src/core/observe.js";
import { FactStore } from "../src/core/store.js";

const AGENT = "main";
const OWNER = "owner-1";
const options = { ...DEFAULT_OPTIONS };
const isOwner = (s: string | undefined | null, _ch: string | undefined | null) => s === OWNER;

describe("owner gating (gate is consulted on both paths)", () => {
  it("never extracts from a non-owner or unidentified turn", async () => {
    const store = new FactStore(":memory:");
    const now = () => 1_000_000;
    const complete = vi.fn(async () => JSON.stringify([{ fact_key: "secret", value: "x", importance: 0.9, op: "ADD" }]));

    await observe(
      { store, complete, now, isOwner, options },
      { prompt: "My password is hunter2 and this is long enough", senderId: "stranger", agentId: AGENT, sessionKey: "agent:main:slack:direct:s", channel: "slack" },
    );
    await observe(
      { store, complete, now, isOwner, options },
      { prompt: "Another long enough message from nobody", senderId: undefined, agentId: AGENT, sessionKey: "agent:main:slack:direct:s", channel: "slack" },
    );

    expect(complete).not.toHaveBeenCalled();
    expect(store.readAllForAgent(AGENT)).toHaveLength(0);
  });

  it("never injects the owner's facts into a non-owner turn", async () => {
    const store = new FactStore(":memory:");
    const now = () => 1_000_000;
    const complete = async () => JSON.stringify([{ fact_key: "favorite_color", value: "blue", importance: 0.7, op: "ADD" }]);

    await observe(
      { store, complete, now, isOwner, options },
      { prompt: "My favorite color is blue", senderId: OWNER, agentId: AGENT, sessionKey: "agent:main:whatsapp:direct:x", channel: "whatsapp" },
    );

    expect(inject({ store, now, isOwner, options }, { senderId: "stranger", channel: "slack", agentId: AGENT })).toBeUndefined();
    expect(inject({ store, now, isOwner, options }, { senderId: OWNER, channel: "slack", agentId: AGENT })).toContain("favorite color: blue");
  });
});

import { describe, expect, it, vi } from "vitest";
import { DEFAULT_OPTIONS } from "../src/core/defaults.js";
import { inject } from "../src/core/inject.js";
import { observe } from "../src/core/observe.js";
import { FactStore } from "../src/core/store.js";

const AGENT = "main";
const OWNER = "owner-1";
const options = { ...DEFAULT_OPTIONS };
const isOwner = (s: string | undefined | null, _ch: string | undefined | null) => s === OWNER;

describe("noise filtering", () => {
  it("rejects sub-threshold, all-chatter, and emoji-only messages before any model call", async () => {
    const store = new FactStore(":memory:");
    const now = () => 1_000_000;
    const complete = vi.fn(async () => "[]");

    for (const prompt of ["lol", "ok ok ok", "haha haha", "👍👍👍", "!!! ???"]) {
      await observe(
        { store, complete, now, isOwner, options },
        { prompt, senderId: OWNER, agentId: AGENT, sessionKey: "agent:main:discord:direct:z", channel: "discord" },
      );
    }

    expect(complete).not.toHaveBeenCalled(); // free prefilter, no token cost
    expect(store.readAllForAgent(AGENT)).toHaveLength(0);
    expect(inject({ store, now, isOwner, options }, { senderId: OWNER, channel: "discord", agentId: AGENT })).toBeUndefined();
  });

  it("passes a short real fact through the floor", async () => {
    const store = new FactStore(":memory:");
    const now = () => 1_000_000;
    const complete = vi.fn(async () => "[]");

    for (const prompt of ["vegan", "ENFP", "6ft2"]) {
      await observe(
        { store, complete, now, isOwner, options },
        { prompt, senderId: OWNER, agentId: AGENT, sessionKey: "agent:main:discord:direct:z", channel: "discord" },
      );
    }

    expect(complete).toHaveBeenCalledTimes(3); // reached extraction, not dropped by the floor
  });
});

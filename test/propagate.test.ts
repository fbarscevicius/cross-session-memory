import { describe, expect, it } from "vitest";
import { DEFAULT_OPTIONS } from "../src/core/defaults.js";
import { inject } from "../src/core/inject.js";
import { observe } from "../src/core/observe.js";
import { FactStore } from "../src/core/store.js";

const AGENT = "main";
const OWNER = "owner-1";
const options = { ...DEFAULT_OPTIONS };
const isOwner = (s: string | undefined | null, _ch: string | undefined | null) => s === OWNER;

const complete = async ({ user }: { user: string; system: string }) =>
  user.includes("blue")
    ? JSON.stringify([{ fact_key: "favorite_color", value: "blue", importance: 0.7, op: "ADD" }])
    : "[]";

describe("propagation", () => {
  it("makes a fact stated in session A available to session B's next prompt", async () => {
    const store = new FactStore(":memory:");
    const now = () => 1_000_000;

    await observe(
      { store, complete, now, isOwner, options },
      { prompt: "My favorite color is blue", senderId: OWNER, agentId: AGENT, sessionKey: "agent:main:whatsapp:direct:x", channel: "whatsapp" },
    );

    const injected = inject(
      { store, now, isOwner, options },
      { senderId: OWNER, channel: "slack", agentId: AGENT },
    );

    expect(injected).toBeDefined();
    expect(injected).toContain("favorite color: blue");
  });
});

import { describe, expect, it } from "vitest";
import { DEFAULT_OPTIONS } from "../src/core/defaults.js";
import { inject } from "../src/core/inject.js";
import { FactStore } from "../src/core/store.js";

const AGENT = "main";
const OWNER = "owner-1";
const options = { ...DEFAULT_OPTIONS };
const isOwner = (s: string | undefined | null, _ch: string | undefined | null) => s === OWNER;
const HOUR = 3_600_000;
const FLOOD = 120; // a large live set, so ranking has to do real work

describe("selection", () => {
  it("keeps a durable high-importance fact among a flood of fresher facts", () => {
    const store = new FactStore(":memory:");
    const base = 1_000_000;

    store.applyOp(
      { factKey: "critical_metric", value: "deadline is friday", importance: 1, op: "ADD" },
      { agentId: AGENT, observedAt: base },
    );
    for (let i = 1; i <= FLOOD; i++) {
      store.applyOp(
        { factKey: `fresh_${i}`, value: `chatter ${i}`, importance: 0.2, op: "ADD" },
        { agentId: AGENT, observedAt: base + i },
      );
    }

    const now = () => base + FLOOD + 100;
    const injected = inject({ store, now, isOwner, options }, { senderId: OWNER, channel: "slack", agentId: AGENT });
    expect(injected).toContain("critical metric: deadline is friday");
  });

  it("surfaces a recent low-importance fact even amid many higher-importance facts", () => {
    const store = new FactStore(":memory:");
    const base = 1_000_000_000_000;

    // A large set of OLD high-importance facts (still inside the 72h TTL, but decayed by recency). A
    // recent low-importance fact must still be scored and surfaced: recency rescues it even though many
    // facts outrank it on importance alone.
    for (let i = 0; i < FLOOD; i++) {
      store.applyOp(
        { factKey: `old_${i}`, value: `old value ${i}`, importance: 0.9, op: "ADD" },
        { agentId: AGENT, observedAt: base },
      );
    }
    store.applyOp(
      { factKey: "recent_note", value: "just stated this", importance: 0.2, op: "ADD" },
      { agentId: AGENT, observedAt: base + 65 * HOUR },
    );

    const now = () => base + 65 * HOUR + 1000;
    const injected = inject({ store, now, isOwner, options }, { senderId: OWNER, channel: "slack", agentId: AGENT });
    expect(injected).toContain("recent note: just stated this");
  });

  it("evicts by score, not alphabet, when the char budget binds", () => {
    const store = new FactStore(":memory:");
    const now = () => 2000;
    const tight = { ...DEFAULT_OPTIONS, charBudget: 90 }; // fits ~one ~55-char line

    // Same timestamp, so score is importance alone. The high-importance fact is alphabetically LAST;
    // applying the budget over the alphabetical order would keep aaa_ and drop zzz_ regardless of score.
    store.applyOp({ factKey: "aaa_trivial", value: "x".repeat(40), importance: 0.1, op: "ADD" }, { agentId: AGENT, observedAt: 1000 });
    store.applyOp({ factKey: "zzz_critical", value: "y".repeat(40), importance: 1.0, op: "ADD" }, { agentId: AGENT, observedAt: 1000 });

    const injected = inject(
      { store, now, isOwner, options: tight },
      { senderId: OWNER, channel: "slack", agentId: AGENT, sessionKey: "agent:main:slack:direct:p" },
    )!;
    expect(injected).toContain("zzz critical"); // highest score survives the budget
    expect(injected).not.toContain("aaa trivial"); // lowest score is the one evicted
  });
});

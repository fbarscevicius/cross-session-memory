import { describe, expect, it } from "vitest";
import { buildOwnerMatcher, matchesOwner } from "../src/core/owner.js";

describe("owner matcher (channel-scoped only)", () => {
  it("matches a scoped, mixed-case owner config against the raw lowercased Slack sender", () => {
    const m = buildOwnerMatcher(["slack:U12345678"]);
    expect(matchesOwner(m, "slack", "u12345678")).toBe(true); // ctx.senderId is bare + lowercased
    expect(matchesOwner(m, "slack", "u99999999")).toBe(false); // stranger
  });

  it("matches a sender that already carries a channel prefix", () => {
    const m = buildOwnerMatcher(["slack:u123"]);
    expect(matchesOwner(m, "slack", "slack:u123")).toBe(true);
  });

  it("does NOT honor a bare/unscoped owner id, so it cannot collide across channels", () => {
    const bare = buildOwnerMatcher(["12345"]);
    expect(matchesOwner(bare, "telegram", "12345")).toBe(false); // bare entry never matches
    expect(matchesOwner(bare, "discord", "12345")).toBe(false);
    // a user:-prefixed id is also unscoped and is not honored
    expect(matchesOwner(buildOwnerMatcher(["user:U123"]), "slack", "u123")).toBe(false);
  });

  it("recognizes the same human across channels only when scoped per channel", () => {
    const m = buildOwnerMatcher(["telegram:12345", "discord:67890"]);
    expect(matchesOwner(m, "telegram", "12345")).toBe(true);
    expect(matchesOwner(m, "discord", "67890")).toBe(true);
    // a stranger who is 12345 on Discord is NOT the Telegram owner 12345
    expect(matchesOwner(m, "discord", "12345")).toBe(false);
  });

  it("fails closed on a wildcard: * matches nobody and never opens the gate", () => {
    const onlyStar = buildOwnerMatcher(["*"]);
    expect(matchesOwner(onlyStar, "slack", "anyone")).toBe(false);
    const mixed = buildOwnerMatcher(["*", "slack:u1"]);
    expect(matchesOwner(mixed, "slack", "u1")).toBe(true);
    expect(matchesOwner(mixed, "slack", "u2")).toBe(false);
  });

  it("fails closed for an empty sender or an empty channel", () => {
    const m = buildOwnerMatcher(["slack:u1"]);
    expect(matchesOwner(m, "slack", "")).toBe(false);
    expect(matchesOwner(m, "slack", null)).toBe(false);
    expect(matchesOwner(m, "", "u1")).toBe(false); // no channel => cannot scope => deny
    expect(matchesOwner(m, null, "u1")).toBe(false);
  });

  it("does not cross channels for a scoped entry", () => {
    const m = buildOwnerMatcher(["telegram:123"]);
    expect(matchesOwner(m, "slack", "123")).toBe(false);
    expect(matchesOwner(m, "telegram", "123")).toBe(true);
  });
});

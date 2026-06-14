// Test stub for openclaw/plugin-sdk/routing. Approximates resolveAgentIdFromSessionKey enough for
// the integration test (the real host normalization is not under test here; the wiring is).
export function resolveAgentIdFromSessionKey(sessionKey: string | undefined | null): string {
  const match = /^agent:([^:]+):/.exec((sessionKey ?? "").trim());
  return match?.[1] ?? "main";
}

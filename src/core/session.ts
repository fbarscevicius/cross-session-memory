// Match direct 1:1 session keys only, so group and channel turns fail closed to no injection.
const DIRECT_SESSION_RE = /:direct:/;

export function isInjectableSession(sessionKey: string | undefined | null): boolean {
  if (!sessionKey) return true; // absent only off the hot path (tests); caller still owner-gates
  return DIRECT_SESSION_RE.test(sessionKey);
}

/**
 * Pure owner matching (no host import). Matches a channel-scoped owner id ("slack:u123") against the
 * turn's (channel, senderId). Scoped-only and fails closed on "*": bare ids collide across channels, so
 * a bare owner would also match a stranger elsewhere. See README "Owner setup".
 */
export type OwnerMatcher = { entries: ReadonlySet<string> };

const USER_PREFIX_RE = /^user:/;
const LEADING_CHANNEL_PREFIX_RE = /^[a-z0-9_-]+:/;

export function buildOwnerMatcher(raw: ReadonlyArray<string | number>): OwnerMatcher {
  const entries = new Set<string>();
  for (const item of raw) {
    const value = String(item).trim().toLowerCase();
    if (!value) continue;
    if (value === "*") continue; // fail closed: "*" is never honored for a privacy store
    entries.add(value.replace(USER_PREFIX_RE, ""));
  }
  return { entries };
}

// Split entries into scoped (match) and bare (never match); the caller warns on the bare set at register.
export function classifyOwnerEntries(raw: ReadonlyArray<string | number>): { scoped: string[]; bare: string[] } {
  const scoped: string[] = [];
  const bare: string[] = [];
  for (const item of raw) {
    const value = String(item).trim().toLowerCase().replace(USER_PREFIX_RE, "");
    if (!value || value === "*") continue;
    (value.includes(":") ? scoped : bare).push(value);
  }
  return { scoped, bare };
}

export function matchesOwner(
  matcher: OwnerMatcher,
  channel: string | undefined | null,
  senderId: string | undefined | null,
): boolean {
  const sender = (senderId ?? "").trim().toLowerCase();
  const ch = (channel ?? "").trim().toLowerCase();
  if (!sender || !ch) return false;
  const bare = sender.replace(LEADING_CHANNEL_PREFIX_RE, "");
  // Two scoped candidates: a bare sender ("ch:sender") and one already carrying a channel prefix ("ch:bare").
  return matcher.entries.has(`${ch}:${sender}`) || matcher.entries.has(`${ch}:${bare}`);
}

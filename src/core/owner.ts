/**
 * Pure owner matching. Lowercases both sides and matches a CHANNEL-SCOPED owner id (e.g. "slack:u123")
 * against the (channel, senderId) of the turn by reconstructing the scoped candidate. Kept free of any
 * host import so the suite needs no clone.
 *
 * Matching is scoped-only: owner ids must be channel-scoped to match. An unscoped/bare id is NOT
 * honored, because bare sender ids share a namespace across channels (Telegram and Discord both use
 * bare numeric ids), so a bare owner "12345" would also match an unrelated person who is user 12345 on
 * another channel: their messages would poison the owner's store and the owner's private facts would
 * inject into their session. For cross-channel recognition, enumerate the owner's scoped id PER channel
 * (e.g. ["whatsapp:+1555...", "telegram:12345"]); see README "Owner gating".
 *
 * This is deliberately stricter than the host's command-auth allowlist, which also accepts bare ids and
 * a "*" wildcard. Neither is honored here: "*" is ignored (fails closed), and matching is scoped-only,
 * because this is a privacy store rather than a command-auth gate. Sharing memory across senders, if
 * ever wanted, must be a separate explicit opt-in.
 *
 * Channel id shapes beyond the "prefix:id" form (e.g. phone numbers) need per-channel verification.
 */
export type OwnerMatcher = { entries: ReadonlySet<string> };

const USER_PREFIX_RE = /^user:/;
const LEADING_CHANNEL_PREFIX_RE = /^[a-z0-9_-]+:/;

/** Build the matcher from raw owner entries (commands.ownerAllowFrom plus plugin owners). */
export function buildOwnerMatcher(raw: ReadonlyArray<string | number>): OwnerMatcher {
  const entries = new Set<string>();
  for (const item of raw) {
    const value = String(item).trim().toLowerCase();
    if (!value) continue;
    if (value === "*") continue; // fail closed: "*" is not honored for memory (see file header)
    entries.add(value.replace(USER_PREFIX_RE, ""));
  }
  return { entries };
}

/**
 * Split raw owner entries into channel-scoped (will match) and bare/unscoped (silently would not,
 * because matching is scoped-only). The caller warns about the bare set at register so a valid-looking
 * but unscoped config is a loud, actionable error rather than a silently inert plugin.
 */
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

/**
 * True when (channel, senderId) is the configured owner. Matches only the channel-scoped form, so a
 * bare entry cannot match across channels. Fails closed for an empty sender or empty channel.
 */
export function matchesOwner(
  matcher: OwnerMatcher,
  channel: string | undefined | null,
  senderId: string | undefined | null,
): boolean {
  const sender = (senderId ?? "").trim().toLowerCase();
  const ch = (channel ?? "").trim().toLowerCase();
  if (!sender || !ch) return false; // no channel => cannot scope => deny
  const bare = sender.replace(LEADING_CHANNEL_PREFIX_RE, "");
  // Only channel-scoped candidates. `${ch}:${sender}` covers a bare sender; `${ch}:${bare}` covers a
  // sender that already carries a channel prefix.
  return matcher.entries.has(`${ch}:${sender}`) || matcher.entries.has(`${ch}:${bare}`);
}

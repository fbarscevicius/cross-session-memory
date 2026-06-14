/**
 * Session-kind detection from the host's session key, for keeping cross-session memory out of
 * multi-recipient turns.
 *
 * The host builds direct keys with a `:direct:` peerKind segment and group/channel keys with a
 * `:group:`/`:channel:` segment; the chat-type universe is "direct" | "group" | "channel". This is
 * an ALLOWLIST: inject only into a positively direct session, so any non-direct or future
 * multi-recipient chat type defaults to no injection rather than a leak (fail closed). The collapsed
 * main session (`agent:<id>:<mainKey>`) is also not matched, which is harmless: at dmScope=main every
 * channel is one session, so there is no cross-session memory to propagate.
 *
 * An absent key is treated as injectable: the host always supplies a session key on
 * before_prompt_build (it is how the agent id is derived), so absence only happens in unit tests that
 * do not exercise session-kind gating, and the caller already owner-gates.
 */
const DIRECT_SESSION_RE = /:direct:/;

/** True when it is safe to inject owner memory into this session (a direct 1:1 session, or no key). */
export function isInjectableSession(sessionKey: string | undefined | null): boolean {
  if (!sessionKey) return true;
  return DIRECT_SESSION_RE.test(sessionKey);
}

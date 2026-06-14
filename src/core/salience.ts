/**
 * Pure, zero-cost noise prefilter. Drops a message before any model call when it is too short, has
 * no alphanumeric content (emoji/punctuation only), or consists entirely of chatter tokens. The
 * denylist only fires when EVERY token is chatter, so "ok the meeting moved" passes while "ok ok ok"
 * and "haha haha" are dropped.
 */
const CHATTER = new Set([
  "lol", "lmao", "rofl", "haha", "hahaha", "hehe", "ok", "okay", "k", "kk",
  "yes", "yeah", "yep", "ya", "no", "nope", "nah", "sure", "cool", "nice", "great",
  "thanks", "thx", "ty", "np", "hi", "hey", "hello", "yo", "sup", "hmm", "hm", "oh",
  "ah", "wow", "omg", "idk", "ikr", "fine", "good", "bye", "gg",
]);

// Self-referential openers are reliably fact-bearing and never chatter, so they bypass the length
// floor (keeps "I'm AB+", "my ENFP"). A bare-digit escape is deliberately omitted: it would leak
// "lol 9"-style chatter to the model.
const SELF_REFERENCE_RE = /^(?:i'?m|i am|my)\b/i;

/** True when the message is noise and should be skipped before extraction. */
export function isNoise(text: string, minPromptChars: number): boolean {
  const trimmed = text.trim();
  if (trimmed.replace(/[^a-z0-9]/gi, "").length === 0) return true; // emoji/punctuation only
  const tokens = trimmed.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  if (tokens.length > 0 && tokens.every((token) => CHATTER.has(token))) return true; // all chatter
  if (trimmed.length < minPromptChars && !SELF_REFERENCE_RE.test(trimmed)) return true; // floor + escape
  return false;
}

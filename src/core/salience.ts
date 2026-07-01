// Chatter denylist fires only when EVERY token is chatter, so "ok the meeting moved" passes but "ok ok ok" drops.
const CHATTER = new Set([
  "lol", "lmao", "rofl", "haha", "hahaha", "hehe", "ok", "okay", "k", "kk",
  "yes", "yeah", "yep", "ya", "no", "nope", "nah", "sure", "cool", "nice", "great",
  "thanks", "thx", "ty", "np", "hi", "hey", "hello", "yo", "sup", "hmm", "hm", "oh",
  "ah", "wow", "omg", "idk", "ikr", "fine", "good", "bye", "gg",
]);

// Self-referential openers bypass the length floor (they carry short facts like "I'm AB+"). No bare-digit
// escape: it would leak "lol 9"-style chatter to the model.
const SELF_REFERENCE_RE = /^(?:i'?m|i am|my)\b/i;

export function isNoise(text: string, minPromptChars: number): boolean {
  const trimmed = text.trim();
  if (trimmed.replace(/[^a-z0-9]/gi, "").length === 0) return true;
  const tokens = trimmed.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  if (tokens.length > 0 && tokens.every((token) => CHATTER.has(token))) return true;
  if (trimmed.length < minPromptChars && !SELF_REFERENCE_RE.test(trimmed)) return true;
  return false;
}

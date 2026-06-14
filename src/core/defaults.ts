/** Operator-tunable option set, resolved and clamped from plugin config at the adapter boundary. */
export type Options = {
  enabled: boolean;
  owners: string[];
  minPromptChars: number;
  maxFacts: number;
  charBudget: number;
  ttlHours: number;
};

/** Defaults for every advertised config key (see README "Configuration"). */
export const DEFAULT_OPTIONS: Options = {
  enabled: true,
  owners: [],
  // The all-chatter denylist and emoji/punctuation check in salience.ts do most of the noise
  // filtering; this floor only drops 1-3 char fragments, low enough to pass real short facts
  // ("ENFP", "vegan", "6ft2"). Self-referential openers ("I'm AB+") bypass it entirely.
  minPromptChars: 4,
  maxFacts: 8,
  charBudget: 600,
  ttlHours: 72,
};

/** Internal constants, deliberately not operator-configurable to keep the config surface small. */
export const RETRIEVAL_LIMIT = 10; // bound the fact VALUES fed into the extraction prompt
export const MAX_EXTRACTION_KEYS = 50; // cap the dedup key list sent to extraction so it cannot grow unbounded
export const MAX_SUPERSEDED = 5; // bound retained conflict history per fact
export const MAX_FACT_VALUE_CHARS = 200; // cap untrusted fact values before storing/injecting
export const MAX_FACT_KEY_CHARS = 64;
export const RECENCY_HALF_LIFE_HOURS = 24; // recency decay half-life in the ranking score
export const EXTRACTION_MAX_TOKENS = 512;
export const EXTRACTION_TEMPERATURE = 0;
export const EXTRACTION_TIMEOUT_MS = 10_000; // bound the detached extraction call

/** Ranking weights; they sum to 1 so the combined score stays in [0, 1]. */
export const WEIGHT_RECENCY = 0.5;
export const WEIGHT_IMPORTANCE = 0.5;

export function clampInt(value: unknown, fallback: number, min: number, max: number): number {
  const n = typeof value === "number" && Number.isFinite(value) ? Math.round(value) : fallback;
  return Math.min(max, Math.max(min, n));
}

export function clampNumber(value: unknown, fallback: number, min: number, max: number): number {
  const n = typeof value === "number" && Number.isFinite(value) ? value : fallback;
  return Math.min(max, Math.max(min, n));
}

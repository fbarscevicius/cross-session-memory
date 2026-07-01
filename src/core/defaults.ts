export type Options = {
  enabled: boolean;
  owners: string[];
  minPromptChars: number;
  maxFacts: number;
  charBudget: number;
  ttlHours: number;
};

export const DEFAULT_OPTIONS: Options = {
  enabled: true,
  owners: [],
  // Floor only drops 1-3 char fragments; salience.ts does the real filtering and self-referential
  // openers ("I'm AB+") bypass it.
  minPromptChars: 4,
  maxFacts: 8,
  charBudget: 600,
  ttlHours: 72,
};

// Internal constants, kept off the config surface on purpose.
export const RETRIEVAL_LIMIT = 10;
export const MAX_EXTRACTION_KEYS = 50;
export const MAX_SUPERSEDED = 5;
export const MAX_FACT_VALUE_CHARS = 200;
export const MAX_FACT_KEY_CHARS = 64;
export const RECENCY_HALF_LIFE_HOURS = 24;
export const EXTRACTION_MAX_TOKENS = 512;
export const EXTRACTION_TEMPERATURE = 0;
export const EXTRACTION_TIMEOUT_MS = 10_000;

// Weights sum to 1 so the score stays in [0, 1].
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

import { createHash } from "node:crypto";
import { MAX_FACT_VALUE_CHARS } from "./defaults.js";
import { stripFrameTokens } from "./frame.js";
import type { ExtractionOp, Fact } from "./store.js";

// Idempotency hash keyed on (agentId, text), not the session, so the same text on two channels extracts once.
export function contentHash(agentId: string, text: string): string {
  return createHash("sha256").update(agentId).update("\n").update(text).digest("hex");
}

const SYSTEM_PROMPT = [
  "You extract durable, reusable facts about the user from a single chat message they sent.",
  "A durable fact is a stable preference, attribute, plan, commitment, or relationship useful to recall in a later, separate conversation.",
  "Ignore chit-chat, pleasantries, transient reactions, and anything not worth recalling later.",
  "Ignore questions and requests; a question is never a fact.",
  "",
  "You are given the EXISTING FACT KEYS (reuse one to update that same fact), the user's MOST RECENT FACTS as `key: value` lines, then the NEW INPUT.",
  "Reuse an existing key when the input updates or restates that fact so the store can resolve the conflict. Invent a new snake_case key only for a genuinely new fact.",
  "",
  "Return ONLY a JSON array, with no prose and no code fence. Each element is:",
  '{ "fact_key": "snake_case_key", "value": "concise value", "importance": 0.0-1.0, "op": "ADD" | "UPDATE" | "NOOP" }',
  "Use ADD for a new key, UPDATE when reusing an existing key with a changed value, NOOP to skip.",
  "importance: 0.0 trivial, 1.0 critical. Return [] when there is no durable fact.",
].join("\n");

export function buildExtractionPrompt(
  recent: Fact[],
  allKeys: string[],
  message: string,
): { system: string; user: string } {
  const system = SYSTEM_PROMPT;
  const keyList = allKeys.length ? allKeys.join(", ") : "(none)";
  const known = recent.length ? recent.map((f) => `${f.factKey}: ${f.value}`).join("\n") : "(none)";
  const user = `EXISTING FACT KEYS (reuse to update): ${keyList}\n\nMOST RECENT FACTS:\n${known}\n\nNEW INPUT:\n${message}`;
  return { system, user };
}

// Model output is hostile: any parse or shape failure yields [] and skips the write, never throws.
export function parseOps(text: string): ExtractionOp[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(extractJsonArray(text));
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];

  const ops: ExtractionOp[] = [];
  for (const item of parsed) {
    if (typeof item !== "object" || item === null) continue;
    const record = item as Record<string, unknown>;
    const factKey = typeof record.fact_key === "string" ? record.fact_key.trim() : "";
    const value = typeof record.value === "string" ? sanitizeValue(record.value) : "";
    const op = normalizeOp(record.op);
    if (!factKey || !value || !op) continue;
    const importance =
      typeof record.importance === "number" && Number.isFinite(record.importance)
        ? Math.min(1, Math.max(0, record.importance))
        : 0.5;
    ops.push({ factKey, value, importance, op });
  }
  return ops;
}

// Strip frame tokens before collapsing whitespace, so the gaps they leave collapse too. Caps length.
function sanitizeValue(raw: string): string {
  return stripFrameTokens(raw).replace(/\s+/g, " ").trim().slice(0, MAX_FACT_VALUE_CHARS);
}

function normalizeOp(raw: unknown): ExtractionOp["op"] | undefined {
  if (typeof raw !== "string") return undefined;
  const upper = raw.toUpperCase();
  if (upper === "ADD" || upper === "UPDATE" || upper === "NOOP") return upper;
  return undefined;
}

function extractJsonArray(text: string): string {
  const start = text.indexOf("[");
  const end = text.lastIndexOf("]");
  if (start === -1 || end === -1 || end < start) return text;
  return text.slice(start, end + 1);
}

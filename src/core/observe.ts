import { EXTRACTION_TIMEOUT_MS, MAX_EXTRACTION_KEYS, RETRIEVAL_LIMIT } from "./defaults.js";
import type { Options } from "./defaults.js";
import { buildExtractionPrompt, contentHash, parseOps } from "./extract.js";
import { isNoise } from "./salience.js";
import type { FactStore } from "./store.js";

// No agentId/model: the host completion facade rejects (throws) an override of either unless the
// operator grants allowAgentIdOverride / allowModelOverride; dropping them from the type makes it
// structurally impossible to forward one to api.runtime.llm.complete.
export type CompleteFn = (params: { system: string; user: string }) => Promise<string>;
export type IsOwnerFn = (senderId: string | undefined | null, channel: string | undefined | null) => boolean;

export type ObserveDeps = {
  store: FactStore;
  complete: CompleteFn;
  now: () => number;
  isOwner: IsOwnerFn;
  options: Options;
};

export type ObserveInput = {
  prompt: string;
  senderId: string | undefined | null;
  agentId: string;
  sessionKey?: string;
  channel?: string;
};

/** Why an observe ended, for observability. "wrote" carries the applied-op count. */
export type ObserveOutcome =
  | { kind: "owner-skip" }
  | { kind: "noise-skip" }
  | { kind: "seen-skip" }
  | { kind: "no-facts" }
  | { kind: "wrote"; ops: number };

/** Bound the detached extraction call so a hung completion cannot hold the seen-claim forever. */
function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`extraction timed out after ${ms}ms`)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
}

/**
 * Write path: owner gate, free noise prefilter, idempotency, retrieval-augmented extraction, then a
 * per-fact CAS. Run fire-and-forget by the caller with a detached .catch. The cheap gates all run
 * before the one llm.complete call. Returns an outcome the caller can log.
 */
export async function observe(deps: ObserveDeps, input: ObserveInput): Promise<ObserveOutcome> {
  const { store, complete, now, isOwner, options } = deps;

  if (!isOwner(input.senderId, input.channel ?? null)) return { kind: "owner-skip" }; // channel-aware, fails closed

  const text = input.prompt.trim();
  if (isNoise(text, options.minPromptChars)) return { kind: "noise-skip" }; // zero-cost prefilter

  const observedAt = now();
  store.pruneExpired(input.agentId, observedAt - options.ttlHours * 3_600_000); // bound storage (TTL)

  const hash = contentHash(input.agentId, text);
  if (store.hasSeen(input.agentId, hash)) return { kind: "seen-skip" }; // idempotency backstop
  store.markSeen(input.agentId, hash, observedAt);

  const recent = store.getRecentFacts(input.agentId, RETRIEVAL_LIMIT); // bounded values
  const allKeys = store.listFactKeys(input.agentId, MAX_EXTRACTION_KEYS); // bounded dedup keys
  const prompt = buildExtractionPrompt(recent, allKeys, text);
  let raw: string;
  try {
    raw = await withTimeout(complete({ system: prompt.system, user: prompt.user }), EXTRACTION_TIMEOUT_MS);
  } catch (error) {
    store.unmarkSeen(input.agentId, hash); // free the claim so a genuine retry re-extracts
    throw error;
  }
  const ops = parseOps(raw);

  // The apply loop runs while the seen-claim is held, so a mid-loop failure must release the claim
  // too, or that exact text is skipped forever and the partial write is never completed on retry.
  try {
    for (const op of ops) {
      store.applyOp(op, {
        agentId: input.agentId,
        observedAt,
        channel: input.channel,
        sessionKey: input.sessionKey,
      });
    }
  } catch (error) {
    store.unmarkSeen(input.agentId, hash);
    throw error;
  }

  return ops.length > 0 ? { kind: "wrote", ops: ops.length } : { kind: "no-facts" };
}

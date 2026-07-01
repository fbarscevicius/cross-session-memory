import { EXTRACTION_TIMEOUT_MS, MAX_EXTRACTION_KEYS, RETRIEVAL_LIMIT } from "./defaults.js";
import type { Options } from "./defaults.js";
import { buildExtractionPrompt, contentHash, parseOps } from "./extract.js";
import { isNoise } from "./salience.js";
import type { FactStore } from "./store.js";

// No agentId/model in the type: the host facade throws on an override, so forwarding one is impossible.
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

// Write path: owner gate, noise prefilter, idempotency, extraction, per-fact CAS. Run fire-and-forget.
export async function observe(deps: ObserveDeps, input: ObserveInput): Promise<ObserveOutcome> {
  const { store, complete, now, isOwner, options } = deps;

  if (!isOwner(input.senderId, input.channel ?? null)) return { kind: "owner-skip" };

  const text = input.prompt.trim();
  if (isNoise(text, options.minPromptChars)) return { kind: "noise-skip" };

  const observedAt = now();
  store.pruneExpired(input.agentId, observedAt - options.ttlHours * 3_600_000);

  const hash = contentHash(input.agentId, text);
  if (store.hasSeen(input.agentId, hash)) return { kind: "seen-skip" };
  store.markSeen(input.agentId, hash, observedAt);

  const recent = store.getRecentFacts(input.agentId, RETRIEVAL_LIMIT);
  const allKeys = store.listFactKeys(input.agentId, MAX_EXTRACTION_KEYS);
  const prompt = buildExtractionPrompt(recent, allKeys, text);
  let raw: string;
  try {
    raw = await withTimeout(complete({ system: prompt.system, user: prompt.user }), EXTRACTION_TIMEOUT_MS);
  } catch (error) {
    store.unmarkSeen(input.agentId, hash); // free the claim so a genuine retry re-extracts
    throw error;
  }
  const ops = parseOps(raw);

  // The seen-claim is held across the apply loop, so a mid-loop failure must release it too, or that
  // text is skipped forever and the partial write never completes on retry.
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

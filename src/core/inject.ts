import { RECENCY_HALF_LIFE_HOURS, WEIGHT_IMPORTANCE, WEIGHT_RECENCY } from "./defaults.js";
import type { Options } from "./defaults.js";
import { CLOSE, HEADER, OPEN } from "./frame.js";
import type { IsOwnerFn } from "./observe.js";
import { isInjectableSession } from "./session.js";
import type { Fact, FactStore } from "./store.js";

export type InjectDeps = {
  store: FactStore;
  now: () => number;
  isOwner: IsOwnerFn;
  options: Options;
};

export type InjectInput = {
  senderId: string | undefined | null;
  channel: string | undefined | null;
  agentId: string;
  sessionKey?: string;
};

// Read path: owner + DM gate, TTL filter, rank by recency x importance, budget, render in stable key order.
export function inject(deps: InjectDeps, input: InjectInput): string | undefined {
  const { store, now, isOwner, options } = deps;

  if (!isOwner(input.senderId, input.channel)) return undefined;

  // Direct sessions only: injecting into a group turn would broadcast the owner's private memory.
  if (!isInjectableSession(input.sessionKey)) return undefined;

  const nowMs = now();
  const cutoff = nowMs - options.ttlHours * 3_600_000;
  // Prune on the read path too, so the read-all below stays bounded on this host-awaited hot path.
  store.pruneExpired(input.agentId, cutoff);
  const candidates = store
    .readRankingCandidates(input.agentId)
    .filter((f) => f.observedAt >= cutoff);
  if (candidates.length === 0) return undefined;

  const ranked = candidates
    .map((fact) => ({ fact, score: score(fact, nowMs) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, options.maxFacts)
    .map((entry) => entry.fact);

  // Budget over score order so the facts dropped are the lowest-scored, then re-sort survivors by key
  // for a stable, cacheable render.
  const kept: Fact[] = [];
  let used = 0;
  for (const fact of ranked) {
    const len = `- ${renderFact(fact)}`.length;
    if (used + len > options.charBudget && kept.length > 0) break;
    kept.push(fact);
    used += len;
  }
  if (kept.length === 0) return undefined;
  kept.sort((a, b) => (a.factKey < b.factKey ? -1 : a.factKey > b.factKey ? 1 : 0));

  const lines = kept.map((fact) => `- ${renderFact(fact)}`);
  return `${HEADER}\n${OPEN}\n${lines.join("\n")}\n${CLOSE}`;
}

function score(fact: Fact, nowMs: number): number {
  const ageHours = Math.max(0, (nowMs - fact.observedAt) / 3_600_000);
  const recency = Math.pow(0.5, ageHours / RECENCY_HALF_LIFE_HOURS);
  return WEIGHT_RECENCY * recency + WEIGHT_IMPORTANCE * fact.importance;
}

/**
 * Render one fact, surfacing conflict provenance when a prior value exists. Gated on superseded[] only,
 * not wall-clock, so the rendered bytes stay cache-stable until the fact itself changes.
 */
function renderFact(fact: Fact): string {
  const label = fact.factKey.replace(/_/g, " ");
  const base = `${label}: ${fact.value}`;
  const prior = fact.superseded[0];
  if (prior) {
    const where = fact.channel ? ` on ${fact.channel}` : "";
    return `${base} (updated${where}, was ${prior.value})`;
  }
  return base;
}

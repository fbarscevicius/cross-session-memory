import { clampInt, clampNumber, DEFAULT_OPTIONS } from "../core/defaults.js";
import type { Options } from "../core/defaults.js";

type OwnerConfigView = {
  commands?: { ownerAllowFrom?: ReadonlyArray<string | number> };
};

// Union of commands.ownerAllowFrom (seeded by pairing) and the plugin's own owners. Matching lives in owner.ts.
export function resolveOwnerEntries(
  config: OwnerConfigView | undefined,
  extraOwners: string[],
): Array<string | number> {
  const entries: Array<string | number> = [];
  for (const entry of config?.commands?.ownerAllowFrom ?? []) entries.push(entry);
  for (const entry of extraOwners) entries.push(entry);
  return entries;
}

export function resolveOptions(pluginConfig: Record<string, unknown> | undefined): Options {
  const cfg = pluginConfig ?? {};
  return {
    enabled: typeof cfg.enabled === "boolean" ? cfg.enabled : DEFAULT_OPTIONS.enabled,
    owners: Array.isArray(cfg.owners) ? cfg.owners.filter((o): o is string => typeof o === "string") : DEFAULT_OPTIONS.owners,
    minPromptChars: clampInt(cfg.minPromptChars, DEFAULT_OPTIONS.minPromptChars, 1, 1000),
    maxFacts: clampInt(cfg.maxFacts, DEFAULT_OPTIONS.maxFacts, 1, 100),
    charBudget: clampInt(cfg.charBudget, DEFAULT_OPTIONS.charBudget, 50, 8000),
    ttlHours: clampNumber(cfg.ttlHours, DEFAULT_OPTIONS.ttlHours, 1, 8760),
  };
}

import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { resolveAgentIdFromSessionKey } from "openclaw/plugin-sdk/routing";
import { resolveStateDir } from "openclaw/plugin-sdk/state-paths";
import { resolveOptions, resolveOwnerEntries } from "./adapter/config.js";
import { EXTRACTION_MAX_TOKENS, EXTRACTION_TEMPERATURE } from "./core/defaults.js";
import { inject } from "./core/inject.js";
import { observe } from "./core/observe.js";
import { buildOwnerMatcher, classifyOwnerEntries, matchesOwner } from "./core/owner.js";
import { FactStore } from "./core/store.js";

export default definePluginEntry({
  id: "cross-session-memory",
  name: "Cross-Session Memory",
  description:
    "Propagates durable, owner-stated facts between one agent's isolated channel sessions in near real-time via a shared fact store.",
  register(api) {
    const options = resolveOptions(api.pluginConfig);
    if (!options.enabled) return;

    // Resolve the owner allowlist per event, not once at register: the host swaps the config snapshot at
    // runtime (pairing seeds it, operators edit it), so a matcher frozen at register would go stale.
    const isOwner = (senderId: string | undefined | null, channel: string | undefined | null): boolean => {
      const entries = resolveOwnerEntries(api.runtime.config.current(), options.owners);
      return matchesOwner(buildOwnerMatcher(entries), channel, senderId);
    };

    // Warn loudly at register: a bare id never matches and an empty set never propagates, both silent otherwise.
    const { scoped, bare } = classifyOwnerEntries(resolveOwnerEntries(api.runtime.config.current(), options.owners));
    if (bare.length > 0) {
      api.logger.warn?.(
        `cross-session-memory: ${bare.length} non-channel-scoped owner id(s) ignored [${bare.join(", ")}]; ` +
          `scope each per channel (e.g. "slack:U123", "whatsapp:+15551234567") or it will never match`,
      );
    }
    if (scoped.length === 0) {
      api.logger.warn?.(
        "cross-session-memory: 0 channel-scoped owner id(s) resolved; nothing will propagate until " +
          "commands.ownerAllowFrom (or the plugin's owners) lists a scoped id",
      );
    } else {
      api.logger.info?.(`cross-session-memory: ${scoped.length} channel-scoped owner id(s) resolved`);
    }

    const dir = join(resolveStateDir(), "cross-session-memory");
    mkdirSync(dir, { recursive: true });
    const store = new FactStore(join(dir, "facts.sqlite"));

    const now = (): number => Date.now();
    // No agentId or model: the host facade throws on an override unless the operator grants it, so
    // omitting both makes forwarding one impossible. Extraction resolves the gateway's default agent model.
    const complete = async (params: { system: string; user: string }): Promise<string> => {
      const result = await api.runtime.llm.complete({
        messages: [{ role: "user", content: params.user }],
        systemPrompt: params.system,
        maxTokens: EXTRACTION_MAX_TOKENS,
        temperature: EXTRACTION_TEMPERATURE,
        purpose: "cross-session-memory fact extraction",
      });
      return result.text;
    };

    // One before_prompt_build hook (a prompt-injection hook, allowed by default; a conversation hook
    // would need allowConversationAccess). Injection returns prependSystemContext, the cacheable surface.
    api.on("before_prompt_build", (event, ctx) => {
      // Prefer the host's authoritative resolved agent id; derive from sessionKey only if absent.
      const agentId = ctx.agentId?.trim() || resolveAgentIdFromSessionKey(ctx.sessionKey);

      // Write path: fire-and-forget, timeout-bounded, with detached error containment.
      void observe(
        { store, complete, now, isOwner, options },
        {
          prompt: event.prompt,
          senderId: ctx.senderId,
          agentId,
          sessionKey: ctx.sessionKey,
          channel: ctx.channel,
        },
      )
        .then((outcome) => {
          if (outcome.kind === "wrote") {
            api.logger.debug?.(`cross-session-memory: wrote ${outcome.ops} fact(s) for ${agentId}`);
          } else if (outcome.kind === "owner-skip") {
            api.logger.debug?.(
              `cross-session-memory: owner-gate closed for sender=${ctx.senderId ?? "?"} channel=${ctx.channel ?? "?"}`,
            );
          }
        })
        .catch((error: unknown) => {
          const message = error instanceof Error ? error.message : String(error);
          api.logger.warn?.(`cross-session-memory: observe failed: ${message.replace(/\s+/g, " ")}`);
        });

      // Read path: synchronous, no model call. Cacheable system context, direct-message only.
      const block = inject(
        { store, now, isOwner, options },
        { senderId: ctx.senderId, channel: ctx.channel, agentId, sessionKey: ctx.sessionKey },
      );
      return block ? { prependSystemContext: block } : undefined;
    });
  },
});

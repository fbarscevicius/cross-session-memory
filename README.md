# cross-session-memory

A standalone OpenClaw plugin that propagates durable, owner-stated facts between one agent's
isolated channel sessions in near real time. It observes each turn's incoming prompt, distills facts
into a shared per-agent SQLite store, and on the owner's next turn in another session injects a short
reference slice, ranked by recency and importance, as cacheable system context. The slice is
size-budgeted and fenced as lower-authority reference, not instructions. Sessions never share a
conversation window; they coordinate only through the store (the blackboard pattern). Installation
needs no fork and no core change, on stock OpenClaw, through the public `before_prompt_build` hook
and `api.runtime.llm.complete`.


## Requirements

The plugin needs OpenClaw as a peer dependency, pinned to a tested release range, and Node 22.19 or
newer (24 recommended).

## Install

```
openclaw plugins install cross-session-memory
```

Then restart your gateway.

## When it does anything (precondition)

At the default `session.dmScope = "main"`, every direct message across every channel collapses to
one session, so there is nothing to propagate and the plugin is correctly inert. It does work when
the owner's direct-message sessions diverge, which happens when `dmScope` is `per-channel-peer` or
`per-account-channel-peer` (or `per-peer`).

To see propagation, set a non-main `dmScope` and configure the owner per channel
(`commands.ownerAllowFrom`).

## Disabling cross-channel context sharing

A non-main `dmScope` splits the conversation windows, but it does not isolate channels on its
own. OpenClaw carries context across an agent's channels through a second, independent path: the
agent's workspace bootstrap files (`MEMORY.md`, `USER.md`, `AGENTS.md`, and the rest). They live
per agent, the host injects them into every session's system prompt, and the embedded agent records
durable facts into `MEMORY.md` itself through its file tools. So with only `dmScope` set, a fact the
agent writes down on one channel still reaches the others through that shared workspace memory, with
no involvement from this plugin.

For the owner's channel sessions to share nothing but this plugin's scoped facts (for an A/B test,
or as the intended deployment), disable the workspace bootstrap injection as well:

```json
{
  "session": { "dmScope": "per-channel-peer" },
  "agents": { "defaults": { "contextInjection": "never" } }
}
```

`contextInjection: "never"` stops the per-agent workspace markdown from being injected into prompts,
and this plugin's injection rides a separate `before_prompt_build` hook, so it keeps working: the
system prompt shrinks by the size of the bootstrap files while the plugin still propagates. The switch
is all-or-nothing for bootstrap files, so it also drops the agent's persona (`AGENTS.md`, `SOUL.md`,
`IDENTITY.md`). That is part of why it isolates: with no `AGENTS.md` telling the agent to maintain
`MEMORY.md`, it has no standing reason to write stated facts to disk, so the store stays the only path
a fact crosses channels.

The agent still holds its filesystem tools and can touch the workspace on its own initiative. Without
the persona it does not persist stated facts in practice, but that is model-dependent. For a hard
guarantee that nothing travels by file, deny the agent's filesystem tools (`agents.<id>.tools`), which
holds even with the persona left on.

A bundled memory plugin (for example `active-memory`) is a third per-agent path; set
`plugins.slots.memory: "none"` to remove it as well.

## Owner gating

Reads and writes are gated to the owner. The owner is `commands.ownerAllowFrom` plus any extra
`owners` in plugin config. Ids are lowercased and matched in their channel-scoped form
(`slack:U12345678`).

Two prerequisites for cross-channel recall, both hard:

1. A non-main `dmScope` (see the precondition above), so the owner's sessions actually diverge.
2. The owner's id enumerated for each channel they use. OpenClaw has no built-in cross-channel human
   identity, so the same person has a different raw id on each channel (a Slack `U`-prefixed id, a
   WhatsApp phone number, a Telegram numeric id). To be recognized on every channel, list the scoped id for
   each one, for example `["slack:U123", "whatsapp:+15551234567", "telegram:12345"]`. An owner
   configured only as `slack:U123` is recognized on Slack only.

Matching is channel-scoped only. A bare, unscoped id (`12345`) is deliberately not honored, because
bare sender ids share a namespace across channels: Telegram and Discord both use bare numeric ids,
so a bare owner `12345` would also match an unrelated person who is user `12345` on another channel.
That would poison the owner's store and leak the owner's private facts into a stranger's session.
Scope every owner id to its channel.

A wildcard (`*`) is also not honored. The host treats `*` in `commands.ownerAllowFrom` as allow-all
for command authorization, but this plugin fails closed on it: `*` matches no sender and shares no
memory. Honoring it would turn a privacy-scoped per-owner store into a promiscuous cross-user one
inherited from an unrelated setting. Configure a concrete owner id.

This matching is intentionally stricter than the host's command-auth allowlist, which also accepts
bare ids. Because the divergence could otherwise fail silently, the plugin logs at register: a `warn`
naming any bare ids it ignored (with the fix), and a `warn` when zero scoped owners resolve (nothing
will propagate). The owner allowlist is also re-read on every turn, so an owner seeded by pairing or
edited after startup takes effect without a gateway restart.

Injection is direct-message only. The owner's private cross-session memory is never injected into a
group or channel turn, where it would shape a reply broadcast to other people. Group turns are
identified by the session key and skipped on the read path.

This plugin stores one memory partition per agent. More than one human listed in
`commands.ownerAllowFrom` (or `owners`) share that single partition and can read each other's facts.
It is built for one human across channels; for a hard split between people, use separate agents.

Channel id shapes beyond the `channel:id` form (for example phone-number senders) should be verified
against one live message to confirm the scoped form matches.

## Configuration

Set under `plugins.entries.cross-session-memory.config`:

| Key | Type | Default | Meaning |
|---|---|---|---|
| `enabled` | boolean | `true` | When false, the plugin registers nothing. |
| `owners` | string[] | `[]` | Extra owner sender ids, merged with `commands.ownerAllowFrom`. Channel-scoped (`slack:U123`); bare and `*` are not honored. |
| `minPromptChars` | integer | `4` | Length floor; shorter fragments are rejected as noise for free. The all-chatter denylist and emoji/punctuation check do the real noise filtering. |
| `maxFacts` | integer | `8` | Maximum facts injected per turn. |
| `charBudget` | integer | `600` | Character budget for the injected reference block. |
| `ttlHours` | number | `72` | Facts older than this are not injected and are pruned. |

Extraction runs through the plugin completion facade, which is not bound to the conversation's agent,
so it resolves the gateway's default agent model (in a single-agent install that is simply the
agent's model). There is no model override knob: the host rejects (throws) a plugin attempt to
override the target model or agent unless the operator grants it
(`plugins.entries.<id>.llm.allowModelOverride` / `allowAgentIdOverride`), so the plugin does not try.

## Build and test

```
corepack pnpm install
corepack pnpm run typecheck
corepack pnpm run test
corepack pnpm run build
```

The published package ships compiled JavaScript in `dist/`; the gateway loads
`openclaw.runtimeExtensions` (`./dist/index.js`). Its pure core under `src/core` imports only
`node:sqlite` and `node:crypto`, so the tests run with no OpenClaw build or install.

## Cost notes

The injected fact block is returned as `prependSystemContext`, which the host places inside the
cached system-prompt prefix, so a turn whose fact set is unchanged is not re-billed. Ranked by
recency and importance and rendered in a stable key order, the block stays byte-stable as long as the
selected set does. Two caveats: the block carries the cache breakpoint, so when the set does
change the base system prompt is re-billed that turn; and because the set is the top facts by a
decaying score, once an owner has more live facts than fit the budget, recency decay and TTL expiry
can change which facts are selected between turns even with no new fact, which busts the cache that
turn. The single per-turn model cost is one small extraction completion, on owner turns that clear
the free noise filter, bounded by an internal timeout so a hung completion cannot stall in the
background.

## Limitations (deliberately out of scope)

- Idle-session wake (pushing into a channel the user is not currently using).
- Multi-user-per-agent scoping. Scope is per agent; a hard work/personal split is separate agents.
- Semantic relevance ranking. Recency and importance ranking is the v1.
- Group and channel turns are a capture source (the owner's own messages) but never an injection
  target, to keep private memory out of multi-recipient turns.
- Cross-channel recognition requires the owner's id enumerated per channel (see "Owner gating");
  OpenClaw provides no automatic cross-channel identity.

## What it does not capture (by design)

The plugin captures one thing: facts the owner states in their own messages, propagated across the
owner's channels. Two adjacent capabilities are intentionally excluded.

**The assistant's own replies** (so a metric the bot states would propagate cross-channel) are not
captured. The only hook that carries assistant output, `llm_output`, is a host conversation hook: a
non-bundled plugin cannot register it without the operator setting `hooks.allowConversationAccess=true`,
so such a feature would be silently inert on a stock install. Reply facts also carry risks the user
path does not: a bot reply distilled with full owner authority can overwrite a fact the user explicitly
stated (conflict resolution is by timestamp), the store does not record whether a fact came from the
user or the bot, and the values most worth capturing from replies (live metrics and counts) are
exactly the volatile data a durable, TTL-bounded store serves stale.

**Facts another human states** (a contact in a group chat) are not captured. A contact's message is
attacker-controlled, so storing it into the owner's cross-session memory is a prompt-injection vector;
and because a group reply is broadcast to everyone, injecting the owner's private cross-channel memory
into a group turn can leak it (which is why injection is direct-message only). Supporting contacts
safely would require explicit per-channel opt-in, a record of who said each fact ("contact X said
Y"), and direct-message-only injection, which is a larger feature than single-user continuity.

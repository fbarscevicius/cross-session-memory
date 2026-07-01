# cross-session-memory

**Cross-channel memory for one OpenClaw agent, built from the durable facts you
state.** You talk to the same [OpenClaw](https://github.com/openclaw/openclaw)
agent on Slack, WhatsApp, and Telegram. By default OpenClaw keeps continuity
across those channels by pooling them into one session, so every turn on every
channel reads the full conversation history from all of them. That works, but for
a heavy user the shared transcript grows long, noisy, and expensive: unrelated
chatter from three channels sits in the context window of a fourth, and every turn
re-pays for the whole pile. cross-session-memory keeps the same continuity on a
fraction of the context. It distills the durable facts you state, keeps them in a
shared per-agent store, and hands each of your other sessions a short, ranked
reference slice of just those facts on your next turn there.

A standalone OpenClaw plugin. No fork and no core patch: it rides the public
`before_prompt_build` hook on a stock gateway. MIT licensed.

---

## The problem

One agent, many channels, and by default one shared pool of context behind them.
To let the agent remember across channels, OpenClaw's default `dmScope = "main"`
routes every direct message into a single session, so the Slack thread, the
WhatsApp thread, and the Telegram thread all append to and read from one growing
transcript. That buys continuity at a price that scales with use: the context
window fills with every channel's history, every turn re-bills the accumulated
pile, and noise from one channel shapes replies on another. Tell it on Telegram
that you are AB+ and flying to Lisbon on Friday, and Slack has that fact, wrapped
in every unrelated Telegram message that came with it.

The blunt alternatives trade one problem for another. Split the sessions so each
channel is clean, and the agent forgets across them. Route everything through a
hand-maintained memory file, and you are back to bookkeeping.

## What it does

cross-session-memory keeps the cross-channel continuity and pays only for what
matters: the small set of durable facts you state, and only those. Four
commitments shape it:

- **Only facts you state, only yours.** Every read and write is owner-gated to
  your channel-scoped ids. A contact's message in a group is never stored, and
  your private memory is never injected into a group turn where it would reach
  other people.
- **Sessions coordinate through a store, not a shared window.** Each session
  keeps its own conversation. They meet only at a per-agent SQLite store, the
  blackboard pattern, so nothing about one thread crosses into another beyond the
  facts you chose to state.
- **Injected as fenced reference.** The slice is marked context-only under an
  explicit non-instruction header, with the frame tokens stripped from stored
  values, so a stored fact can neither forge the fence nor smuggle a directive
  across the session boundary.
- **Cheap and near real time.** A single small extraction runs on your turns that
  clear a zero-cost noise filter. The injected block sits inside the cached
  system-prompt prefix, so a turn whose fact set is unchanged is not re-billed.

## How it works

```
Observe   Every turn's incoming prompt passes through one before_prompt_build hook.
Gate      Owner-gated and channel-scoped; non-owners and group turns drop for free.
Distill   Owner turns that clear the noise filter get one small extraction pass into
          durable { key, value, importance } facts, deduped by content hash.
Store     Facts land in a per-agent SQLite store. A restated fact updates in place;
          conflicts resolve by timestamp.
Inject    On your next turn in another direct session, the store returns a slice
          ranked by recency x importance, TTL-filtered and budget-capped, as
          cacheable system context.
```

The write path is fire-and-forget and time-bounded, so a slow extraction can
never stall a turn. Reads make no model call at all. Its pure core under
`src/core` imports only `node:sqlite` and `node:crypto`, so its tests run with no
OpenClaw build or install.

## Requirements

OpenClaw as a peer dependency, pinned to a tested release range, and Node 22.19
or newer (24 recommended).

## Install

```
openclaw plugins install cross-session-memory
```

Then restart your gateway.

## Turning off the default sharing (required)

The plugin is the lean replacement for OpenClaw's shared-context default, and it
does not switch that default off for you. Two paths carry context across an
agent's channels; both stay on until you disable them, and until you do, the
plugin has nothing to add over what the pooled session already shares.

**1. Split the pooled session.** At the default `session.dmScope = "main"`, every
direct message across every channel collapses into one session, which is the big
shared transcript itself. There is nothing left for the plugin to propagate, so it
is correctly inert. Give each channel its own session so the pooling stops:

```json
{ "session": { "dmScope": "per-channel-peer" } }
```

(`per-account-channel-peer` and `per-peer` also diverge the owner's sessions.) On
its own this makes each channel clean and forgetful, which is where the plugin
takes over: it rides a separate hook and starts propagating your stated facts
across the now-isolated sessions.

**2. Turn off the workspace bootstrap injection.** Splitting the session leaves a
second shared path: the agent's workspace bootstrap files (`MEMORY.md`, `USER.md`,
`AGENTS.md`, and the rest), which the host injects into every session and the
agent can write to itself. So a fact the agent records in `MEMORY.md` on one
channel still reaches the others, and you still pay for those files on every turn.
Switch that injection off so the plugin's scoped facts are the only thing your
sessions share:

```json
{
  "session": { "dmScope": "per-channel-peer" },
  "agents": { "defaults": { "contextInjection": "never" } }
}
```

This plugin rides a separate hook, so it keeps propagating while the shared
workspace memory goes quiet. The switch is all-or-nothing for bootstrap files, so
it also drops the agent's persona; with no `AGENTS.md` telling the agent to
maintain `MEMORY.md`, it has no standing reason to persist facts to disk, which is
part of why the isolation holds. For a hard guarantee that nothing travels by
file, deny the agent's filesystem tools (`agents.<id>.tools`). A bundled memory
plugin is a third path; set `plugins.slots.memory: "none"` to remove it.

With both paths off, the only thing crossing your channels is the plugin's ranked
slice of durable facts: continuity at the cost of a handful of facts per turn
instead of the full pooled transcript.

## Owner setup

Reads and writes are gated to the owner, matched in channel-scoped form
(`slack:U12345678`). Two prerequisites for cross-channel recall, both hard:

1. A non-main `dmScope`, so the owner's sessions actually diverge.
2. The owner's id enumerated for each channel they use. OpenClaw has no built-in
   cross-channel identity, so the same person carries a different raw id on each
   channel. List the scoped id for every one, for example
   `["slack:U123", "whatsapp:+15551234567", "telegram:12345"]`. An owner listed
   only as `slack:U123` is recognized on Slack alone.

To find each scoped id, pairing is the simplest source: have the owner DM the bot
once, then `openclaw pairing list --channel <channel>` and
`openclaw pairing approve <channel> <code>`. Approving prints the scoped id and,
when `commands.ownerAllowFrom` is empty, seeds that first id for you. Add the
remaining channels yourself, in `commands.ownerAllowFrom` (host-wide, also governs
command access) or the plugin's own `owners` (the two lists merge):

```json
{ "commands": { "ownerAllowFrom": ["telegram:12345", "discord:67890", "slack:U123"] } }
```

No restart is needed; the allowlist is re-read every turn, so an owner seeded by
pairing or edited after startup takes effect immediately. At register the plugin
warns loudly if it resolved zero scoped ids or ignored any bare one, so a silent
misconfiguration surfaces.

**Why scoped ids only.** A bare id (`12345`) is deliberately rejected, because
bare sender ids share a namespace across channels: Telegram and Discord both use
bare numeric ids, so a bare owner `12345` would also match an unrelated person who
is user `12345` elsewhere, poisoning your store and leaking your facts into a
stranger's session. A wildcard (`*`) is rejected for the same reason; the plugin
fails closed on it rather than turn a per-owner store into a promiscuous
cross-user one. This is stricter than the host's command-auth allowlist by design.

## Configuration

Set under `plugins.entries.cross-session-memory.config`:

| Key | Type | Default | Meaning |
|---|---|---|---|
| `enabled` | boolean | `true` | When false, the plugin registers nothing. |
| `owners` | string[] | `[]` | Extra owner sender ids, merged with `commands.ownerAllowFrom`. Channel-scoped only; bare and `*` are ignored. |
| `minPromptChars` | integer | `4` | Length floor; shorter fragments are rejected as noise for free. |
| `maxFacts` | integer | `8` | Maximum facts injected per turn. |
| `charBudget` | integer | `600` | Character budget for the injected reference block. |
| `ttlHours` | number | `72` | Facts older than this are neither injected nor kept. |

Extraction resolves the gateway's default agent model. There is no model-override
knob: the host rejects a plugin's attempt to override the target model or agent
unless the operator grants it, so the plugin does not try.

## Cost and caching

Returned as `prependSystemContext`, the block lands inside the host's cached
system-prompt prefix and renders in a stable key order, so an unchanged fact set
is byte-stable and not re-billed. Two caveats are worth stating: a changed set
re-bills the base system prompt that turn, because the block carries the cache
breakpoint; and once you hold more live facts than fit the budget, recency decay
and TTL expiry can shift which facts are selected between turns even with no new
fact, which busts the cache. The only per-turn model cost is one small
extraction, on owner turns that clear the free noise filter, bounded by an
internal timeout.

## Design notes

The plugin captures exactly one thing: durable facts you state in your own
messages, propagated across your own channels. Two adjacent capabilities are left
out on purpose, and the reasons are the point.

- **The assistant's own replies are not captured.** The only hook that carries
  assistant output is a host conversation hook a non-bundled plugin cannot
  register on a stock install, so the feature would be silently inert. It also
  carries risks the user path does not: a reply distilled with full owner
  authority could overwrite a fact you stated, and the values worth capturing from
  replies (live metrics and counts) are exactly the volatile data a durable,
  TTL-bounded store serves stale.
- **Facts another human states are not captured.** A contact's message is
  attacker-controlled, so storing it into your memory is a prompt-injection vector,
  and a group reply is broadcast, so injecting your private memory there can leak
  it. Supporting contacts safely would need per-channel opt-in, attribution of who
  said each fact, and direct-message-only injection, a larger feature than
  single-user continuity.

The theme across both: a cross-session memory is a security surface first and a
convenience second. Every gate here fails closed, treats model and contact output
as hostile, and keeps private memory off any multi-recipient turn.

## Limitations

- Recency and importance ranking is the v1; semantic relevance is not in yet.
- Scope is per agent. A hard split between two people is two agents, not two
  owners in one store.
- No idle-session wake; the plugin injects on your next turn in a session, it does
  not push into a channel you are not using.
- Cross-channel recognition needs the owner's id enumerated per channel, since
  OpenClaw provides no automatic cross-channel identity.

## Build and test

```
corepack pnpm install
corepack pnpm run typecheck
corepack pnpm run test
corepack pnpm run build
```

The published package ships compiled JavaScript in `dist/`, loaded by the gateway
through `openclaw.runtimeExtensions`. Its core carries its own unit and
integration tests (conflict resolution, idempotency, owner gating, noise
filtering, propagation) that run without OpenClaw present.

## Credit

The coordination model is the classic blackboard pattern: independent agents that
never talk directly and instead read and write a shared store. Here the isolated
channel sessions are the agents and the per-agent SQLite store is the blackboard.

## License

MIT.

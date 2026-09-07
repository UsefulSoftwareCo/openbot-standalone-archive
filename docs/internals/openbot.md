# OpenBot channels

OpenBot is a second client of the same server, served from `apps/openbot`. It is
a channel-based chat over Orchestrator v2. The app owns the channel profile, mapping, and
the delivery contract; it does not own an agent loop or a scheduler.

## Model

- A channel is one v2 thread inside one server-owned project rooted at
  `<state dir>/openbot`, which is initialized as its own git repository so run
  checkpoints behave the same as in a normal project. The mapping lives in
  [`openbot_channels`](../../apps/server/src/persistence/Migrations/060_OpenbotChannels.ts).
- Sending into a channel dispatches `message.dispatch` with `queue_after_active`
  and `joinQueuedRun` through
  [`ThreadManagementService.sendToThread`](../../apps/server/src/orchestration-v2/ThreadManagementService.ts).
  The orchestrator's per-thread lock and queue promotion are the only scheduler:
  one active run per thread, one queued run promoted after each terminal run.
  Steering and restart are deliberately not used.
- Messages that arrive while a run is active are grouped, not queued one per
  run. `joinQueuedRun` is an opt-in on the dispatch command: when a run is
  already queued, the new message is stored against that run's root node
  instead of creating another run. Promotion emits a user turn item per grouped
  message, and
  [`ProviderTurnStartService`](../../apps/server/src/orchestration-v2/ProviderTurnStartService.ts)
  builds the prompt from every message on the run, each in its own
  `<user_message id="…">` block, so the agent can address one of them. The
  join decision is made under the thread lock against the run's current
  status, so a message that lands after promotion queues a fresh run. Ordinary
  threads never set the flag and keep one queued run per message.
- User-visible replies are explicit. The agent calls `openbot_send_message`
  (or `openbot_skip_reply` for an intentional non-reply) on the `t3-code` MCP
  server, scoped to the calling thread by its credential. Deliveries are stored
  in `openbot_deliveries` keyed by run and appear in the channel as soon as
  they are recorded, while the run is still active. Ordinary assistant text is
  never shown in the channel, and a skip records nothing user-visible.
- A delivery may carry a reply target: an accepted user message on the channel
  thread or an earlier message delivery in the same channel. The service
  resolves the agent-supplied id against the calling channel only and rejects
  anything else, so a reference cannot point across channels. A retried
  request key replays the first recording and is rejected if its text or
  target differ, so a retry can never silently change what the person saw.
- The [channel view](../../apps/server/src/openbot/OpenbotChannelService.ts)
  still derives each incoming message's state and outcome from the v2
  projection plus deliveries. Those fields are internal bookkeeping for
  correctness; the client shows only genuine failures and a channel-level
  activity indicator, never queue or scheduling state. A direct reply settles
  its target message; a general message or a skip during the run settles every
  message that run consumed.

## Provider instructions

[`ProviderTurnInstructionsV2`](../../apps/server/src/orchestration-v2/TurnInstructions.ts)
is a reference the turn-start path resolves for every root run. OpenBot provides
it to wrap the provider prompt with the delivery contract for channel threads,
including how to handle a grouped turn. The default resolves to nothing, so
ordinary threads are unchanged and the stored user message is never altered.

Each channel's main thread owns standing instructions and durable Markdown
knowledge in `openbot_thread_context`. They are independent of provider session
history. Existing channels start empty at revision zero; migration 62 adds a
table without rewriting messages or deliveries. The context editor reads and
writes through separate RPCs, so channel subscriptions do not broadcast the
knowledge. Every update compares the expected revision in one SQL statement.
A stale writer must reload and merge; it cannot overwrite newer context.

The agent can read context with `openbot_get_context` and replace knowledge with
`openbot_update_knowledge`. The latter preserves user-owned instructions. Child
threads inherit their main thread's context through the thread lineage, but
return ordinary task results instead of taking on the channel delivery contract.
Context is loaded before a run is marked running; a failed read cannot start a
provider turn without its standing instructions.

## Peer requests

Main threads can call `openbot_request_thread` with a peer channel and a stable
request key. Each turn includes the current peer directory for the same project.
The service dispatches through the existing v2 queue and durable command receipt;
there is no second message worker or inbox. Peer messages carry a stored sender,
request id, and request/reply type. They cannot join a queued group of user messages.

`openbot_reply_to_thread` resolves the original sender from a request stored on
the calling thread. It sends one reply and wakes that sender in a later turn.
Stable message ids make retries safe; readback rejects a changed body. Peer
requests remain separate from child work and do not grant user authorization.
They appear in the v2 trace, while the chat shows only explicit user deliveries.

Routines reuse `ScheduledTaskService` with the main thread as their target.
OpenBot imports set `deliveryMode: "queue"` so a scheduled wake waits behind
active work. Migration 63 preserves `auto` for existing T3 routines. Updates
that omit the mode retain the saved choice. Fixed-time routines use the server's
local time zone.

## Profiles and files

The channel profile is the source of the model selection for incoming user and
peer messages. Each dispatch carries that selection, so profile edits do not
interrupt an active run. Routines retain their own stored model choice. Profile
revisions are separate from knowledge revisions to avoid conflicts with agent
memory updates.

OpenBot claims uploads with a stable message key and checks accepted messages
before touching their files on retries. Output files are copied into attachment
storage; delivery Markdown carries a typed attachment reference, not an expiring
URL or a host path. Each client obtains its own signed URL through the existing
asset service, so downloads work across connection origins and workspace edits.

## Client

The app reuses `packages/client-runtime` for the connection runtime and RPC
atoms, and `packages/ui` for shared primitives and the design tokens that were
extracted from `apps/web/src/index.css`. It authenticates with the same-origin
session cookie: `vp run dev:openbot` proxies `/api`, `/oauth`, `/.well-known`,
and `/ws` to the backend, and the server's pairing link signs the browser in.

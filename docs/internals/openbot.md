# OpenBot channels

OpenBot is a second client of the same server, served from `apps/openbot`. It is
a channel-based chat over Orchestrator v2. The app owns the channel mapping and
the delivery contract; it does not own an agent loop or a scheduler.

## Model

- A channel is one v2 thread inside one server-owned project rooted at
  `<state dir>/openbot`, which is initialized as its own git repository so run
  checkpoints behave the same as in a normal project. The mapping lives in
  [`openbot_channels`](../../apps/server/src/persistence/Migrations/060_OpenbotChannels.ts).
- Sending into a channel dispatches `message.dispatch` with `queue_after_active`
  through [`ThreadManagementService.sendToThread`](../../apps/server/src/orchestration-v2/ThreadManagementService.ts).
  The orchestrator's per-thread lock and queue promotion are the only scheduler:
  one active run per thread, queued runs promoted one at a time after each
  terminal run, in order. Steering and restart are deliberately not used.
- User-visible replies are explicit. The agent calls `openbot_send_message`
  (or `openbot_skip_reply` for an intentional non-reply) on the `t3-code` MCP
  server, scoped to the calling thread by its credential. Deliveries are stored
  in `openbot_deliveries` keyed by run. Ordinary assistant text is never shown
  in the channel.
- The [channel view](../../apps/server/src/openbot/OpenbotChannelService.ts)
  derives each incoming message's state (`pending`, `working`, `handled`,
  `failed`) and outcome (`replied`, `silent`, `no_reply`, `failed`) from the v2
  projection plus deliveries, so accepted input is tracked independently of
  reply count and an unanswered request is visible rather than hidden.

## Provider instructions

[`ProviderTurnInstructionsV2`](../../apps/server/src/orchestration-v2/TurnInstructions.ts)
is a reference the turn-start path resolves for every root run. OpenBot provides
it to wrap the provider prompt with the delivery contract for channel threads.
The default resolves to nothing, so ordinary threads are unchanged and the
stored user message is never altered.

## Client

The app reuses `packages/client-runtime` for the connection runtime and RPC
atoms, and `packages/ui` for shared primitives and the design tokens that were
extracted from `apps/web/src/index.css`. It authenticates with the same-origin
session cookie: `vp run dev:openbot` proxies `/api`, `/oauth`, `/.well-known`,
and `/ws` to the backend, and the server's pairing link signs the browser in.

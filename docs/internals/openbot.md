# OpenBot channels

OpenBot is a second client of the same server, served from `apps/openbot`. It is
a channel-based chat over Orchestrator v2. The app owns the channel profile, mapping, and
the delivery contract; it does not own an agent loop or a scheduler.

## Model

- A chat is one v2 thread. Every chat is the same primitive; its role is
  derived, not stored. A chat with a parent is a _child_; a chat an OpenBot
  project points at is that project's _main_ chat; anything else is
  _standalone_. Nesting stops at one level, so a child never owns children and
  the tree can be rendered without recursion. The mapping lives in
  [`openbot_channels`](../../apps/server/src/persistence/Migrations/060_OpenbotChannels.ts).
- A **product project** is not a working directory. `openbot_projects` records
  the product concept and points at one T3 project that owns the cwd. A
  `managed` workspace is an app-owned directory under
  `<state dir>/openbot/projects/`, which sits inside the OpenBot workspace git
  repository, so a project needs no user folder and still checkpoints normally.
  An `attached` workspace is a user folder used exactly as it is: never moved,
  never `git init`ed. Multiple OpenBot projects can share a folder while keeping
  distinct T3 project identities. A chat's
  project is derived by joining `openbot_projects.t3_project_id`, so a main
  chat and its children can never disagree about which project they are in.
- The shared `<state dir>/openbot` project remains the workspace for standalone
  chats. It is initialized as its own git repository so run checkpoints behave
  the same as in a normal project.
- Knowledge in `openbot_knowledge` has stable identity and lives beside chats
  rather than inside one. `openbot_knowledge_projects` links an entry to the
  projects it is relevant to; links guide retrieval and never grant access. The
  turn prompt carries the linked entries in full while they fit the budget, then
  degrades to titles plus an excerpt rather than truncating silently.
- Requests reach a project's main chat or a standalone chat across project
  boundaries; a child chat can never be targeted directly, because its work is
  the parent's to direct. Parent and child exchange messages along their own
  edge with `openbot_send_to_thread`. All three paths reuse the one peer
  dispatch, so ids, readback, and reply routing are identical.
- Pending questions and approvals reach the client on the channel view. The
  server derives them from the v2 projection the same way
  `derivePendingThreadRequests` does for T3's own client; the derivation is
  duplicated rather than shared because the server never imports
  `client-runtime`. Answers go back through `runtime-request.respond`, so the
  approval and question semantics are T3's, unchanged.
- Snooze, wake, cancel, and model selection are thin adapters over the existing
  v2 commands. OpenBot adds no wake rules of its own.
- Sending into a channel dispatches `message.dispatch` with `queue_after_active`
  and `joinQueuedRun` through
  [`ThreadManagementService.sendToThread`](../../apps/server/src/orchestration-v2/ThreadManagementService.ts).
  The orchestrator's per-thread lock and queue promotion are the only scheduler:
  one active run per thread, one queued run promoted after each terminal run.
  A snoozed thread parks agent-initiated messages (peer requests and replies)
  as queued runs; they start on the user's wake, on the next user message, or
  when the settlement service's one-minute tick finds the snooze deadline has
  passed. Only a direct user send clears a snooze.
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

## Agent tools

Everything a person can do in the OpenBot UI, an agent can do through the
`t3-code` MCP server, and both go through the same
[`OpenbotChannelServiceShape`](../../apps/server/src/openbot/OpenbotChannelService.ts)
operation. There is deliberately no agent-side copy of the validation, the
idempotency keys, or the compare-and-swap rules; a tool handler resolves the
calling thread from its MCP credential and calls the operation the RPC calls.

| UI capability                  | Service operation                     | Agent tool                                            |
| ------------------------------ | ------------------------------------- | ----------------------------------------------------- |
| New chat                       | `create`                              | `openbot_create_chat`                                 |
| Chat settings                  | `update`                              | `openbot_update_chat`                                 |
| Project list                   | `listProjects`                        | `openbot_list_projects`                               |
| New project                    | `createProject`                       | `openbot_create_project`                              |
| Project settings               | `updateProject`                       | `openbot_update_project`                              |
| Project icon picker            | -                                     | `openbot_search_icons`                                |
| Knowledge list                 | `listKnowledge`                       | `openbot_knowledge_list`                              |
| Knowledge editor (read)        | `getKnowledge`                        | `openbot_knowledge_read`                              |
| Knowledge editor (save)        | `createKnowledge` / `updateKnowledge` | `openbot_knowledge_write`                             |
| Knowledge delete               | `deleteKnowledge`                     | `openbot_knowledge_delete`                            |
| New child chat with a task     | `startThread`                         | `openbot_start_thread`                                |
| Message a child or parent chat | `sendToThread`                        | `openbot_send_to_thread`                              |
| Chat sidebar                   | `listThreads`                         | `openbot_list_threads`                                |
| Snooze / unsnooze              | `snooze` / `wake`                     | `openbot_snooze_thread` / `openbot_wake_thread`       |
| Stop                           | `cancel`                              | `openbot_cancel_thread`                               |
| Model picker                   | `setModel`                            | `openbot_set_model`                                   |
| Chat knowledge                 | `getContext` / `updateContext`        | `openbot_get_context` / `openbot_update_knowledge`    |
| Chat instructions              | `getContext` / `updateContext`        | `openbot_get_context` / `openbot_update_instructions` |
| Ask another chat               | `requestThread` / `replyToThread`     | `openbot_request_thread` / `openbot_reply_to_thread`  |
| Reply in the chat              | `recordDelivery`                      | `openbot_send_message` / `openbot_skip_reply`         |
| Attach an output file          | `prepareFile`                         | `openbot_prepare_file`                                |

Two vocabularies meet at this boundary. `OpenbotError` carries the domain codes;
`OpenbotMcpFailure` carries the smaller set an agent can act on, so a code only
exists where a tool description can name the recovery. `*_not_found` collapses to
`not_found`, every compare-and-swap and duplicate-request conflict collapses to
`request_conflict` (read again, merge, retry), `nesting_not_allowed` survives
because the agent must stop rather than retry, and everything else is an opaque
`operation_failed`. Adding a domain code without deciding its agent-facing code
silently makes it `operation_failed`.

Project icon names are checked against
[`OPENBOT_ICON_NAMES`](../../packages/contracts/src/openbotIcons.generated.ts), the
list the picker offers, not just against the PascalCase shape. A name that merely
looks like an icon (`Telescope`) used to pass, get stored, and then draw the
fallback glyph with nothing telling the agent it was wrong. The list is generated
from the `@phosphor-icons/react` copy installed for `apps/openbot`, because
contracts must not take a runtime dependency on ~5 MB of icon components; the
picker reads the same list, so an agent and a person cannot be offered different
names. `openbot_search_icons` exists because a rejection is only useful with a way
to find a real name.

A tool with no parameters must omit `parameters` rather than pass
`Schema.Struct({})`: the empty struct serialises to an `anyOf` instead of an
object schema, and one non-object input schema makes MCP clients reject the whole
server. `apps/server/src/mcp/toolkits/worktree/registration.test.ts` asserts this
across every registered toolkit.

## Computer

Each top-level chat (standalone or project main) owns one managed screen —
macOS virtual display, headless X session on Linux — created lazily and named
after the chat. A child chat has none of its own; it acts on its parent's.
Ownership is a `Map<channelId, displayId>` in memory only: ids are ephemeral
per process, so a restart recreates every chat's screen instead of reattaching.

The screen is still the host's _shared_ desktop session, not a sandbox: one
pointer, one keyboard, one frontmost app, shared with the machine and every
other chat. Input lands in one ordered per-display queue behind a single
lease, unchanged: a human who takes control holds it until they stop; an
agent batch takes the free lease, delivers, releases, and fails with
`not_controlling` if a person holds it.

## Skills

[`materializeOpenbotSkills`](../../apps/server/src/openbot/skills/index.ts) writes
the shipped skills into a workspace root when the workspace project is ensured and
when a managed project directory is created. They are ordinary skills the provider
discovers from disk, not a wizard: `onboard` sets up projects and knowledge from a
conversation, `import-grok` moves personal Grok bots in.

The `SKILL.md` files stay the reviewable source, but nothing reads them at runtime.
[`generate-openbot-skills.ts`](../../apps/server/scripts/generate-openbot-skills.ts)
embeds them into `generated.ts` as string literals, because the published
`dist/bin.mjs` is one file and cannot read siblings that were never bundled.
`OpenbotSkills.test.ts` re-renders the module in memory and fails when it has
drifted, so editing Markdown without re-running the script cannot land.

Each skill is written twice, to `<workspace>/.claude/skills/<name>/` and
`<workspace>/.agents/skills/<name>/`. Claude Code scans only the first and
[deliberately ignores the second](../../apps/server/src/provider/Drivers/ClaudeSkills.ts);
Codex, Cursor and Antigravity scan the second. A file whose contents already match
is left alone, because an OpenBot workspace is a git repository and a no-op
rewrite would dirty the working tree on every chat start.

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

---
name: onboard
description: Set up OpenBot for someone by creating the projects and shared knowledge they actually need. Use when a person asks to be onboarded, asks for help getting started, or asks you to set up their projects.
---

# Onboard

Turn a conversation into a small, correct set of OpenBot projects and shared knowledge entries. Cover what the person actually works on, and stop there. This is not an exhaustive map of someone's life.

## Read what already exists first

Call `openbot_list_projects` and `openbot_knowledge_list` before anything else.

Treat what they return as already correct. Update an existing project or entry only when the new information belongs in it; leave the rest untouched. Never rewrite every returned entry to match a template. When a project or entry already covers a topic, edit it by its id and current revision instead of adding a near-duplicate. Re-running this skill must converge.

## Ask only what changes the outcome

Ask about what you cannot infer and what would change what you create:

- Which areas of their life or work deserve a project.
- Which of those you should act in, and which you should only track.
- Standing preferences that shape every reply: tone, working hours, what never to do without asking.

Skip any question already answered in this conversation or in material they gave you, and skip any whose answer would not change the result. Send the questions you do have as one round rather than interviewing one at a time.

Prefer the harness's structured question tool: `AskUserQuestion` in Claude Code, the native request-for-user-input in Codex. If your harness has neither, use `openbot_ask_question` when it appears in your tool list. Otherwise ask in an ordinary `openbot_send_message`.

## Gather context you already have access to

Look only where a project inventory plausibly lives, then stop:

- `~/agent-workspace/registry.toml`, if it exists.
- `README.md` at the root of a directory the person named.
- Notes files they pointed you at.

Any MCP servers or connections available to you (for example a tools gateway) may be used for context when relevant, but none is required; proceed with local files and the conversation otherwise.

Ask before reading anything else, and always before reading anything that looks private, credentialed, or unclear in ownership. Do not walk a home directory, open mail, or read a repository nobody mentioned.

## Propose only when the set is not yet agreed

If the person has already reviewed the set they want, create it. Do not ask again.

Otherwise send a proposal with `openbot_send_message`: each project name with a one-line purpose and an icon guess, then the titles of the knowledge entries you would write. Adjust and re-propose if they push back.

## Create the set

- New project: `openbot_create_project` with a stable `clientRequestId` such as `onboard:garden-planner`, the name, a Phosphor icon name, and an `instructions` body carrying the standing preferences for that project.
- Existing project: change it only when the person asked for that change. Read its current `instructions` first and merge the new preference in with `openbot_update_project` and the `revision` from `openbot_list_projects`; never replace instructions they wrote, and never rename or re-icon a project that already fits.
- New knowledge: `openbot_knowledge_write` with a title, a Markdown body, and `projectIds` linking it to the projects it is relevant to.
- Existing knowledge: read it, merge what is new into the body, and write it back with its `knowledgeId` and `expectedRevision`; keep facts the person added and drop nothing they wrote.

Never store secrets, credentials, or anything the person asked you to keep out of durable storage.

Create no routines. Onboarding sets up structure; scheduled work is a separate, explicit decision.

## Close with a summary

Send one last `openbot_send_message`: what you created, what you updated, what you skipped and why, and what they can ask for next.

## Example

Someone wants help with a vegetable patch, a book club, and moving house.

Projects:

- `Garden planner`, icon `Plant`, instructions "Southern-hemisphere seasons. Prefer low-effort suggestions."
- `Book club`, icon `BookOpen`, instructions "Meetings are monthly. Keep summaries under 200 words."
- `House move`, icon `Package`, instructions "Ask before contacting anyone."

Knowledge:

- "Garden bed layout", linked to `Garden planner`: four raised beds, full sun until 2pm, clay soil.
- "Book club cadence", linked to `Book club`: six members, first Tuesday, rotating host.

Everything above is invented. Write down the person's real answers and never these placeholders.

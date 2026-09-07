---
name: import-grok
description: Import personal Grok bots into OpenBot projects, shared knowledge, and disabled routines. Use when a person asks to bring their Grok bots, their Grok memory, or a Grok export into OpenBot.
---

# Import Grok bots

Move a person's Grok bots into OpenBot without inventing anything and without touching the source.

## Locate the source

Ask where the export is. Do not assume a host, a path, or that one exists. Accept either:

- a local export directory the person names, or
- an SSH host and path the person gives you.

If they do not know where it is, say what you would need and stop. Never guess a hostname and never scan for one.

The source is read-only for the whole import. Never write to it, move it, or clean it up.

## Confirm the layout before mapping anything

Each personal bot usually has its own directory containing a profile file with the bot's name, description and system prompt, a memory or profile Markdown file, and an automations folder holding one JSON file per routine. Group bots normally carry an extra group membership file.

That is the common shape, not a promise. Open the actual files, confirm what is there, and report what you found before importing. Where a field is missing or shaped differently, follow the files, not this document.

## Map

| Grok                      | OpenBot                                                                                                             |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| Bot                       | Project: name from the bot, `instructions` distilled from its system prompt, Phosphor icon guessed from its subject |
| Memory or knowledge entry | Knowledge entry via `openbot_knowledge_write`, linked to that bot's project                                         |
| Automation or routine     | `schedule_task` with `enabled: false` and `deliveryMode: "queue"`, targeting the project's main chat thread         |
| Transcript                | Skipped entirely                                                                                                    |

Distil, do not paste. A Grok system prompt usually mixes real standing preferences with Grok-specific scaffolding; keep the preferences and drop the scaffolding.

End every imported knowledge body with a provenance line:

```
Source: Grok bot Garden Helper, imported 2026-01-15
```

## Carry schedules across verbatim

A source routine normally carries a 5-field cron expression and the time zone of the host it ran on, often `UTC`. `schedule_task` takes `{ type: "cron", expression, timeZone }` with an IANA zone alongside `interval` and `fixed_time`, so a cron routine imports as a cron routine.

- Use the source time zone exactly as written. Never translate the expression into local time, and never approximate a cron as `fixed_time`.
- Make the prompt's first line: `Imported from Grok bot <name> (source schedule: <cron> <tz>)`.
- If the source uses a 6- or 7-field cron, or a schedule that is not cron at all, do not guess an equivalent. Leave it disabled, put the original schedule text in the prompt, and list it as "needs review".

## Import every routine disabled

Every imported routine gets `enabled: false`, without exception. An import must never start doing scheduled work the person has not re-approved. Tell them which routines are waiting and where to enable them.

## Flag group-chat bots instead of importing them

Source metadata normally marks whether a bot belonged to a group chat rather than to this person alone. When it does, or when membership is not clearly just this person, do not import it. Flag it and let them decide. A group bot's memory can hold other people's information, and it is not yours to copy.

## Make re-runs converge

Before creating anything, call `openbot_list_projects` and `openbot_knowledge_list`, then match by project name and knowledge title:

- Match found: update it, with `openbot_update_project`, or `openbot_knowledge_read` followed by `openbot_knowledge_write` carrying the id and revision.
- No match: create it with a `clientRequestId` derived from the source item, such as `grok-import:garden-helper`.

Running the import twice must leave exactly the same projects, entries, and routines.

## Finish with a table

Send one `openbot_send_message` listing every source item and its outcome:

| Item                                  | Type       | Outcome                                                    |
| ------------------------------------- | ---------- | ---------------------------------------------------------- |
| Garden Helper                         | bot        | Imported as project "Garden Helper"                        |
| Garden Helper / soil notes            | memory     | Imported as knowledge "Soil and beds"                      |
| Garden Helper / weekly watering check | routine    | Imported disabled as cron `0 7 * * 1` UTC                  |
| Garden Helper / hourly sweep          | routine    | Needs review: 6-field cron `0 */30 * * * *`, left disabled |
| Trivia Night                          | bot        | Flagged: group chat, membership unclear                    |
| Garden Helper / 412 messages          | transcript | Skipped                                                    |

Those rows are placeholders. Report the real source items and never invent one.

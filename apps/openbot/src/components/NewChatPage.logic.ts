import type {
  CommandId,
  ModelSelection,
  OpenbotChannelCreateInput,
  OpenbotChannelId,
} from "@t3tools/contracts";

/** Longest derived title before it is cut. Well inside the 80 a name allows. */
const TITLE_MAX = 60;
/** Below this a word-boundary cut would throw away too much, so cut mid-word. */
const TITLE_MIN_WORD_CUT = 24;
/** Used when a draft carries neither text nor a usable attachment name. */
const FALLBACK_TITLE = "New chat";

function collapse(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

/**
 * The name for a chat whose first message is `text`. Nothing names an OpenBot
 * channel for us, so the first line of what the user typed becomes the name,
 * collapsed to a single line and cut at a word boundary. The result is always
 * a trimmed, nonempty string of at most 61 characters, which `OpenbotChannelName`
 * accepts.
 */
export function chatTitleFromMessage(text: string, attachmentNames: ReadonlyArray<string>): string {
  const source =
    text
      .split("\n")
      .map(collapse)
      .find((line) => line !== "") ??
    attachmentNames.map(collapse).find((name) => name !== "") ??
    "";
  if (source === "") return FALLBACK_TITLE;
  if (source.length <= TITLE_MAX) return source;
  const cut = source.slice(0, TITLE_MAX);
  const lastSpace = cut.lastIndexOf(" ");
  const kept =
    lastSpace >= TITLE_MIN_WORD_CUT ? cut.slice(0, lastSpace) : cut.slice(0, TITLE_MAX - 1);
  return `${kept.trimEnd()}…`;
}

/**
 * Everything a create fixes for the life of a chat. The server derives the
 * channel id from the command id, so a replay carrying a different draft than
 * the one that already created the chat is refused as a profile conflict.
 */
export interface NewChatDraft {
  readonly name: string;
  /** The selected project's main chat, or null for a standalone chat. */
  readonly parentChannelId: OpenbotChannelId | null;
  /** undefined leaves the model to the server. */
  readonly modelSelection: ModelSelection | undefined;
}

/**
 * The idempotency key material for creating `draft`. It carries every field
 * the server compares on a replay, so retrying an unchanged draft reuses the
 * key while an edited one mints a fresh key instead of conflicting.
 */
export function newChatAttemptPayload(draft: NewChatDraft): Record<string, string> {
  return {
    name: draft.name,
    parentChannelId: draft.parentChannelId ?? "",
    instanceId: draft.modelSelection?.instanceId ?? "",
    model: draft.modelSelection?.model ?? "",
  };
}

/** The create input for `draft` under one idempotency key. */
export function newChatCreateInput(
  draft: NewChatDraft,
  commandId: CommandId,
): OpenbotChannelCreateInput {
  return {
    name: draft.name,
    commandId,
    ...(draft.parentChannelId === null ? {} : { parentChannelId: draft.parentChannelId }),
    ...(draft.modelSelection === undefined ? {} : { modelSelection: draft.modelSelection }),
  };
}

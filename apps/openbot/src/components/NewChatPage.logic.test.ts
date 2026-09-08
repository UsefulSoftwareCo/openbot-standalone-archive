import {
  CommandId,
  OpenbotChannelId,
  OpenbotChannelName,
  ProviderInstanceId,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Schema from "effect/Schema";

import { commandAttempt } from "../state/ids";
import {
  chatTitleFromMessage,
  newChatAttemptPayload,
  newChatCreateInput,
  type NewChatDraft,
} from "./NewChatPage.logic";

const parentChannelId = OpenbotChannelId.make("openbot-channel:groceries-main");
const commandId = CommandId.make("command:openbot:chat-create:1-2-3-4");
const modelSelection = { instanceId: ProviderInstanceId.make("claude"), model: "opus" } as const;

const draft: NewChatDraft = {
  name: "Plan the week",
  parentChannelId: null,
  modelSelection: undefined,
};

describe("chatTitleFromMessage", () => {
  it("names the chat after the first line of the message", () => {
    expect(chatTitleFromMessage("Plan the week\nand the next one", [])).toBe("Plan the week");
  });

  it("skips blank lines and collapses runs of whitespace", () => {
    expect(chatTitleFromMessage("\n\n   Plan   the\tweek  ", [])).toBe("Plan the week");
  });

  it("cuts a long line at a word boundary", () => {
    const title = chatTitleFromMessage(
      "Please review the deployment checklist and tell me which steps are still manual",
      [],
    );
    expect(title).toBe("Please review the deployment checklist and tell me which…");
    expect(title.length).toBeLessThanOrEqual(80);
  });

  it("cuts mid-word when the first word is longer than the title", () => {
    const title = chatTitleFromMessage("x".repeat(200), []);
    expect(title).toBe(`${"x".repeat(59)}…`);
  });

  it("falls back to the first attachment name when there is no text", () => {
    expect(chatTitleFromMessage("   ", ["", "screenshot.png"])).toBe("screenshot.png");
  });

  it("always produces a name the contract accepts", () => {
    const decode = Schema.decodeUnknownOption(OpenbotChannelName);
    for (const text of ["", "   \n\t ", "hi", "y".repeat(500), "word ".repeat(80)]) {
      expect(decode(chatTitleFromMessage(text, []))._tag).toBe("Some");
    }
  });
});

describe("newChatAttemptPayload", () => {
  it("replays one command id while the draft is unchanged", () => {
    const first = commandAttempt(null, "chat-create", newChatAttemptPayload(draft));
    expect(
      commandAttempt(first, "chat-create", newChatAttemptPayload({ ...draft })).commandId,
    ).toBe(first.commandId);
  });

  it("mints a new command id when the project changes", () => {
    const first = commandAttempt(null, "chat-create", newChatAttemptPayload(draft));
    expect(
      commandAttempt(first, "chat-create", newChatAttemptPayload({ ...draft, parentChannelId }))
        .commandId,
    ).not.toBe(first.commandId);
  });

  it("mints a new command id when the model changes", () => {
    const first = commandAttempt(null, "chat-create", newChatAttemptPayload(draft));
    expect(
      commandAttempt(first, "chat-create", {
        ...newChatAttemptPayload({ ...draft, modelSelection }),
      }).commandId,
    ).not.toBe(first.commandId);
  });
});

describe("newChatCreateInput", () => {
  it("omits the parent and the model for a standalone automatic chat", () => {
    expect(newChatCreateInput(draft, commandId)).toEqual({ name: "Plan the week", commandId });
  });

  it("puts a selected project's main chat in as the parent", () => {
    expect(newChatCreateInput({ ...draft, parentChannelId }, commandId)).toEqual({
      name: "Plan the week",
      commandId,
      parentChannelId,
    });
  });

  it("carries an explicit model selection", () => {
    expect(newChatCreateInput({ ...draft, modelSelection }, commandId)).toEqual({
      name: "Plan the week",
      commandId,
      modelSelection,
    });
  });
});

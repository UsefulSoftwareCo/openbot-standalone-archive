import type { OpenbotChannelView, OpenbotIncomingMessage } from "@t3tools/contracts";
import { assert, describe, it } from "@effect/vitest";

import { clipPreview, incomingPresentation, resolveReplyPreview } from "./ChannelView.logic";

const message = (
  id: string,
  text: string,
  origin?: OpenbotIncomingMessage["origin"],
): OpenbotIncomingMessage =>
  ({
    id,
    runId: null,
    runStatus: null,
    text: origin === undefined ? text : `Peer request ${origin.requestId} from "x"\n\n${text}`,
    displayText: text,
    ...(origin === undefined ? {} : { origin }),
    attachments: [],
    createdAt: "2026-09-06T00:00:00.000Z",
    state: "handled",
    outcome: null,
    error: null,
  }) as unknown as OpenbotIncomingMessage;

const request = {
  kind: "peer_request",
  sourceChannelId: "c1",
  sourceName: "Planner",
  requestId: "r1",
};
const reply = {
  kind: "peer_reply",
  sourceChannelId: "c2",
  sourceName: "Beta · Invoices",
  requestId: "r2",
};

describe("incomingPresentation", () => {
  it("keeps the person's own messages on the outgoing side", () => {
    assert.deepEqual(incomingPresentation(message("m1", "hello")), { kind: "person" });
  });

  it("names the chat behind a peer request and a peer result", () => {
    assert.deepEqual(incomingPresentation(message("p1", "Write the memo.", request as never)), {
      kind: "peer",
      label: "From Planner",
    });
    assert.deepEqual(incomingPresentation(message("p2", "Already paid.", reply as never)), {
      kind: "peer",
      label: "Result from Beta · Invoices",
    });
  });
});

describe("resolveReplyPreview", () => {
  const view = {
    messages: [
      message("m1", "what is the status?"),
      message("p1", "Write the memo.", request as never),
    ],
    deliveries: [{ id: "d1", kind: "message", text: "On it.", createdAt: "" }],
  } as unknown as OpenbotChannelView;

  it("attributes a quoted peer message to its source, not to the person", () => {
    assert.deepEqual(resolveReplyPreview(view, { type: "message", messageId: "p1" as never }), {
      author: "Planner",
      text: "Write the memo.",
    });
  });

  it("quotes what the person actually typed", () => {
    assert.deepEqual(resolveReplyPreview(view, { type: "message", messageId: "m1" as never }), {
      author: "You",
      text: "what is the status?",
    });
  });

  it("reports a missing target instead of guessing", () => {
    assert.equal(resolveReplyPreview(view, { type: "message", messageId: "gone" as never }), null);
    assert.deepEqual(resolveReplyPreview(view, { type: "delivery", deliveryId: "d1" as never }), {
      author: "OpenBot",
      text: "On it.",
    });
  });
});

it("clips a long preview on a word boundary and collapses whitespace", () => {
  assert.equal(clipPreview("  a\n\n  b  "), "a b");
  const long = "word ".repeat(40);
  assert.isTrue(clipPreview(long).endsWith("…"));
  assert.isBelow(clipPreview(long).length, 95);
});

import type {
  OpenbotChannelView,
  OpenbotIncomingMessage,
  OpenbotReplyTarget,
} from "@t3tools/contracts";

/**
 * How one incoming message is presented. Only the person's own messages get the
 * outgoing bubble; a peer request or reply is another chat talking, so it reads
 * as an incoming row with the sending chat named.
 */
export type IncomingPresentation =
  | { readonly kind: "person" }
  | { readonly kind: "peer"; readonly label: string };

export function incomingPresentation(
  message: Pick<OpenbotIncomingMessage, "origin">,
): IncomingPresentation {
  const origin = message.origin;
  if (origin === undefined) return { kind: "person" };
  return {
    kind: "peer",
    label:
      origin.kind === "peer_reply"
        ? `Result from ${origin.sourceName}`
        : `From ${origin.sourceName}`,
  };
}

const REPLY_PREVIEW_LENGTH = 90;

export function clipPreview(text: string): string {
  const collapsed = text.replace(/\s+/g, " ").trim();
  return collapsed.length > REPLY_PREVIEW_LENGTH
    ? `${collapsed.slice(0, REPLY_PREVIEW_LENGTH).trimEnd()}…`
    : collapsed;
}

/** Author and clipped body of the row a reply points at, or null if it is gone. */
export function resolveReplyPreview(
  view: OpenbotChannelView,
  target: OpenbotReplyTarget,
): { readonly author: string; readonly text: string } | null {
  if (target.type === "message") {
    const message = view.messages.find((candidate) => candidate.id === target.messageId);
    if (message === undefined) return null;
    return {
      author: message.origin === undefined ? "You" : message.origin.sourceName,
      text: clipPreview(message.displayText),
    };
  }
  const delivery = view.deliveries.find((candidate) => candidate.id === target.deliveryId);
  return delivery === undefined ? null : { author: "Assistant", text: clipPreview(delivery.text) };
}

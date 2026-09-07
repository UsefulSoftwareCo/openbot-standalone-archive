import { UserMessageBubble } from "@t3tools/ui/message-bubble";
import type {
  OpenbotChannelView as ChannelViewData,
  OpenbotDelivery,
  EnvironmentId,
  OpenbotIncomingMessage,
  OpenbotReplyTarget,
} from "@t3tools/contracts";
import { cn } from "@t3tools/ui/cn";
import { ScrollArea } from "@t3tools/ui/scroll-area";
import { Spinner } from "@t3tools/ui/spinner";
import { AlertCircle, ArrowRightLeft, Clock3, CornerUpLeft, MessageSquare } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

import { useSnoozeActive } from "./ChatHeader";
import { ChatAvatar } from "./ChatProfileFields";
import { channelActivity, incomingPresentation, resolveReplyPreview } from "./ChannelView.logic";
import { Attachment } from "./Attachment";
import { Markdown } from "./Markdown";

type TimelineEntry =
  | { readonly kind: "incoming"; readonly at: number; readonly message: OpenbotIncomingMessage }
  | { readonly kind: "delivery"; readonly at: number; readonly delivery: OpenbotDelivery };

function buildTimeline(view: ChannelViewData): ReadonlyArray<TimelineEntry> {
  const entries: Array<TimelineEntry> = [
    ...view.messages.map((message): TimelineEntry => ({
      kind: "incoming",
      at: Date.parse(message.createdAt),
      message,
    })),
    // Silence records are internal bookkeeping; the channel shows nothing.
    ...view.deliveries
      .filter((delivery) => delivery.kind === "message")
      .map((delivery): TimelineEntry => ({
        kind: "delivery",
        at: Date.parse(delivery.createdAt),
        delivery,
      })),
  ];
  return entries.toSorted((left, right) => left.at - right.at);
}

function formatTime(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime())
    ? ""
    : date.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
}

/** DOM id of a timeline row so reply references can jump to it. */
function rowId(target: OpenbotReplyTarget): string {
  return target.type === "message" ? `msg-${target.messageId}` : `msg-${target.deliveryId}`;
}

/** Compact reference above a reply, in the style of a chat app's quoted reply. */
function ReplyReference({
  view,
  target,
  onJump,
}: {
  readonly view: ChannelViewData;
  readonly target: OpenbotReplyTarget;
  readonly onJump: (target: OpenbotReplyTarget) => void;
}) {
  const preview = resolveReplyPreview(view, target);
  return (
    <button
      type="button"
      onClick={() => onJump(target)}
      className="mb-1 flex min-h-8 max-w-full items-center gap-1.5 rounded-md py-0.5 pr-2 pl-1 text-left text-[12px] text-muted-foreground hover:bg-accent hover:text-foreground"
      aria-label={
        preview === null ? "Jump to the replied message" : `Replying to ${preview.author}`
      }
    >
      <CornerUpLeft className="size-3 shrink-0" />
      {preview === null ? (
        <span className="italic">Original message unavailable</span>
      ) : (
        <>
          <span className="shrink-0 font-medium text-foreground/80">{preview.author}</span>
          <span className="truncate">{preview.text}</span>
        </>
      )}
    </button>
  );
}

/**
 * Failures and unanswered requests get a badge; queue and scheduling state stay
 * invisible. A run that ended without a reply, a skip, or a pending question is
 * shown as unanswered with a way to nudge the agent through an ordinary send.
 * An explicit skip (outcome `silent`) is not a failure and shows nothing.
 */
function MessageFailure({
  message,
  hasPendingQuestion,
  onContinue,
}: {
  readonly message: OpenbotIncomingMessage;
  readonly hasPendingQuestion: boolean;
  /** Omitted for peer rows: resending another chat's envelope as the person is nonsense. */
  readonly onContinue?: (message: OpenbotIncomingMessage) => void;
}) {
  if (message.state === "failed") {
    return (
      <span className="inline-flex items-center gap-1 text-error-foreground">
        <AlertCircle className="size-3" /> Failed
        {message.error !== null && (
          <span className="max-w-xs truncate text-muted-foreground">· {message.error}</span>
        )}
        {onContinue !== undefined && (
          <button
            type="button"
            className="ml-1 underline underline-offset-2 hover:text-foreground"
            onClick={() => onContinue(message)}
          >
            Retry
          </button>
        )}
      </span>
    );
  }
  if (message.state === "handled" && message.outcome === "no_reply" && !hasPendingQuestion) {
    return (
      <span className="inline-flex items-center gap-1 text-muted-foreground">
        <AlertCircle className="size-3" /> No reply
        {onContinue !== undefined && (
          <button
            type="button"
            className="ml-1 underline underline-offset-2 hover:text-foreground"
            onClick={() => onContinue(message)}
          >
            Ask again
          </button>
        )}
      </span>
    );
  }
  return null;
}

/** Subtle channel-level activity line, like a typing indicator. */
function ChannelActivity({ view }: { readonly view: ChannelViewData }) {
  // The "until this chat wakes" wording only needs to know whether the snooze
  // is still ahead; the header already tracks that against the clock and
  // re-renders at the deadline, so read the same derived value here.
  const snoozed = useSnoozeActive(view.snoozedUntil);
  const activity = channelActivity(view, snoozed);
  if (activity.kind === "none") return null;
  const label =
    activity.kind === "failed"
      ? "The last run failed"
      : activity.kind === "waiting"
        ? "Assistant is waiting for your answer"
        : activity.kind === "queued"
          ? activity.snoozed
            ? "Queued until this chat wakes"
            : "Queued"
          : "Assistant is typing…";
  return (
    <div className="flex h-7 items-center gap-2 px-4 text-muted-foreground text-xs">
      {activity.kind === "failed" ? (
        <AlertCircle className="size-3 text-error-foreground" />
      ) : activity.kind === "queued" ? (
        <Clock3 className="size-3" />
      ) : (
        <Spinner className="size-3" />
      )}
      <span>{label}</span>
    </div>
  );
}

export function ChannelView({
  view,
  environmentId,
  onContinue,
}: {
  readonly view: ChannelViewData;
  readonly environmentId: EnvironmentId;
  /** Re-send a message's text through the ordinary send path (retry / ask again). */
  readonly onContinue: (message: OpenbotIncomingMessage) => void;
}) {
  const hasPendingQuestion = view.pendingRequests.length > 0;
  const timeline = buildTimeline(view);
  const viewportRef = useRef<HTMLDivElement>(null);
  const lastCount = useRef(0);
  const [highlighted, setHighlighted] = useState<string | null>(null);
  const highlightTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const scroller = viewportRef.current?.closest("[data-slot=scroll-area-viewport]");
    if (scroller instanceof HTMLElement && timeline.length !== lastCount.current) {
      scroller.scrollTo({ top: scroller.scrollHeight });
    }
    lastCount.current = timeline.length;
  }, [timeline.length]);

  useEffect(
    () => () => {
      if (highlightTimer.current !== null) clearTimeout(highlightTimer.current);
    },
    [],
  );

  const jumpTo = useCallback((target: OpenbotReplyTarget) => {
    const id = rowId(target);
    const row = viewportRef.current?.querySelector<HTMLElement>(`[id="${id}"]`);
    if (row === null || row === undefined) return;
    row.scrollIntoView({ block: "center" });
    setHighlighted(id);
    if (highlightTimer.current !== null) clearTimeout(highlightTimer.current);
    highlightTimer.current = setTimeout(() => setHighlighted(null), 1600);
  }, []);

  return (
    <div className="flex h-full min-h-0 flex-1 flex-col">
      <ScrollArea className="min-h-0 flex-1">
        <div
          ref={viewportRef}
          className="mx-auto flex w-full max-w-3xl min-w-0 flex-col gap-5 px-3 py-4 sm:gap-4 sm:px-4 sm:py-6"
        >
          {timeline.length === 0 ? (
            <div className="flex flex-col items-center gap-2 py-16 text-center text-muted-foreground">
              <MessageSquare className="size-6" />
              <p className="text-sm">A little room to work this out.</p>
              <p className="text-xs">Send a message to start the conversation.</p>
            </div>
          ) : (
            timeline.map((entry) => {
              if (entry.kind === "incoming") {
                const id = rowId({ type: "message", messageId: entry.message.id });
                const presentation = incomingPresentation(entry.message);
                if (presentation.kind === "peer") {
                  // Another chat talking, not the person: incoming side, named
                  // source, and only the task or result it actually carries.
                  return (
                    <article
                      key={`in:${entry.message.id}`}
                      id={id}
                      className={cn(
                        "flex flex-col items-start gap-1 rounded-lg transition-colors",
                        highlighted === id && "bg-accent/60",
                      )}
                    >
                      <div className="flex flex-wrap items-center gap-2 pl-1 text-[11px] text-muted-foreground">
                        <span className="inline-flex items-center gap-1 rounded-full border border-border px-2 py-0.5 font-medium text-foreground">
                          <ArrowRightLeft className="size-3" />
                          {presentation.label}
                        </span>
                        <MessageFailure
                          message={entry.message}
                          hasPendingQuestion={hasPendingQuestion}
                        />
                        <time dateTime={entry.message.createdAt}>
                          {formatTime(entry.message.createdAt)}
                        </time>
                      </div>
                      <div className="min-w-0 max-w-full px-1 sm:max-w-[85%]">
                        <Markdown text={entry.message.displayText} environmentId={environmentId} />
                        {entry.message.attachments.map((attachment) => (
                          <Attachment
                            key={attachment.id}
                            attachment={attachment}
                            environmentId={environmentId}
                          />
                        ))}
                      </div>
                    </article>
                  );
                }
                return (
                  <article
                    key={`in:${entry.message.id}`}
                    id={id}
                    className={cn(
                      "flex flex-col items-end gap-1 rounded-lg transition-colors",
                      highlighted === id && "bg-accent/60",
                    )}
                  >
                    <UserMessageBubble className="min-w-0 max-w-[90%] sm:max-w-[80%]">
                      <Markdown text={entry.message.displayText} environmentId={environmentId} />
                      {entry.message.attachments.map((attachment) => (
                        <Attachment
                          key={attachment.id}
                          attachment={attachment}
                          environmentId={environmentId}
                        />
                      ))}
                    </UserMessageBubble>
                    <div className="flex items-center gap-2 pr-1 text-[11px] text-muted-foreground">
                      <MessageFailure
                        message={entry.message}
                        hasPendingQuestion={hasPendingQuestion}
                        onContinue={onContinue}
                      />
                      <time dateTime={entry.message.createdAt}>
                        {formatTime(entry.message.createdAt)}
                      </time>
                    </div>
                  </article>
                );
              }
              const id = rowId({ type: "delivery", deliveryId: entry.delivery.id });
              return (
                <article
                  key={`out:${entry.delivery.id}`}
                  id={id}
                  className={cn(
                    "flex flex-col items-start gap-1 rounded-lg transition-colors",
                    highlighted === id && "bg-accent/60",
                  )}
                >
                  <div className="flex items-center gap-2 pl-1 text-[11px] text-muted-foreground">
                    <ChatAvatar
                      avatar={view.channel.avatar}
                      name={view.channel.name}
                      className="size-5"
                    />
                    <span className="font-medium text-foreground">Assistant</span>
                    <time dateTime={entry.delivery.createdAt}>
                      {formatTime(entry.delivery.createdAt)}
                    </time>
                  </div>
                  <div className="min-w-0 max-w-full px-1 sm:max-w-[85%]">
                    {entry.delivery.replyTo !== null && (
                      <ReplyReference view={view} target={entry.delivery.replyTo} onJump={jumpTo} />
                    )}
                    <Markdown text={entry.delivery.text} environmentId={environmentId} />
                  </div>
                </article>
              );
            })
          )}
        </div>
      </ScrollArea>
      <ChannelActivity view={view} />
    </div>
  );
}

import { useEnvironmentSettings } from "../../../web/src/hooks/useSettings";
import {
  formatDayAwareTimestamp,
  formatChatTimestampTooltip,
} from "../../../web/src/timestampFormat";
import { Link } from "@tanstack/react-router";
import { channelHref } from "../state/route";
import { UserMessageBubble } from "@t3tools/ui/message-bubble";
import type {
  OpenbotChannelEvent,
  OpenbotChannelId,
  OpenbotChannelView as ChannelViewData,
  OpenbotDelivery,
  EnvironmentId,
  OpenbotIncomingMessage,
  OpenbotReplyTarget,
} from "@t3tools/contracts";
import { cn } from "@t3tools/ui/cn";
import { ScrollArea } from "@t3tools/ui/scroll-area";
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "@t3tools/ui/collapsible";
import {
  AlertCircle,
  ChevronRight,
  Clock3,
  CornerUpLeft,
  MessageSquare,
  MessagesSquare,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

import { useSnoozeActive } from "./ChatHeader";
import {
  channelActivity,
  incomingPresentation,
  visibleChannelMessage,
  resolveReplyPreview,
} from "./ChannelView.logic";
import { Attachment } from "./Attachment";
import { Markdown } from "./Markdown";

type TimelineEntry =
  | { readonly kind: "incoming"; readonly at: number; readonly message: OpenbotIncomingMessage }
  | { readonly kind: "delivery"; readonly at: number; readonly delivery: OpenbotDelivery }
  // A thread this conversation started, shown where it was branched off.
  | { readonly kind: "thread"; readonly at: number; readonly event: OpenbotChannelEvent };

function buildTimeline(view: ChannelViewData): ReadonlyArray<TimelineEntry> {
  const entries: Array<TimelineEntry> = [
    ...view.messages
      .filter((message) => visibleChannelMessage(message, view.channel.parentChannelId))
      .map((message): TimelineEntry => ({
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
    ...view.events.map((event): TimelineEntry => ({
      kind: "thread",
      at: Date.parse(event.createdAt),
      event,
    })),
  ];
  return entries.toSorted((left, right) => left.at - right.at);
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
  const activeMessages = view.messages.filter(
    (message) => message.state === "pending" || message.state === "working",
  );
  if (
    view.status === "working" &&
    activeMessages.length > 0 &&
    activeMessages.every((message) => !visibleChannelMessage(message, view.channel.parentChannelId))
  )
    return null;
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
          : "Working…";
  return (
    <div
      role="status"
      className="flex min-h-8 w-fit items-center gap-2 self-start rounded-2xl bg-muted/60 px-3 py-2 text-muted-foreground text-xs"
    >
      {activity.kind === "failed" ? (
        <AlertCircle className="size-3 text-error-foreground" />
      ) : activity.kind === "queued" ? (
        <Clock3 className="size-3" />
      ) : (
        <span aria-hidden="true" className="flex items-center gap-1">
          <span className="size-1 rounded-full bg-current" />
          <span className="size-1 rounded-full bg-current opacity-65" />
          <span className="size-1 rounded-full bg-current opacity-35" />
        </span>
      )}
      <span>{label}</span>
    </div>
  );
}

export function ChannelView({
  view,
  environmentId,
  onContinue,
  channelNames,
}: {
  readonly view: ChannelViewData;
  readonly environmentId: EnvironmentId;
  /** Re-send a message's text through the ordinary send path (retry / ask again). */
  readonly onContinue: (message: OpenbotIncomingMessage) => void;
  /** Live chat names, so a renamed thread reads correctly instead of its recorded title. */
  readonly channelNames?: ReadonlyMap<OpenbotChannelId, string>;
}) {
  const timestampFormat = useEnvironmentSettings(
    environmentId,
    (settings) => settings.timestampFormat,
  );
  const formatTime = (iso: string) => formatDayAwareTimestamp(iso, timestampFormat);
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
          className="mx-auto flex w-full max-w-3xl min-w-0 flex-col gap-1 px-3 py-4 sm:px-4 sm:py-6"
        >
          {timeline.length === 0 ? (
            <div className="flex flex-col items-center gap-2 py-16 text-center text-muted-foreground">
              <MessageSquare className="size-6" />
              <p className="text-sm">A little room to work this out.</p>
              <p className="text-xs">Send a message to start the conversation.</p>
            </div>
          ) : (
            timeline.map((entry, index) => {
              const previous = timeline[index - 1];
              const grouped =
                previous !== undefined &&
                entry.at - previous.at < 5 * 60_000 &&
                ((entry.kind === "delivery" &&
                  previous.kind === "delivery" &&
                  entry.delivery.replyTo === null) ||
                  (entry.kind === "incoming" &&
                    previous.kind === "incoming" &&
                    incomingPresentation(entry.message).kind === "person" &&
                    incomingPresentation(previous.message).kind === "person"));
              const spacing = index === 0 || grouped ? "mt-0" : "mt-4";
              if (entry.kind === "incoming") {
                const id = rowId({ type: "message", messageId: entry.message.id });
                const presentation = incomingPresentation(entry.message);
                if (presentation.kind === "peer") {
                  const origin = entry.message.origin;
                  const sourceId = origin?.sourceChannelId;
                  const sourceExists = sourceId != null && channelNames?.has(sourceId) === true;
                  const sourceName =
                    (sourceId == null ? undefined : channelNames?.get(sourceId)) ??
                    origin?.sourceName;
                  const isResult = origin?.kind === "peer_reply";
                  return (
                    <article
                      key={`in:${entry.message.id}`}
                      id={id}
                      className={cn(
                        "min-w-0 rounded-lg",
                        spacing,
                        highlighted === id && "bg-accent/60",
                      )}
                    >
                      <Collapsible
                        defaultOpen={!isResult}
                        className="min-w-0 rounded-lg border border-border/60 bg-muted/20"
                      >
                        <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 px-3 py-2 text-xs text-muted-foreground">
                          <MessagesSquare aria-hidden="true" className="size-3.5 shrink-0" />
                          <span className="shrink-0">
                            {isResult ? "Result from" : "Request from"}
                          </span>
                          {sourceExists ? (
                            <Link
                              to={channelHref(sourceId)}
                              className="min-w-0 flex-1 truncate font-medium text-foreground hover:underline"
                              title={sourceName}
                            >
                              {sourceName}
                            </Link>
                          ) : (
                            <span
                              className="min-w-0 flex-1 truncate font-medium"
                              title={sourceName}
                            >
                              {sourceName}
                            </span>
                          )}
                          <CollapsibleTrigger className="group inline-flex shrink-0 items-center gap-1 rounded px-1 py-0.5 text-muted-foreground hover:bg-accent hover:text-foreground">
                            <span className="group-data-[panel-open]:hidden">
                              {isResult ? "View report" : "View request"}
                            </span>
                            <span className="hidden group-data-[panel-open]:inline">
                              Hide details
                            </span>
                            <ChevronRight
                              aria-hidden="true"
                              className="size-3 transition-transform group-data-[panel-open]:rotate-90"
                            />
                          </CollapsibleTrigger>
                        </div>
                        <CollapsiblePanel>
                          <div className="min-w-0 border-t border-border/60 px-3 py-3">
                            <Markdown
                              text={entry.message.displayText}
                              environmentId={environmentId}
                            />
                            {entry.message.attachments.map((attachment) => (
                              <Attachment
                                key={attachment.id}
                                attachment={attachment}
                                environmentId={environmentId}
                              />
                            ))}
                            <time
                              className="mt-2 block text-[11px] text-muted-foreground"
                              dateTime={entry.message.createdAt}
                              title={formatChatTimestampTooltip(
                                entry.message.createdAt,
                                timestampFormat,
                              )}
                            >
                              {formatTime(entry.message.createdAt)}
                            </time>
                          </div>
                        </CollapsiblePanel>
                      </Collapsible>
                      <div className="px-1 text-[11px]">
                        <MessageFailure
                          message={entry.message}
                          hasPendingQuestion={hasPendingQuestion}
                        />
                      </div>
                    </article>
                  );
                }
                return (
                  <article
                    key={`in:${entry.message.id}`}
                    id={id}
                    className={cn(
                      "openbot-message relative flex flex-col items-end gap-1 rounded-lg transition-colors",
                      spacing,
                      highlighted === id && "bg-accent/60",
                    )}
                  >
                    <UserMessageBubble
                      className={cn(
                        "min-w-0 max-w-[90%] px-3 py-2 sm:max-w-[85%]",
                        grouped && "rounded-tr-md",
                      )}
                    >
                      <Markdown text={entry.message.displayText} environmentId={environmentId} />
                      {entry.message.attachments.map((attachment) => (
                        <Attachment
                          key={attachment.id}
                          attachment={attachment}
                          environmentId={environmentId}
                        />
                      ))}
                    </UserMessageBubble>
                    <div className="flex items-center gap-2 pr-1 text-[11px] text-muted-foreground empty:hidden">
                      <MessageFailure
                        message={entry.message}
                        hasPendingQuestion={hasPendingQuestion}
                        onContinue={onContinue}
                      />
                      <time
                        className="openbot-message-time right-1"
                        tabIndex={0}
                        dateTime={entry.message.createdAt}
                        title={formatChatTimestampTooltip(entry.message.createdAt, timestampFormat)}
                      >
                        {formatTime(entry.message.createdAt)}
                      </time>
                    </div>
                  </article>
                );
              }
              if (entry.kind === "thread") {
                const { event } = entry;
                const target = event.targetChannelId;
                const name =
                  (target === null ? undefined : channelNames?.get(target)) ?? event.title;
                const body = (
                  <>
                    <span
                      aria-hidden
                      className="-mt-1 ml-1 size-4 shrink-0 rounded-bl-md border-border border-b border-l"
                    />
                    <MessagesSquare className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
                    <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                      <span className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
                        Thread created
                        <time
                          dateTime={event.createdAt}
                          title={formatChatTimestampTooltip(event.createdAt, timestampFormat)}
                        >
                          {formatTime(event.createdAt)}
                        </time>
                      </span>
                      <span className="truncate font-medium text-foreground text-sm">{name}</span>
                    </span>
                    {target === null ? null : (
                      <span className="mt-0.5 flex shrink-0 items-center gap-0.5 text-[11px] text-muted-foreground">
                        Open thread
                        <ChevronRight className="size-3" />
                      </span>
                    )}
                  </>
                );
                const row =
                  "mt-3 mb-2 flex min-h-9 w-full max-w-full min-w-0 items-start gap-2 rounded-md px-1 py-1 text-left";
                // A thread outside this OpenBot install has nowhere to go, so the
                // record reads as plain history rather than a dead control.
                return target === null ? (
                  <div key={`thread:${event.id}`} className={row}>
                    {body}
                  </div>
                ) : (
                  <Link
                    key={`thread:${event.id}`}
                    to={channelHref(target)}
                    aria-label={`Open thread ${name}`}
                    className={cn(
                      row,
                      "outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background",
                    )}
                  >
                    {body}
                  </Link>
                );
              }
              const id = rowId({ type: "delivery", deliveryId: entry.delivery.id });
              return (
                <article
                  key={`out:${entry.delivery.id}`}
                  id={id}
                  className={cn(
                    "openbot-message relative flex flex-col items-start gap-1 rounded-lg transition-colors",
                    spacing,
                    highlighted === id && "bg-accent/60",
                  )}
                >
                  <time
                    className="openbot-message-time left-1"
                    tabIndex={0}
                    dateTime={entry.delivery.createdAt}
                    title={formatChatTimestampTooltip(entry.delivery.createdAt, timestampFormat)}
                  >
                    {formatTime(entry.delivery.createdAt)}
                  </time>
                  <div
                    className={cn(
                      "min-w-0 max-w-[95%] rounded-2xl bg-muted/60 px-3 py-2 sm:max-w-[85%]",
                      grouped && "rounded-tl-md",
                    )}
                  >
                    {entry.delivery.replyTo !== null && (
                      <ReplyReference view={view} target={entry.delivery.replyTo} onJump={jumpTo} />
                    )}
                    <Markdown text={entry.delivery.text} environmentId={environmentId} />
                  </div>
                </article>
              );
            })
          )}
          <div className="mt-2">
            <ChannelActivity view={view} />
          </div>
        </div>
      </ScrollArea>
    </div>
  );
}

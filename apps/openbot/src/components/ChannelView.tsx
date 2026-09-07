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
import { AlertCircle, CornerUpLeft, MessageSquare } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

import { BotAvatar } from "./BotProfileFields";
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

const REPLY_PREVIEW_LENGTH = 90;

function clipPreview(text: string): string {
  const collapsed = text.replace(/\s+/g, " ").trim();
  return collapsed.length > REPLY_PREVIEW_LENGTH
    ? `${collapsed.slice(0, REPLY_PREVIEW_LENGTH).trimEnd()}…`
    : collapsed;
}

function resolveReplyPreview(
  view: ChannelViewData,
  target: OpenbotReplyTarget,
): { readonly author: string; readonly text: string } | null {
  if (target.type === "message") {
    const message = view.messages.find((candidate) => candidate.id === target.messageId);
    return message === undefined ? null : { author: "You", text: clipPreview(message.text) };
  }
  const delivery = view.deliveries.find((candidate) => candidate.id === target.deliveryId);
  return delivery === undefined ? null : { author: "OpenBot", text: clipPreview(delivery.text) };
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

/** Only genuine failures get a badge; queue and scheduling state stay invisible. */
function MessageFailure({ message }: { readonly message: OpenbotIncomingMessage }) {
  if (message.state !== "failed") return null;
  return (
    <span className="inline-flex items-center gap-1 text-error-foreground">
      <AlertCircle className="size-3" /> Failed
      {message.error !== null && (
        <span className="max-w-xs truncate text-muted-foreground">· {message.error}</span>
      )}
    </span>
  );
}

/** Subtle channel-level activity line, like a typing indicator. */
function ChannelActivity({ view }: { readonly view: ChannelViewData }) {
  if (view.status === "idle") return null;
  const label =
    view.status === "failed"
      ? "The last run failed"
      : view.status === "waiting"
        ? "OpenBot is waiting for input in T3 Code"
        : "OpenBot is typing…";
  return (
    <div className="flex h-7 items-center gap-2 px-4 text-muted-foreground text-xs">
      {view.status === "failed" ? (
        <AlertCircle className="size-3 text-error-foreground" />
      ) : (
        <Spinner className="size-3" />
      )}
      <span>{label}</span>
    </div>
  );
}

export function ChannelView({
  view,
  onShowDetails,
  environmentId,
}: {
  readonly view: ChannelViewData;
  readonly environmentId: EnvironmentId;
  readonly onShowDetails: () => void;
}) {
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
      <header className="hidden h-12 shrink-0 items-center md:flex gap-2 border-b border-border px-4">
        <BotAvatar avatar={view.channel.avatar} name={view.channel.name} />
        <h1 className="min-w-0 truncate font-semibold text-sm">
          <button onClick={onShowDetails} aria-label="View conversation details">
            {view.channel.name}
          </button>
        </h1>
        <span className="text-muted-foreground text-xs">
          {view.channel.modelSelection.instanceId} · {view.channel.modelSelection.model}
        </span>
      </header>
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
                      <Markdown text={entry.message.text} environmentId={environmentId} />
                      {entry.message.attachments.map((attachment) => (
                        <Attachment
                          key={attachment.id}
                          attachment={attachment}
                          environmentId={environmentId}
                        />
                      ))}
                    </UserMessageBubble>
                    <div className="flex items-center gap-2 pr-1 text-[11px] text-muted-foreground">
                      <MessageFailure message={entry.message} />
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
                    <BotAvatar
                      avatar={view.channel.avatar}
                      name={view.channel.name}
                      className="size-5"
                    />
                    <span className="font-medium text-foreground">{view.channel.name}</span>
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

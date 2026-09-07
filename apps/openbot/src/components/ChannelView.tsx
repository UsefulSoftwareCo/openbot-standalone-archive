import type {
  OpenbotChannelView as ChannelViewData,
  OpenbotDelivery,
  OpenbotIncomingMessage,
} from "@t3tools/contracts";
import { cn } from "@t3tools/ui/cn";
import { ScrollArea } from "@t3tools/ui/scroll-area";
import { Spinner } from "@t3tools/ui/spinner";
import { AlertCircle, Clock3, Hash, MessageSquare, MinusCircle } from "lucide-react";
import { useEffect, useRef } from "react";

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

function MessageStatus({ message }: { readonly message: OpenbotIncomingMessage }) {
  switch (message.state) {
    case "pending":
      return (
        <span className="inline-flex items-center gap-1 text-muted-foreground">
          <Clock3 className="size-3" /> Queued
        </span>
      );
    case "working":
      return (
        <span className="inline-flex items-center gap-1 text-muted-foreground">
          <Spinner className="size-3" /> Working
        </span>
      );
    case "failed":
      return (
        <span className="inline-flex items-center gap-1 text-error-foreground">
          <AlertCircle className="size-3" /> Failed
          {message.error !== null && (
            <span className="max-w-xs truncate text-muted-foreground">· {message.error}</span>
          )}
        </span>
      );
    case "handled":
      if (message.outcome === "silent") {
        return (
          <span className="inline-flex items-center gap-1 text-muted-foreground">
            <MinusCircle className="size-3" /> No reply needed
          </span>
        );
      }
      if (message.outcome === "no_reply") {
        return (
          <span className="inline-flex items-center gap-1 text-warning-foreground">
            <AlertCircle className="size-3" /> Finished without a reply
          </span>
        );
      }
      return null;
  }
}

function ChannelStatusLine({ view }: { readonly view: ChannelViewData }) {
  const pending = view.pendingCount;
  const parts: Array<string> = [];
  if (view.status === "working") parts.push("OpenBot is working");
  if (view.status === "waiting") parts.push("OpenBot is waiting for input in T3 Code");
  if (view.status === "failed") parts.push("The last run failed");
  if (pending > 0) parts.push(`${pending} message${pending === 1 ? "" : "s"} queued`);
  if (parts.length === 0) return null;
  return (
    <div className="flex items-center gap-2 px-4 py-1.5 text-muted-foreground text-xs">
      {view.status === "working" ? (
        <Spinner className="size-3" />
      ) : view.status === "failed" ? (
        <AlertCircle className="size-3 text-error-foreground" />
      ) : (
        <Clock3 className="size-3" />
      )}
      <span>{parts.join(" · ")}</span>
    </div>
  );
}

export function ChannelView({ view }: { readonly view: ChannelViewData }) {
  const timeline = buildTimeline(view);
  const viewportRef = useRef<HTMLDivElement>(null);
  const lastCount = useRef(0);
  useEffect(() => {
    const scroller = viewportRef.current?.closest("[data-slot=scroll-area-viewport]");
    if (scroller instanceof HTMLElement && timeline.length !== lastCount.current) {
      scroller.scrollTo({ top: scroller.scrollHeight });
    }
    lastCount.current = timeline.length;
  }, [timeline.length]);

  return (
    <div className="flex h-full min-h-0 flex-1 flex-col">
      <header className="flex h-12 shrink-0 items-center gap-2 border-b border-border px-4">
        <Hash className="size-4 text-muted-foreground" />
        <h1 className="font-semibold text-sm">{view.channel.name}</h1>
        <span className="text-muted-foreground text-xs">
          {view.channel.modelSelection.instanceId} · {view.channel.modelSelection.model}
        </span>
      </header>
      <ScrollArea className="min-h-0 flex-1">
        <div ref={viewportRef} className="mx-auto flex w-full max-w-3xl flex-col gap-4 px-4 py-6">
          {timeline.length === 0 ? (
            <div className="flex flex-col items-center gap-2 py-16 text-center text-muted-foreground">
              <MessageSquare className="size-6" />
              <p className="text-sm">A little room to work this out.</p>
              <p className="text-xs">Send a message to start the conversation.</p>
            </div>
          ) : (
            timeline.map((entry) =>
              entry.kind === "incoming" ? (
                <article key={`in:${entry.message.id}`} className="flex flex-col items-end gap-1">
                  <div className="max-w-[80%] rounded-2xl rounded-br-md bg-message px-3.5 py-2 text-message-foreground">
                    <Markdown text={entry.message.text} />
                  </div>
                  <div className="flex items-center gap-2 pr-1 text-[11px] text-muted-foreground">
                    <MessageStatus message={entry.message} />
                    <time dateTime={entry.message.createdAt}>
                      {formatTime(entry.message.createdAt)}
                    </time>
                  </div>
                </article>
              ) : (
                <article
                  key={`out:${entry.delivery.id}`}
                  className="flex flex-col items-start gap-1"
                >
                  <div className="flex items-center gap-2 pl-1 text-[11px] text-muted-foreground">
                    <span className="font-medium text-foreground">OpenBot</span>
                    <time dateTime={entry.delivery.createdAt}>
                      {formatTime(entry.delivery.createdAt)}
                    </time>
                  </div>
                  <div className={cn("max-w-[85%] px-1")}>
                    <Markdown text={entry.delivery.text} />
                  </div>
                </article>
              ),
            )
          )}
        </div>
      </ScrollArea>
      <ChannelStatusLine view={view} />
    </div>
  );
}

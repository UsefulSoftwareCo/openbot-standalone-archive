import type { EnvironmentId, OpenbotChannelId } from "@t3tools/contracts";
import { ChevronRight, Monitor } from "lucide-react";
import { useRef } from "react";

import { useChatComputer, useEnsureChatComputer } from "../../state/computer";
import { chatComputerView, controllerBadge } from "./computerStatusView";
import { useComputerStream, useDocumentVisible } from "./useComputerStream";

/** A thumbnail is a thumbnail: small, slow, and never the reason a host is busy. */
const THUMBNAIL_PROFILE = { maxWidthPx: 320, fps: 4 } as const;

/**
 * The chat's computer, as it appears beside the conversation: a live thumbnail
 * of the screen this chat works on, what state it is in, and one way in.
 *
 * The chat owns the screen, so this card asks for `channelId`'s computer and
 * the server answers with the owner's — a child chat shows its parent's screen
 * under the parent's name. Provisioning happens once per chat, on mount: the
 * rail is where a user first sees the computer, and a chat nobody has opened
 * has cost the host nothing.
 */
export function ComputerCard({
  environmentId,
  channelId,
  onOpen,
}: {
  readonly environmentId: EnvironmentId;
  readonly channelId: OpenbotChannelId;
  readonly onOpen: () => void;
}) {
  const { computer, error } = useChatComputer(environmentId, channelId);
  const ensureError = useEnsureChatComputer(environmentId, channelId);
  const view = chatComputerView({ computer, error });
  const visible = useDocumentVisible();
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const stream = useComputerStream({
    enabled: view.canStream && visible,
    channelId,
    profile: THUMBNAIL_PROFILE,
    control: false,
    canvasRef,
  });

  const badge = controllerBadge(computer?.controller ?? null, stream.state.controlling);
  // The server's own words win: a failed `ensure` is only worth saying when
  // nothing better arrived on the subscription.
  const note = view.placeholder ?? ensureError;

  return (
    <section aria-label="Computer" className="flex flex-col gap-2 pb-4">
      <header className="flex items-center justify-between">
        <h2 className="font-medium text-sm">Computer</h2>
        <span className="flex items-center gap-1.5 text-muted-foreground text-xs">
          <span aria-hidden className={`size-2 rounded-full ${view.dotClass}`} />
          {view.statusLabel}
        </span>
      </header>
      <button
        type="button"
        onClick={onOpen}
        className="flex w-full flex-col gap-2 rounded-lg text-left outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <span className="relative flex aspect-16/10 w-full items-center justify-center overflow-hidden rounded-lg border border-border bg-muted">
          <canvas
            ref={canvasRef}
            aria-hidden
            className={`size-full object-contain ${stream.hasFrame ? "" : "hidden"}`}
          />
          {!stream.hasFrame && (
            <Monitor aria-hidden className="size-6 text-muted-foreground opacity-60" />
          )}
          {badge !== null && (
            <span className="absolute bottom-1 left-1 rounded bg-background/85 px-1.5 py-0.5 text-[11px] text-muted-foreground">
              {badge}
            </span>
          )}
        </span>
        <span className="flex min-w-0 items-center gap-1.5 text-sm">
          <span className="min-w-0 flex-1 truncate font-medium">
            {computer?.channelName ?? "This chat's screen"}
          </span>
          <ChevronRight aria-hidden className="size-4 shrink-0 text-muted-foreground" />
        </span>
        {note !== null && <span className="text-muted-foreground text-xs">{note}</span>}
      </button>
    </section>
  );
}

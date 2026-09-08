import type { EnvironmentId } from "@t3tools/contracts";
import { Monitor } from "lucide-react";
import { useRef } from "react";

import { preferredDisplay, useComputerStatus } from "../../state/computer";
import { computerStatusView, controllerBadge, displayCountLabel } from "./computerStatusView";
import { useComputerStream, useDocumentVisible } from "./useComputerStream";

/** A thumbnail is a thumbnail: small, slow, and never the reason a host is busy. */
const THUMBNAIL_PROFILE = { maxWidthPx: 320, fps: 4 } as const;

/**
 * The computer, as it appears beside a conversation: a live thumbnail of the
 * host's screen, what state it is in, and one way in. Everything else about
 * the computer lives on its own page — this rail is for glancing at.
 */
export function ComputerCard({
  environmentId,
  onOpen,
}: {
  readonly environmentId: EnvironmentId;
  readonly onOpen: () => void;
}) {
  const { status, error } = useComputerStatus(environmentId);
  const view = computerStatusView({ status, statusError: error });
  const display = preferredDisplay(status);
  const visible = useDocumentVisible();
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const stream = useComputerStream({
    enabled: view.canStream && visible,
    displayId: display?.id ?? null,
    profile: THUMBNAIL_PROFILE,
    control: false,
    canvasRef,
  });

  const badge = controllerBadge(status?.controller ?? null, stream.state.controlling);
  const hostLabel = status?.host.label ?? "The host";
  const secondary = status === null ? null : displayCountLabel(status.displays);

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
        <span className="flex min-w-0 items-baseline gap-1.5 text-sm">
          <span className="truncate font-medium">{hostLabel}</span>
          {secondary !== null && (
            <span className="shrink-0 text-muted-foreground text-xs">· {secondary}</span>
          )}
        </span>
        {view.reason !== null && (
          <span className="text-muted-foreground text-xs">{view.reason}</span>
        )}
      </button>
    </section>
  );
}

import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type {
  EnvironmentId,
  OpenbotComputerDisplay,
  OpenbotComputerSnapshot,
  OpenbotComputerStatus,
} from "@t3tools/contracts";
import { Button } from "@t3tools/ui/button";
import { Dialog, DialogHeader, DialogPanel, DialogPopup, DialogTitle } from "@t3tools/ui/dialog";
import { useCallback, useEffect, useRef, useState } from "react";

import { useAtomCommand } from "../state/channels";
import { getComputerSnapshot, getComputerStatus } from "../state/computer";

const AUTO_REFRESH_MS = 5_000;

const PLATFORM_LABELS: Record<OpenbotComputerStatus["host"]["platform"], string> = {
  darwin: "macOS",
  linux: "Linux",
  windows: "Windows",
  unknown: "Unknown platform",
};

/** "1 display · 3840×2160", or just the count when no size is known. */
export function displaySummary(
  displays: ReadonlyArray<OpenbotComputerDisplay> | null | undefined,
): string {
  if (displays === null || displays === undefined || displays.length === 0) {
    return "Unknown displays";
  }
  const count = `${displays.length} display${displays.length === 1 ? "" : "s"}`;
  const primary = displays.find((display) => display.main) ?? displays[0];
  if (primary === undefined || primary.widthPx === null || primary.heightPx === null) return count;
  return `${count} · ${primary.widthPx}×${primary.heightPx}`;
}

/**
 * Auto-refresh burns a screenshot every tick, so it only runs while the user
 * asked for it, the preview is on screen, and the tab is actually visible.
 */
export function autoRefreshActive(input: {
  readonly enabled: boolean;
  readonly showing: boolean;
  readonly visibility: string;
}): boolean {
  return input.enabled && input.showing && input.visibility === "visible";
}

function failureText(result: Parameters<typeof squashAtomCommandFailure>[0]): string {
  const error = squashAtomCommandFailure(result);
  return error instanceof Error ? error.message : String(error);
}

function capturedAtLabel(capturedAt: string): string {
  const at = new Date(capturedAt);
  return Number.isNaN(at.getTime()) ? capturedAt : at.toLocaleTimeString();
}

const DOT_CLASS: Record<OpenbotComputerStatus["availability"], string> = {
  ready: "bg-success",
  unavailable: "bg-warning",
  unsupported: "bg-muted-foreground",
};

/**
 * The computer the environment's agents act on. Agents run in this same
 * signed-in desktop session, so the preview is a screenshot of the real
 * machine rather than an isolated display.
 */
export default function ComputerPanel({
  environmentId,
}: {
  readonly environmentId: EnvironmentId;
}) {
  const readStatus = useAtomCommand(getComputerStatus, { reportFailure: false });
  const readSnapshot = useAtomCommand(getComputerSnapshot, { reportFailure: false });
  const [status, setStatus] = useState<OpenbotComputerStatus | null>(null);
  const [statusError, setStatusError] = useState<string | null>(null);
  const [snapshot, setSnapshot] = useState<OpenbotComputerSnapshot | null>(null);
  const [snapshotError, setSnapshotError] = useState<string | null>(null);
  const [showing, setShowing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [autoRefresh, setAutoRefresh] = useState(false);
  const [expanded, setExpanded] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const result = await readStatus({ environmentId, input: {} });
      if (cancelled) return;
      if (result._tag === "Success") {
        setStatus(result.value);
        setStatusError(null);
      } else setStatusError(failureText(result));
    })();
    return () => {
      cancelled = true;
    };
  }, [environmentId, readStatus]);

  const capture = useCallback(async () => {
    setBusy(true);
    const result = await readSnapshot({ environmentId, input: {} });
    setBusy(false);
    if (result._tag === "Success") {
      setSnapshot(result.value);
      setSnapshotError(null);
      // A failed capture keeps the last good image, so clear the error only here.
    } else setSnapshotError(failureText(result));
  }, [environmentId, readSnapshot]);

  // The interval outlives each render, so it reads the latest capture through a
  // ref instead of being torn down and rebuilt every time `capture` changes.
  const captureRef = useRef(capture);
  useEffect(() => {
    captureRef.current = capture;
  }, [capture]);
  useEffect(() => {
    if (!autoRefresh || !showing) return;
    const timer = setInterval(() => {
      if (
        !autoRefreshActive({ enabled: true, showing: true, visibility: document.visibilityState })
      ) {
        return;
      }
      void captureRef.current();
    }, AUTO_REFRESH_MS);
    return () => clearInterval(timer);
  }, [autoRefresh, showing]);

  const previewable = status !== null && status.availability === "ready";
  const imageUrl =
    snapshot === null ? null : `data:${snapshot.mimeType};base64,${snapshot.dataBase64}`;

  return (
    <section aria-label="Computer" className="flex flex-col gap-3 p-4">
      <header className="flex items-center justify-between">
        <h2 className="text-sm font-medium">Computer</h2>
        <span className="flex items-center gap-2 text-xs text-muted-foreground">
          <span
            aria-hidden
            className={`size-2 rounded-full ${status === null ? "bg-muted-foreground" : DOT_CLASS[status.availability]}`}
          />
          {status === null
            ? statusError === null
              ? "Checking…"
              : "Unreachable"
            : status.availability === "ready"
              ? "Ready"
              : status.availability === "unavailable"
                ? "Unavailable"
                : "Unsupported"}
        </span>
      </header>

      {status === null ? (
        <p role="status" className="text-sm text-muted-foreground">
          {statusError ?? "Reading the host's desktop session…"}
        </p>
      ) : (
        <dl className="flex flex-col gap-0.5 text-sm">
          <div className="flex items-baseline justify-between gap-3">
            <dt className="text-muted-foreground">Host</dt>
            <dd className="truncate font-medium">{status.host.label}</dd>
          </div>
          <div className="flex items-baseline justify-between gap-3">
            <dt className="text-muted-foreground">Platform</dt>
            <dd>{PLATFORM_LABELS[status.host.platform]}</dd>
          </div>
          <div className="flex items-baseline justify-between gap-3">
            <dt className="text-muted-foreground">Session</dt>
            <dd>Signed-in desktop session</dd>
          </div>
          <div className="flex items-baseline justify-between gap-3">
            <dt className="text-muted-foreground">Displays</dt>
            <dd>{displaySummary(status.displays)}</dd>
          </div>
        </dl>
      )}

      {status !== null && !previewable && status.detail !== null && (
        <p className="text-sm text-muted-foreground">{status.detail}</p>
      )}

      {previewable && (
        <>
          <div className="flex aspect-16/10 items-center justify-center overflow-hidden rounded-lg border border-border bg-muted">
            {imageUrl === null ? (
              <Button
                size="sm"
                disabled={busy}
                onClick={() => {
                  setShowing(true);
                  void capture();
                }}
              >
                {busy ? "Capturing…" : "Show preview"}
              </Button>
            ) : (
              <img
                src={imageUrl}
                alt={`Screen of ${status.host.label}`}
                className="size-full object-contain"
              />
            )}
          </div>

          {snapshot !== null && (
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="text-xs text-muted-foreground">
                Captured {capturedAtLabel(snapshot.capturedAt)}
              </span>
              <div className="flex items-center gap-1">
                <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
                  <input
                    type="checkbox"
                    checked={autoRefresh}
                    onChange={(event) => setAutoRefresh(event.target.checked)}
                  />
                  Auto-refresh
                </label>
                <Button variant="ghost" size="sm" disabled={busy} onClick={() => void capture()}>
                  Refresh
                </Button>
                <Button variant="ghost" size="sm" onClick={() => setExpanded(true)}>
                  Expand
                </Button>
              </div>
            </div>
          )}

          {snapshot?.caveat != null && (
            <p className="text-sm text-warning-foreground">{snapshot.caveat}</p>
          )}
          {snapshotError !== null && (
            <p role="alert" className="text-sm text-error-foreground">
              {snapshotError}
            </p>
          )}

          <p className="text-xs text-muted-foreground">
            Agents act in this same session. Anything you do on the computer can interrupt them.
          </p>

          <Dialog open={expanded} onOpenChange={setExpanded}>
            <DialogPopup className="max-w-5xl" bottomStickOnMobile={false}>
              <DialogHeader>
                <DialogTitle>{status.host.label}</DialogTitle>
              </DialogHeader>
              <DialogPanel>
                {imageUrl !== null && (
                  <img
                    src={imageUrl}
                    alt={`Screen of ${status.host.label}`}
                    className="w-full rounded-lg border border-border"
                  />
                )}
              </DialogPanel>
            </DialogPopup>
          </Dialog>
        </>
      )}
    </section>
  );
}

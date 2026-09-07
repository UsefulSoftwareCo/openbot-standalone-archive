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
  unknown: "bg-muted-foreground",
  unavailable: "bg-warning",
  unsupported: "bg-muted-foreground",
};

const LABEL: Record<OpenbotComputerStatus["availability"], string> = {
  ready: "Ready",
  unknown: "Not checked",
  unavailable: "Unavailable",
  unsupported: "Unsupported",
};

interface ComputerStateView {
  readonly label: string;
  readonly dotClass: string;
  readonly canCapture: boolean;
}

/**
 * How the header reads and whether a capture is worth offering.
 *
 * The server only calls a host `ready` once a capture has actually succeeded
 * there, so the panel must never upgrade `unknown` to "Ready" on its own. An
 * `unavailable` host is retryable exactly when a real attempt failed
 * (`lastError`); a host that is unavailable for a structural reason, such as
 * having no `screencapture`, cannot be retried into working.
 */
export function computerStateView(input: {
  readonly status: OpenbotComputerStatus | null;
  readonly statusError: string | null;
}): ComputerStateView {
  const { status, statusError } = input;
  if (status === null) {
    return statusError === null
      ? { label: "Checking…", dotClass: "bg-muted-foreground", canCapture: false }
      : { label: "Unreachable", dotClass: "bg-warning", canCapture: false };
  }
  return {
    label: LABEL[status.availability],
    dotClass: DOT_CLASS[status.availability],
    canCapture:
      status.availability === "ready" ||
      status.availability === "unknown" ||
      (status.availability === "unavailable" && status.lastError !== null),
  };
}

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

  const applyStatus = useCallback((result: Awaited<ReturnType<typeof readStatus>>) => {
    if (result._tag === "Success") {
      setStatus(result.value);
      setStatusError(null);
    } else setStatusError(failureText(result));
  }, []);

  const refreshStatus = useCallback(async () => {
    applyStatus(await readStatus({ environmentId, input: {} }));
  }, [applyStatus, environmentId, readStatus]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const result = await readStatus({ environmentId, input: {} });
      if (cancelled) return;
      applyStatus(result);
    })();
    return () => {
      cancelled = true;
    };
  }, [applyStatus, environmentId, readStatus]);

  const capture = useCallback(async () => {
    setBusy(true);
    const result = await readSnapshot({ environmentId, input: {} });
    setBusy(false);
    if (result._tag === "Success") {
      setSnapshot(result.value);
      setSnapshotError(null);
      // A failed capture keeps the last good image, so clear the error only here.
    } else setSnapshotError(failureText(result));
    // The attempt is the only evidence of whether this host can be captured, so
    // the header follows it either way.
    await refreshStatus();
  }, [environmentId, readSnapshot, refreshStatus]);

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

  const view = computerStateView({ status, statusError });
  const imageUrl =
    snapshot === null ? null : `data:${snapshot.mimeType};base64,${snapshot.dataBase64}`;

  return (
    <section aria-label="Computer" className="flex flex-col gap-3 p-4">
      <header className="flex items-center justify-between">
        <h2 className="text-sm font-medium">Computer</h2>
        <span className="flex items-center gap-2 text-xs text-muted-foreground">
          <span aria-hidden className={`size-2 rounded-full ${view.dotClass}`} />
          {view.label}
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

      {status !== null && status.availability !== "unknown" && status.detail !== null && (
        <p className="text-sm text-muted-foreground">{status.detail}</p>
      )}

      {view.canCapture && status !== null && (
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
            <p className="text-xs text-muted-foreground">{snapshot.caveat}</p>
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

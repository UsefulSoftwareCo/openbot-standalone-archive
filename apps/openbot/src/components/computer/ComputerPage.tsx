import type {
  EnvironmentId,
  OpenbotComputerDisplay,
  OpenbotComputerDisplayId,
  OpenbotComputerInputEvent,
  OpenbotComputerMouseButton,
  OpenbotComputerWindow,
} from "@t3tools/contracts";
import { Button } from "@t3tools/ui/button";
import {
  Dialog,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "@t3tools/ui/dialog";
import { Input } from "@t3tools/ui/input";
import { Tooltip, TooltipPopup, TooltipTrigger } from "@t3tools/ui/tooltip";
import {
  AppWindow,
  ArrowLeft,
  Keyboard,
  Maximize2,
  Menu,
  Minimize2,
  MousePointer2,
  Plus,
  X,
} from "lucide-react";
import { type RefObject, useCallback, useEffect, useRef, useState } from "react";

import { useAtomCommand } from "../../state/channels";
import {
  createComputerDisplay,
  destroyComputerDisplay,
  focusComputerWindow,
  preferredDisplay,
  useComputerStatus,
} from "../../state/computer";
import { commandErrorText } from "../../state/errors";
import {
  type ComputerViewMode,
  computerGeometry,
  normalizeWheelDelta,
  stageToDisplayPoint,
} from "./computerGeometry";
import {
  hiddenViewerRelease,
  keyDownInput,
  keyUpInput,
  releaseEvents,
  textEvents,
} from "./computerKeys";
import { type MaximizeEvent, NOT_MAXIMIZED, nextMaximizeState } from "./computerMaximize";
import {
  computerStatusView,
  controllerBadge,
  displayOptionLabel,
  sessionLabel,
  streamBanner,
} from "./computerStatusView";
import { useComputerStream, useDocumentVisible, useElementSize } from "./useComputerStream";

/** A viewer watching a desktop: full detail, and interactive rather than smooth. */
const VIEWER_PROFILE = { maxWidthPx: 1920, fps: 12 } as const;

/** ~60 pointer moves a second is what the host can act on; more is just traffic. */
const MOVE_INTERVAL_MS = 16;

const EMPTY_DISPLAYS: ReadonlyArray<OpenbotComputerDisplay> = [];
const EMPTY_WINDOWS: ReadonlyArray<OpenbotComputerWindow> = [];

const BUTTONS: Record<number, OpenbotComputerMouseButton> = {
  0: "left",
  1: "middle",
  2: "right",
};

const fieldClass = "rounded-md border border-border bg-background px-3 py-2 text-sm";

/**
 * Leaves the browser's own fullscreen if this document is in it. Safe to call
 * from either tier: when only the in-app overlay is up there is nothing to
 * leave, and a browser that never offered the API cannot be asked to exit.
 */
function leaveNativeFullscreen() {
  if (document.fullscreenElement === null) return;
  if (typeof document.exitFullscreen !== "function") return;
  void document.exitFullscreen().catch(() => undefined);
}

/**
 * The host's screen, full pane.
 *
 * The rules that make this safe to use are all about the shared session: no
 * input is sent unless this viewer holds the lease, the lease is always
 * visible, and everything this client pressed is released when it stops
 * looking. The pointer mapping and key translation are pure functions
 * (`computerGeometry`, `computerKeys`) so they can be tested without a host.
 */
export function ComputerPage({
  environmentId,
  onClose,
  onOpenSidebar,
}: {
  readonly environmentId: EnvironmentId;
  readonly onClose: () => void;
  readonly onOpenSidebar: () => void;
}) {
  const { status, error } = useComputerStatus(environmentId);
  const view = computerStatusView({ status, statusError: error });
  const displays = status?.displays ?? EMPTY_DISPLAYS;
  const windows = status?.windows ?? EMPTY_WINDOWS;

  const [chosenDisplayId, setChosenDisplayId] = useState<OpenbotComputerDisplayId | null>(null);
  // A chosen display that the host no longer reports falls back rather than
  // leaving the stage pointed at nothing.
  const activeDisplay =
    displays.find((display) => display.id === chosenDisplayId) ?? preferredDisplay(status);

  const [mode, setMode] = useState<ComputerViewMode>("fit");
  const [windowsOpen, setWindowsOpen] = useState(false);
  const [newDisplayOpen, setNewDisplayOpen] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  const stageRef = useRef<HTMLDivElement | null>(null);
  // Maximizing covers this element and nothing else, so it has to hold the
  // toolbar as well as the stage, and host the dialogs the toolbar opens.
  const wrapperRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const keyboardRef = useRef<HTMLTextAreaElement | null>(null);
  const heldKeysRef = useRef<ReadonlySet<string>>(new Set());
  const heldButtonsRef = useRef(new Set<OpenbotComputerMouseButton>());
  const lastMoveRef = useRef({ atMs: 0, x: -1, y: -1 });
  const composingRef = useRef(false);

  const stage = useElementSize(stageRef);
  // A hidden tab must not keep a developer's machine capturing and encoding a
  // screen nobody is looking at, exactly as the thumbnail does not.
  const visible = useDocumentVisible();
  const stream = useComputerStream({
    enabled: view.canStream && visible,
    displayId: activeDisplay?.id ?? null,
    profile: VIEWER_PROFILE,
    control: false,
    canvasRef,
  });
  const { sendInput, setControl } = stream;
  const controlling = stream.state.controlling;
  // The frame maps onto the display the *stream* is showing, which may lag a
  // display switch by one round trip.
  const streamDisplay = stream.state.display;
  const geometry = computerGeometry(
    stage,
    { widthPx: stream.state.frameWidthPx ?? 0, heightPx: stream.state.frameHeightPx ?? 0 },
    mode,
  );

  const send = useCallback(
    (events: ReadonlyArray<OpenbotComputerInputEvent>) => {
      if (events.length > 0) sendInput(events);
    },
    [sendInput],
  );

  const releaseEverything = useCallback(() => {
    send(releaseEvents(heldKeysRef.current, heldButtonsRef.current));
    heldKeysRef.current = new Set();
    heldButtonsRef.current.clear();
  }, [send]);

  // Losing the lease drops what this client was holding: the host has already
  // released it, and remembering it here would suppress the next keydown.
  useEffect(() => {
    if (!controlling) {
      heldKeysRef.current = new Set();
      heldButtonsRef.current.clear();
    }
  }, [controlling]);

  useEffect(() => releaseEverything, [releaseEverything]);

  // Handled on the event rather than on the rendered `visible` flag: the flag
  // also tears the socket down, and by the time that effect runs there is no
  // socket left to say `release` on.
  useEffect(() => {
    const onVisibilityChange = () => {
      const owed = hiddenViewerRelease({
        visible: document.visibilityState === "visible",
        controlling,
        heldKeys: heldKeysRef.current,
        heldButtons: heldButtonsRef.current,
      });
      send(owed.events);
      if (owed.releaseControl) setControl("release");
      if (document.visibilityState !== "visible") {
        heldKeysRef.current = new Set();
        heldButtonsRef.current.clear();
      }
    };
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => document.removeEventListener("visibilitychange", onVisibilityChange);
  }, [controlling, send, setControl]);

  const [maximize, setMaximize] = useState(NOT_MAXIMIZED);
  const dispatchMaximize = useCallback((event: MaximizeEvent) => {
    setMaximize((current) => nextMaximizeState(current, event));
  }, []);

  // The browser is the authority on its own fullscreen: it can hand the element
  // back at any time, and Escape at the browser level arrives only here.
  useEffect(() => {
    const sync = () => {
      const element = wrapperRef.current;
      dispatchMaximize(
        element !== null && document.fullscreenElement === element
          ? { type: "nativeGranted" }
          : { type: "nativeExited" },
      );
    };
    document.addEventListener("fullscreenchange", sync);
    return () => document.removeEventListener("fullscreenchange", sync);
  }, [dispatchMaximize]);

  // The overlay goes up first and stays up; native fullscreen is the upgrade.
  const enterMaximize = useCallback(() => {
    dispatchMaximize({ type: "clickMaximize" });
    const element = wrapperRef.current;
    if (element === null) return;
    if (typeof element.requestFullscreen !== "function") {
      dispatchMaximize({ type: "nativeDenied", reason: "unsupported" });
      return;
    }
    void element.requestFullscreen().then(
      () => dispatchMaximize({ type: "nativeGranted" }),
      () => dispatchMaximize({ type: "nativeDenied", reason: "declined" }),
    );
  }, [dispatchMaximize]);

  const exitMaximize = useCallback(() => {
    dispatchMaximize({ type: "clickExit" });
    leaveNativeFullscreen();
  }, [dispatchMaximize]);

  // Escape means "leave the host alone" only when the host is not listening.
  // While controlling, every keystroke including Escape is being forwarded to a
  // desktop that has its own use for it, so the toolbar's exit button is the way
  // out; the browser may still cancel its own fullscreen, which arrives above.
  useEffect(() => {
    if (!maximize.maximized) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      dispatchMaximize({ type: "escape", controlling });
      if (!controlling) leaveNativeFullscreen();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [controlling, dispatchMaximize, maximize.maximized]);

  // Wheel has to be a non-passive listener to keep the page from scrolling
  // under the stage, which React's own onWheel cannot promise.
  useEffect(() => {
    const element = stageRef.current;
    if (element === null) return;
    const onWheel = (event: WheelEvent) => {
      if (!controlling || streamDisplay === null) return;
      const point = stageToDisplayPoint(
        event.clientX,
        event.clientY,
        element.getBoundingClientRect(),
        geometry,
        streamDisplay,
      );
      if (point === null) return;
      event.preventDefault();
      const delta = normalizeWheelDelta(event, element.clientHeight);
      send([{ type: "scroll", point, deltaX: delta.deltaX, deltaY: delta.deltaY }]);
    };
    element.addEventListener("wheel", onWheel, { passive: false });
    return () => element.removeEventListener("wheel", onWheel);
  }, [controlling, geometry, send, streamDisplay]);

  const pointAt = (clientX: number, clientY: number) => {
    const element = stageRef.current;
    if (element === null || streamDisplay === null) return null;
    return stageToDisplayPoint(
      clientX,
      clientY,
      element.getBoundingClientRect(),
      geometry,
      streamDisplay,
    );
  };

  const runFocusWindow = useAtomCommand(focusComputerWindow, { reportFailure: false });
  const runCreateDisplay = useAtomCommand(createComputerDisplay, { reportFailure: false });
  const runDestroyDisplay = useAtomCommand(destroyComputerDisplay, { reportFailure: false });

  const banner = streamBanner({
    connection: stream.state.connection,
    status: stream.state.status,
    message: stream.state.message,
    hasFrame: stream.hasFrame,
  });
  const badge = controllerBadge(status?.controller ?? null, controlling);
  const otherController = !controlling && status?.controller != null;
  const canControl = status?.capabilities.input === true && view.canStream;
  const physical = displays.filter((display) => !display.managed);
  const managed = displays.filter((display) => display.managed);
  // The browser paints only the fullscreen element's subtree, so a dialog
  // portaled to `<body>` while fullscreen is simply not there. The in-app
  // overlay has the same problem for a different reason: `<body>` is behind it.
  const dialogContainer = maximize.maximized ? wrapperRef : undefined;

  return (
    <div
      ref={wrapperRef}
      className={`flex min-h-0 min-w-0 flex-col bg-background text-foreground ${
        // The app shell is itself fixed, so filling the pane is not enough to
        // cover the sidebar and the details rail; only the viewport will do.
        maximize.maximized ? "fixed inset-0 z-50" : "flex-1"
      }`}
    >
      <header className="flex h-12 shrink-0 items-center gap-1 border-b border-border px-2 pt-[env(safe-area-inset-top)] md:px-3">
        <Button
          variant="ghost"
          size="icon"
          className="shrink-0 md:hidden"
          aria-label="Open projects and chats"
          onClick={onOpenSidebar}
        >
          <Menu />
        </Button>
        <Button variant="ghost" size="xs" className="shrink-0" onClick={onClose}>
          <ArrowLeft />
          <span className="hidden sm:inline">Back</span>
        </Button>
        <div className="flex min-w-0 flex-1 items-baseline gap-1.5">
          <h1 className="truncate font-medium text-sm">{status?.host.label ?? "Computer"}</h1>
          <span className="hidden shrink-0 text-muted-foreground text-xs sm:inline">
            {status === null ? view.statusLabel : sessionLabel(status.session)}
          </span>
        </div>
        <select
          aria-label="Display"
          className={`${fieldClass} h-8 max-w-44 truncate py-0`}
          value={activeDisplay?.id ?? ""}
          disabled={displays.length === 0}
          onChange={(event) =>
            setChosenDisplayId(
              displays.find((display) => display.id === event.target.value)?.id ?? null,
            )
          }
        >
          {displays.length === 0 && <option value="">No displays</option>}
          {physical.length > 0 && (
            <optgroup label="Physical">
              {physical.map((display) => (
                <option key={display.id} value={display.id}>
                  {displayOptionLabel(display)}
                </option>
              ))}
            </optgroup>
          )}
          {managed.length > 0 && (
            <optgroup label="Managed">
              {managed.map((display) => (
                <option key={display.id} value={display.id}>
                  {displayOptionLabel(display)}
                </option>
              ))}
            </optgroup>
          )}
        </select>
        {status?.capabilities.managedDisplays === true && (
          <>
            <Button
              variant="ghost"
              size="icon-xs"
              aria-label="Add a managed display"
              onClick={() => {
                setActionError(null);
                setNewDisplayOpen(true);
              }}
            >
              <Plus />
            </Button>
            {activeDisplay?.managed === true && (
              <Button
                variant="ghost"
                size="icon-xs"
                aria-label={`Remove ${activeDisplay.name}`}
                onClick={async () => {
                  setActionError(null);
                  const result = await runDestroyDisplay({
                    environmentId,
                    input: { displayId: activeDisplay.id },
                  });
                  if (result._tag === "Failure") setActionError(commandErrorText(result));
                  else setChosenDisplayId(null);
                }}
              >
                <X />
              </Button>
            )}
          </>
        )}
        {status?.capabilities.windows === true && (
          <Button
            variant="ghost"
            size="xs"
            className="shrink-0 text-muted-foreground"
            onClick={() => {
              setActionError(null);
              setWindowsOpen(true);
            }}
          >
            <AppWindow />
            <span className="hidden lg:inline">Windows</span>
          </Button>
        )}
        {controlling ? (
          <Button
            variant="outline"
            size="xs"
            className="shrink-0"
            onClick={() => setControl("release")}
          >
            <MousePointer2 />
            Stop controlling
          </Button>
        ) : otherController ? (
          <Tooltip>
            <TooltipTrigger render={<span className="inline-flex shrink-0" />}>
              <Button variant="ghost" size="xs" disabled>
                <MousePointer2 />
                Take control
              </Button>
            </TooltipTrigger>
            <TooltipPopup side="bottom">{badge ?? "Someone else is controlling"}</TooltipPopup>
          </Tooltip>
        ) : (
          <Button
            variant="ghost"
            size="xs"
            className="shrink-0"
            disabled={!canControl}
            onClick={() => {
              setControl("take");
              keyboardRef.current?.focus();
            }}
          >
            <MousePointer2 />
            Take control
          </Button>
        )}
        <Button
          variant="ghost"
          size="xs"
          className="shrink-0 text-muted-foreground"
          aria-pressed={mode === "native"}
          onClick={() => setMode((current) => (current === "fit" ? "native" : "fit"))}
        >
          {mode === "fit" ? "Fit" : "1:1"}
        </Button>
        {controlling && (
          <Button
            variant="ghost"
            size="icon-xs"
            aria-label="Release all keys"
            onClick={releaseEverything}
          >
            <Keyboard />
          </Button>
        )}
        <Button
          variant="ghost"
          size="icon-xs"
          aria-label={maximize.maximized ? "Exit maximize" : "Maximize"}
          onClick={maximize.maximized ? exitMaximize : enterMaximize}
        >
          {maximize.maximized ? <Minimize2 /> : <Maximize2 />}
        </Button>
      </header>

      <div className="relative flex min-h-0 flex-1 flex-col bg-muted">
        <div
          ref={stageRef}
          className={`relative min-h-0 flex-1 overflow-hidden ${controlling ? "cursor-none" : ""}`}
          onPointerDown={(event) => {
            if (!controlling) return;
            const button = BUTTONS[event.button];
            const point = pointAt(event.clientX, event.clientY);
            if (button === undefined || point === null) return;
            event.preventDefault();
            event.currentTarget.setPointerCapture(event.pointerId);
            keyboardRef.current?.focus();
            heldButtonsRef.current.add(button);
            send([{ type: "button", button, action: "down", point }]);
          }}
          onPointerMove={(event) => {
            if (!controlling) return;
            const point = pointAt(event.clientX, event.clientY);
            if (point === null) return;
            const last = lastMoveRef.current;
            const now = event.timeStamp;
            if (point.x === last.x && point.y === last.y) return;
            if (now - last.atMs < MOVE_INTERVAL_MS) return;
            lastMoveRef.current = { atMs: now, x: point.x, y: point.y };
            send([{ type: "move", point }]);
          }}
          onPointerUp={(event) => {
            if (!controlling) return;
            const button = BUTTONS[event.button];
            const point = pointAt(event.clientX, event.clientY);
            if (button === undefined || !heldButtonsRef.current.has(button)) return;
            heldButtonsRef.current.delete(button);
            if (event.currentTarget.hasPointerCapture(event.pointerId)) {
              event.currentTarget.releasePointerCapture(event.pointerId);
            }
            if (point !== null) send([{ type: "button", button, action: "up", point }]);
            else send([{ type: "release-all" }]);
          }}
          onPointerCancel={() => {
            if (heldButtonsRef.current.size > 0) {
              heldButtonsRef.current.clear();
              send([{ type: "release-all" }]);
            }
          }}
          onContextMenu={(event) => {
            if (controlling) event.preventDefault();
          }}
        >
          <canvas
            ref={canvasRef}
            aria-label={
              activeDisplay === null
                ? "The host's screen"
                : `${activeDisplay.name} on ${status?.host.label ?? "the host"}`
            }
            role="img"
            className="absolute bg-black"
            style={{
              width: `${geometry.cssWidth}px`,
              height: `${geometry.cssHeight}px`,
              left: `${geometry.offsetX}px`,
              top: `${geometry.offsetY}px`,
              visibility: stream.hasFrame ? "visible" : "hidden",
            }}
          />
          {/* noVNC's trick: a focused, invisible textarea is the only reliable
              way to get IME text and key events from a browser. */}
          <textarea
            ref={keyboardRef}
            className="sr-only"
            aria-label="Keyboard input for the host"
            autoComplete="off"
            autoCorrect="off"
            autoCapitalize="off"
            spellCheck={false}
            defaultValue=""
            onKeyDown={(event) => {
              if (!controlling) return;
              const result = keyDownInput(event.nativeEvent, heldKeysRef.current);
              heldKeysRef.current = result.held;
              if (result.preventDefault) event.preventDefault();
              send(result.events);
            }}
            onKeyUp={(event) => {
              if (!controlling) return;
              const result = keyUpInput(event.nativeEvent, heldKeysRef.current);
              heldKeysRef.current = result.held;
              if (result.preventDefault) event.preventDefault();
              send(result.events);
            }}
            onCompositionStart={() => {
              composingRef.current = true;
            }}
            onCompositionEnd={(event) => {
              composingRef.current = false;
              // The composed string arrives here; clearing the field keeps the
              // trailing `input` event from sending it a second time.
              event.currentTarget.value = "";
              if (controlling) send(textEvents(event.data));
            }}
            onInput={(event) => {
              // Mid-composition text belongs to the IME until it commits.
              if (composingRef.current) return;
              const typed = event.currentTarget.value;
              event.currentTarget.value = "";
              if (controlling) send(textEvents(typed));
            }}
            onBlur={releaseEverything}
          />

          {banner !== null && (
            <p
              role="status"
              className={`-translate-x-1/2 absolute top-3 left-1/2 max-w-[90%] rounded-md border border-border px-3 py-1.5 text-xs ${
                banner.tone === "warning"
                  ? "bg-warning-surface text-warning-foreground"
                  : "bg-background/90 text-muted-foreground"
              }`}
            >
              {banner.text}
            </p>
          )}
          {view.reason !== null && !view.canStream && (
            <p className="-translate-x-1/2 -translate-y-1/2 absolute top-1/2 left-1/2 max-w-sm text-balance text-center text-muted-foreground text-sm">
              {view.reason}
            </p>
          )}
          {badge !== null && (
            <span className="absolute bottom-3 left-3 rounded bg-background/85 px-2 py-1 text-muted-foreground text-xs">
              {badge}
            </span>
          )}
        </div>
        <p className="shrink-0 border-t border-border px-3 py-1.5 text-muted-foreground text-xs">
          {controlling
            ? "Your pointer and keyboard go to the host while the stage is focused. Agents share this session."
            : otherController
              ? `${badge ?? "Someone else is controlling"}. You can watch until they stop.`
              : "Take control to interact with this screen."}
          {maximize.hint !== null && <span> {maximize.hint}</span>}
          {actionError !== null && <span className="text-error-foreground"> {actionError}</span>}
        </p>
      </div>

      <Dialog open={windowsOpen} onOpenChange={setWindowsOpen}>
        <DialogPopup
          className="max-w-lg"
          bottomStickOnMobile={false}
          portalContainer={dialogContainer}
        >
          <DialogHeader>
            <DialogTitle>Windows</DialogTitle>
          </DialogHeader>
          <DialogPanel className="max-h-[60dvh] overflow-y-auto">
            {windows.length === 0 ? (
              <p className="text-muted-foreground text-sm">
                No windows are open, or this host cannot list them.
              </p>
            ) : (
              <ul className="flex flex-col gap-0.5" aria-label="Open windows">
                {windows.map((hostWindow) => (
                  <li key={hostWindow.id}>
                    <button
                      type="button"
                      className="flex w-full items-baseline gap-2 rounded-md px-2 py-2 text-left hover:bg-accent"
                      onClick={async () => {
                        setActionError(null);
                        const result = await runFocusWindow({
                          environmentId,
                          input: { windowId: hostWindow.id },
                        });
                        if (result._tag === "Failure") {
                          setActionError(commandErrorText(result));
                          return;
                        }
                        setWindowsOpen(false);
                        // Focusing a window on another screen without following
                        // it leaves the stage pointed at the screen it left.
                        if (
                          hostWindow.displayId !== null &&
                          hostWindow.displayId !== activeDisplay?.id
                        ) {
                          setChosenDisplayId(hostWindow.displayId);
                        }
                      }}
                    >
                      <span className="min-w-0 flex-1 truncate text-sm">
                        {hostWindow.title.length === 0 ? "Untitled window" : hostWindow.title}
                      </span>
                      <span className="shrink-0 text-muted-foreground text-xs">
                        {hostWindow.app}
                      </span>
                      <span className="shrink-0 text-muted-foreground text-xs">
                        {displays.find((display) => display.id === hostWindow.displayId)?.name ??
                          "—"}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </DialogPanel>
        </DialogPopup>
      </Dialog>

      {newDisplayOpen && (
        <NewDisplayDialog
          open={newDisplayOpen}
          onOpenChange={setNewDisplayOpen}
          hiDpiAvailable={status?.host.platform === "darwin"}
          portalContainer={dialogContainer}
          onCreate={async (input) => {
            setActionError(null);
            const result = await runCreateDisplay({ environmentId, input });
            if (result._tag === "Failure") {
              setActionError(commandErrorText(result));
              return;
            }
            setChosenDisplayId(result.value.id);
            setNewDisplayOpen(false);
          }}
        />
      )}
    </div>
  );
}

interface NewDisplayInput {
  readonly name?: string;
  readonly widthPx: number;
  readonly heightPx: number;
  readonly hiDpi?: boolean;
}

/**
 * A managed display is a real screen on the host's session that this server
 * owns and destroys on shutdown, so creating one is deliberate.
 */
function NewDisplayDialog({
  open,
  onOpenChange,
  hiDpiAvailable,
  portalContainer,
  onCreate,
}: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly hiDpiAvailable: boolean;
  /** Where to portal to, so the dialog survives the page going fullscreen. */
  readonly portalContainer: RefObject<HTMLElement | null> | undefined;
  readonly onCreate: (input: NewDisplayInput) => Promise<void>;
}) {
  const [name, setName] = useState("");
  const [width, setWidth] = useState("1920");
  const [height, setHeight] = useState("1080");
  const [hiDpi, setHiDpi] = useState(false);
  const [busy, setBusy] = useState(false);
  const widthPx = Number(width);
  const heightPx = Number(height);
  const valid =
    Number.isInteger(widthPx) &&
    widthPx >= 640 &&
    widthPx <= 7680 &&
    Number.isInteger(heightPx) &&
    heightPx >= 480 &&
    heightPx <= 4320;

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!busy) onOpenChange(next);
      }}
    >
      <DialogPopup
        className="max-w-sm"
        bottomStickOnMobile={false}
        portalContainer={portalContainer}
      >
        <DialogHeader>
          <DialogTitle>New managed display</DialogTitle>
        </DialogHeader>
        <DialogPanel className="flex flex-col gap-3">
          <label className="flex flex-col gap-1 text-sm">
            Name
            <Input
              value={name}
              placeholder="Agent desktop"
              disabled={busy}
              onChange={(event) => setName(event.target.value)}
            />
          </label>
          <div className="flex gap-3">
            <label className="flex flex-1 flex-col gap-1 text-sm">
              Width
              <Input
                type="number"
                value={width}
                disabled={busy}
                onChange={(event) => setWidth(event.target.value)}
              />
            </label>
            <label className="flex flex-1 flex-col gap-1 text-sm">
              Height
              <Input
                type="number"
                value={height}
                disabled={busy}
                onChange={(event) => setHeight(event.target.value)}
              />
            </label>
          </div>
          {hiDpiAvailable && (
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={hiDpi}
                disabled={busy}
                onChange={(event) => setHiDpi(event.target.checked)}
              />
              Render at 2x
            </label>
          )}
          <p className="text-muted-foreground text-xs">
            This display lives on the host's session until the server stops.
          </p>
        </DialogPanel>
        <DialogFooter>
          <Button variant="ghost" disabled={busy} onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            disabled={busy || !valid}
            onClick={async () => {
              setBusy(true);
              await onCreate({
                ...(name.trim().length === 0 ? {} : { name: name.trim() }),
                widthPx,
                heightPx,
                ...(hiDpiAvailable && hiDpi ? { hiDpi: true } : {}),
              });
              setBusy(false);
            }}
          >
            Create display
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

import type {
  OpenbotComputerDisplayId,
  OpenbotComputerInputEvent,
  OpenbotComputerStreamProfile,
} from "@t3tools/contracts";
import { type RefObject, useCallback, useEffect, useRef, useState } from "react";

import {
  ComputerStreamClient,
  type ComputerStreamState,
  INITIAL_STREAM_STATE,
} from "./computerStream";

/**
 * One live display, drawn into a canvas.
 *
 * Frames never become React state: at 12 fps a `setState` per frame would
 * rerender the whole page thirty thousand times an hour. The bitmap goes
 * straight to the 2D context and only the socket's own state — who is
 * controlling, what the host is saying — makes it into React.
 */

export interface ComputerStreamView {
  readonly state: ComputerStreamState;
  /** True once something has been painted, so a placeholder can step aside. */
  readonly hasFrame: boolean;
  readonly sendInput: (events: ReadonlyArray<OpenbotComputerInputEvent>) => void;
  readonly setControl: (action: "take" | "release") => void;
}

export interface UseComputerStreamOptions {
  /** Nothing is captured on the host while this is false. */
  readonly enabled: boolean;
  readonly displayId: OpenbotComputerDisplayId | null;
  readonly profile: OpenbotComputerStreamProfile;
  /** Whether to ask for the input lease when the socket opens. */
  readonly control: boolean;
  readonly canvasRef: RefObject<HTMLCanvasElement | null>;
}

export function useComputerStream(options: UseComputerStreamOptions): ComputerStreamView {
  const { enabled, displayId, canvasRef, control } = options;
  const { maxWidthPx, fps, quality } = options.profile;
  const [state, setState] = useState<ComputerStreamState>(INITIAL_STREAM_STATE);
  const [hasFrame, setHasFrame] = useState(false);
  const clientRef = useRef<ComputerStreamClient | null>(null);
  const contextRef = useRef<CanvasRenderingContext2D | null>(null);
  const paintedRef = useRef(false);
  // The lease is asked for once, when the socket opens; taking or releasing it
  // later goes through `setControl` and must not rebuild the socket. This
  // effect is declared first so the value is current before one is opened.
  const controlRef = useRef(control);
  useEffect(() => {
    controlRef.current = control;
  }, [control]);

  const draw = useCallback(
    (bitmap: ImageBitmap) => {
      const canvas = canvasRef.current;
      if (canvas === null) {
        bitmap.close();
        return;
      }
      // Assigning either dimension clears the canvas, so only a real change.
      if (canvas.width !== bitmap.width || canvas.height !== bitmap.height) {
        canvas.width = bitmap.width;
        canvas.height = bitmap.height;
        contextRef.current = null;
      }
      const context = contextRef.current ?? canvas.getContext("2d");
      contextRef.current = context;
      context?.drawImage(bitmap, 0, 0);
      bitmap.close();
      if (!paintedRef.current) {
        paintedRef.current = true;
        setHasFrame(true);
      }
    },
    [canvasRef],
  );

  useEffect(() => {
    // Nothing to do: leaving an enabled stream already reset everything in the
    // previous effect's cleanup.
    if (!enabled || displayId === null) return;
    const client = new ComputerStreamClient({ onFrame: draw, onState: setState });
    clientRef.current = client;
    client.open(
      displayId,
      { maxWidthPx, fps, ...(quality === undefined ? {} : { quality }) },
      controlRef.current,
    );
    return () => {
      client.close();
      clientRef.current = null;
      contextRef.current = null;
      paintedRef.current = false;
      setHasFrame(false);
      setState(INITIAL_STREAM_STATE);
    };
  }, [displayId, draw, enabled, fps, maxWidthPx, quality]);

  const sendInput = useCallback((events: ReadonlyArray<OpenbotComputerInputEvent>) => {
    clientRef.current?.input(events);
  }, []);

  const setControl = useCallback((action: "take" | "release") => {
    clientRef.current?.control(action);
  }, []);

  return { state, hasFrame, sendInput, setControl };
}

/**
 * Whether this tab is on screen. A background tab must not keep asking a
 * developer's machine for frames it captures, encodes and nobody sees.
 */
export function useDocumentVisible(): boolean {
  const [visible, setVisible] = useState(
    () => typeof document === "undefined" || document.visibilityState === "visible",
  );
  useEffect(() => {
    const update = () => setVisible(document.visibilityState === "visible");
    document.addEventListener("visibilitychange", update);
    update();
    return () => document.removeEventListener("visibilitychange", update);
  }, []);
  return visible;
}

/** The stage's own size in CSS pixels, tracked so the fit scale follows layout. */
export function useElementSize(ref: RefObject<HTMLElement | null>): {
  readonly width: number;
  readonly height: number;
} {
  const [size, setSize] = useState({ width: 0, height: 0 });
  useEffect(() => {
    const element = ref.current;
    if (element === null) return;
    const observer = new ResizeObserver((entries) => {
      const rect = entries[0]?.contentRect;
      if (rect === undefined) return;
      setSize((current) =>
        current.width === rect.width && current.height === rect.height
          ? current
          : { width: rect.width, height: rect.height },
      );
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [ref]);
  return size;
}

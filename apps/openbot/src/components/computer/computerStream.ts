import {
  MAX_COMPUTER_INPUT_BATCH,
  OPENBOT_COMPUTER_STREAM_PATH,
  type OpenbotChannelId,
  type OpenbotComputerController,
  type OpenbotComputerDisplay,
  type OpenbotComputerInputEvent,
  type OpenbotComputerInputResult,
  type OpenbotComputerStreamClientMessage,
  OpenbotComputerStreamServerMessage,
  type OpenbotComputerStreamProfile,
  type OpenbotComputerStreamState as OpenbotComputerStreamStatus,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

/**
 * The viewer's half of the frame socket.
 *
 * Frames deliberately do not travel on the RPC socket, so this is a second
 * connection: JSON up, JPEG down. Everything the UI reads from it is folded
 * into one immutable state by `reduceStreamState`, which is pure and tested;
 * the class around it owns only the socket, the retry timer and the decoder.
 */

export type ComputerStreamConnection = "idle" | "connecting" | "open" | "reconnecting" | "closed";

export interface ComputerStreamAck {
  readonly seq: number;
  readonly result: OpenbotComputerInputResult;
}

export interface ComputerStreamState {
  readonly connection: ComputerStreamConnection;
  /** The display the server is capturing, once it has said hello. */
  readonly display: OpenbotComputerDisplay | null;
  /** Encoded frame size, which is the display downscaled to the profile. */
  readonly frameWidthPx: number | null;
  readonly frameHeightPx: number | null;
  readonly fps: number | null;
  readonly controller: OpenbotComputerController | null;
  /** Whether this viewer holds the input lease. */
  readonly controlling: boolean;
  readonly status: OpenbotComputerStreamStatus | null;
  readonly message: string | null;
  readonly lastAck: ComputerStreamAck | null;
  /** The `t` of the last ping the server echoed, as evidence the link is live. */
  readonly lastPongT: number | null;
}

export const INITIAL_STREAM_STATE: ComputerStreamState = {
  connection: "idle",
  display: null,
  frameWidthPx: null,
  frameHeightPx: null,
  fps: null,
  controller: null,
  controlling: false,
  status: null,
  message: null,
  lastAck: null,
  lastPongT: null,
};

export type ComputerStreamEvent =
  | { readonly type: "connecting"; readonly retry: boolean }
  | { readonly type: "opened" }
  | { readonly type: "closed"; readonly willRetry: boolean }
  | { readonly type: "failed"; readonly message: string }
  | { readonly type: "server"; readonly message: OpenbotComputerStreamServerMessage };

/**
 * Folds one socket event into the viewer's state.
 *
 * The last known display and frame size survive a drop on purpose: the canvas
 * keeps showing the last frame while the socket comes back, which reads as a
 * frozen screen rather than a flash of empty stage. Control never survives,
 * because the lease is held by a connection.
 */
export function reduceStreamState(
  state: ComputerStreamState,
  event: ComputerStreamEvent,
): ComputerStreamState {
  switch (event.type) {
    case "connecting":
      return {
        ...state,
        connection: event.retry ? "reconnecting" : "connecting",
        controlling: false,
      };
    case "opened":
      return { ...state, connection: "open" };
    case "closed":
      return {
        ...state,
        connection: event.willRetry ? "reconnecting" : "closed",
        controlling: false,
      };
    case "failed":
      return { ...state, status: "error", message: event.message };
    case "server":
      return reduceServerMessage(state, event.message);
  }
}

function reduceServerMessage(
  state: ComputerStreamState,
  message: OpenbotComputerStreamServerMessage,
): ComputerStreamState {
  switch (message.type) {
    case "hello":
      return {
        ...state,
        connection: "open",
        display: message.display,
        frameWidthPx: message.frameWidthPx,
        frameHeightPx: message.frameHeightPx,
        fps: message.fps,
        controller: message.controller,
        controlling: message.controlling,
        status: "capturing",
        message: null,
      };
    case "geometry":
      return {
        ...state,
        display: message.display,
        frameWidthPx: message.frameWidthPx,
        frameHeightPx: message.frameHeightPx,
      };
    case "controller":
      return { ...state, controller: message.controller, controlling: message.controlling };
    case "input-ack":
      return { ...state, lastAck: { seq: message.seq, result: message.result } };
    case "status":
      return { ...state, status: message.state, message: message.message };
    case "pong":
      return { ...state, lastPongT: message.t };
  }
}

/**
 * Whether a dropped socket is worth reopening. A superseded viewer, a display
 * that no longer exists and a refused permission are all answers, not
 * failures: retrying them would hammer the host and lie to the user about
 * what is wrong.
 */
export function shouldReconnect(state: ComputerStreamState): boolean {
  return (
    state.status !== "superseded" &&
    state.status !== "display-gone" &&
    state.status !== "permission-denied"
  );
}

const MIN_RETRY_MS = 500;
const MAX_RETRY_MS = 8_000;

/** Capped exponential backoff, 0.5 s doubling to 8 s. */
export function reconnectDelayMs(attempt: number): number {
  const exponent = Math.max(0, Math.floor(attempt));
  return Math.min(MIN_RETRY_MS * 2 ** exponent, MAX_RETRY_MS);
}

/** The frame socket on this origin. Same-origin means the session cookie authenticates it. */
export function computerStreamUrl(location: {
  readonly protocol: string;
  readonly host: string;
}): string {
  const scheme = location.protocol === "https:" ? "wss:" : "ws:";
  return `${scheme}//${location.host}${OPENBOT_COMPUTER_STREAM_PATH}`;
}

const decodeServerMessage = Schema.decodeUnknownOption(OpenbotComputerStreamServerMessage);

/** Parses one text frame, or nothing when a newer server said something this build cannot read. */
export function parseServerMessage(data: string): OpenbotComputerStreamServerMessage | undefined {
  try {
    return Option.getOrUndefined(decodeServerMessage(JSON.parse(data)));
  } catch {
    return undefined;
  }
}

export interface ComputerStreamHandlers {
  /** Called with a decoded frame; the client keeps no reference after this returns. */
  readonly onFrame: (bitmap: ImageBitmap) => void;
  readonly onState: (state: ComputerStreamState) => void;
}

export interface ComputerStreamClientOptions {
  readonly url?: string;
  /** Production seam for the socket, so a caller can supply its own transport. */
  readonly createSocket?: (url: string) => WebSocket;
  /** Production seam for JPEG decoding, which needs no canvas to be exercised. */
  readonly decodeFrame?: (data: ArrayBuffer) => Promise<ImageBitmap>;
}

function decodeJpegFrame(data: ArrayBuffer): Promise<ImageBitmap> {
  return createImageBitmap(new Blob([data], { type: "image/jpeg" }));
}

interface OpenRequest {
  readonly channelId: OpenbotChannelId;
  readonly profile: OpenbotComputerStreamProfile;
  readonly control: boolean;
}

const PING_INTERVAL_MS = 15_000;

/**
 * One viewer's socket: opens one chat's screen, keeps it open across drops,
 * decodes frames and reports state. The chat is all this socket ever names —
 * the server resolves it to the display it owns — so a viewer cannot aim at a
 * physical screen. Every method is safe after `close`, which is the only way
 * the client stops trying.
 */
export class ComputerStreamClient {
  readonly #handlers: ComputerStreamHandlers;
  readonly #url: string;
  readonly #createSocket: (url: string) => WebSocket;
  readonly #decodeFrame: (data: ArrayBuffer) => Promise<ImageBitmap>;
  #socket: WebSocket | null = null;
  #listeners: AbortController | null = null;
  #request: OpenRequest | null = null;
  #state: ComputerStreamState = INITIAL_STREAM_STATE;
  #attempt = 0;
  #retryTimer: ReturnType<typeof setTimeout> | null = null;
  #pingTimer: ReturnType<typeof setInterval> | null = null;
  #seq = 0;
  #closed = false;
  /** A frame is being decoded; newer frames replace `#pendingFrame` instead of queuing. */
  #decoding = false;
  #pendingFrame: ArrayBuffer | null = null;
  /**
   * Bumped whenever every frame in flight stops being worth painting: a switch
   * to another chat and a close. A decode that finishes with an older
   * generation closes its bitmap instead of handing it to the canvas.
   */
  #generation = 0;
  /** Whether this socket has said which display it is capturing for this open. */
  #acknowledged = false;

  constructor(handlers: ComputerStreamHandlers, options: ComputerStreamClientOptions = {}) {
    this.#handlers = handlers;
    this.#url = options.url ?? computerStreamUrl(window.location);
    this.#createSocket = options.createSocket ?? ((url) => new WebSocket(url));
    this.#decodeFrame = options.decodeFrame ?? decodeJpegFrame;
  }

  get state(): ComputerStreamState {
    return this.#state;
  }

  /** Starts (or switches to) one chat's screen. Nothing is captured until this is called. */
  open(channelId: OpenbotChannelId, profile: OpenbotComputerStreamProfile, control: boolean): void {
    if (this.#closed) return;
    this.#request = { channelId, profile, control };
    this.#state = INITIAL_STREAM_STATE;
    this.#attempt = 0;
    this.#invalidateFrames();
    this.#teardownSocket();
    this.#connect(false);
  }

  /**
   * Sends input; dropped when the socket is down, because stale input is worse
   * than none. The contract bounds one batch, and a long paste is many `text`
   * events, so more than a batch's worth goes as ordered messages rather than
   * as one message the server has to reject whole.
   */
  input(events: ReadonlyArray<OpenbotComputerInputEvent>): void {
    for (let start = 0; start < events.length; start += MAX_COMPUTER_INPUT_BATCH) {
      this.#seq += 1;
      this.#send({
        type: "input",
        seq: this.#seq,
        events: events.slice(start, start + MAX_COMPUTER_INPUT_BATCH),
      });
    }
  }

  control(action: "take" | "release"): void {
    this.#send({ type: "control", action });
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#send({ type: "close" });
    this.#invalidateFrames();
    this.#teardownSocket();
    this.#apply({ type: "closed", willRetry: false });
  }

  /**
   * Everything already decoded or queued belongs to the screen this client has
   * just stopped showing, so it is dropped rather than painted late.
   */
  #invalidateFrames(): void {
    this.#generation += 1;
    this.#pendingFrame = null;
    this.#acknowledged = false;
  }

  #connect(retry: boolean): void {
    const request = this.#request;
    if (request === null || this.#closed) return;
    // A new socket has said nothing yet, so nothing it sends is trusted to be
    // the requested chat's screen until its `hello` arrives.
    this.#acknowledged = false;
    this.#apply({ type: "connecting", retry });
    const socket = this.#createSocket(this.#url);
    socket.binaryType = "arraybuffer";
    this.#socket = socket;
    // One abort per socket: tearing it down detaches every listener at once,
    // so a socket this client has moved on from cannot report anything.
    const listeners = new AbortController();
    this.#listeners = listeners;
    const { signal } = listeners;
    socket.addEventListener(
      "open",
      () => {
        this.#apply({ type: "opened" });
        this.#send({
          type: "open",
          channelId: request.channelId,
          maxWidthPx: request.profile.maxWidthPx,
          fps: request.profile.fps,
          ...(request.profile.quality === undefined ? {} : { quality: request.profile.quality }),
          control: request.control,
        });
        this.#startPings();
      },
      { signal },
    );
    socket.addEventListener(
      "message",
      (event: MessageEvent<unknown>) => {
        if (typeof event.data === "string") {
          const message = parseServerMessage(event.data);
          if (message !== undefined) {
            if (message.type === "hello") this.#attempt = 0;
            if (message.type === "hello" || message.type === "geometry") {
              this.#acknowledged = true;
            }
            this.#apply({ type: "server", message });
          }
          return;
        }
        if (event.data instanceof ArrayBuffer) this.#acceptFrame(event.data);
      },
      { signal },
    );
    socket.addEventListener(
      "error",
      () => {
        this.#apply({ type: "failed", message: "The connection to the host's screen failed." });
      },
      { signal },
    );
    socket.addEventListener(
      "close",
      () => {
        this.#socket = null;
        this.#listeners = null;
        this.#stopPings();
        const willRetry = !this.#closed && this.#request !== null && shouldReconnect(this.#state);
        this.#apply({ type: "closed", willRetry });
        if (willRetry) {
          this.#retryTimer = setTimeout(() => {
            this.#retryTimer = null;
            this.#connect(true);
          }, reconnectDelayMs(this.#attempt));
          this.#attempt += 1;
        }
      },
      { signal },
    );
  }

  #startPings(): void {
    this.#stopPings();
    this.#pingTimer = setInterval(() => {
      this.#send({ type: "ping", t: Date.now() });
    }, PING_INTERVAL_MS);
  }

  #stopPings(): void {
    if (this.#pingTimer !== null) {
      clearInterval(this.#pingTimer);
      this.#pingTimer = null;
    }
  }

  #teardownSocket(): void {
    if (this.#retryTimer !== null) {
      clearTimeout(this.#retryTimer);
      this.#retryTimer = null;
    }
    this.#stopPings();
    const socket = this.#socket;
    this.#socket = null;
    this.#listeners?.abort();
    this.#listeners = null;
    socket?.close();
  }

  #send(message: OpenbotComputerStreamClientMessage): void {
    const socket = this.#socket;
    if (socket === null || socket.readyState !== WebSocket.OPEN) return;
    socket.send(JSON.stringify(message));
  }

  /**
   * Newest frame wins. A slow decoder must never build a queue: a viewer that
   * is one second behind is showing a screen the user is already clicking on.
   *
   * Frames the server sent before it acknowledged this open still show the
   * previous screen, and the switch may land mid-decode, so both the arrival
   * and the completion are checked against what is wanted now.
   */
  #acceptFrame(data: ArrayBuffer): void {
    if (this.#request === null || !this.#acknowledged) return;
    if (this.#decoding) {
      this.#pendingFrame = data;
      return;
    }
    this.#decoding = true;
    const generation = this.#generation;
    void this.#decodeFrame(data)
      .then((bitmap) => {
        if (this.#closed || generation !== this.#generation) {
          bitmap.close();
          return;
        }
        this.#handlers.onFrame(bitmap);
      })
      .catch(() => {
        // A corrupt frame is not worth reporting; the next one arrives in ~80 ms.
      })
      .finally(() => {
        this.#decoding = false;
        // Anything still pending arrived after the last invalidation, and
        // `#acceptFrame` checks the open again before decoding it.
        const pending = this.#pendingFrame;
        this.#pendingFrame = null;
        if (pending !== null && !this.#closed) this.#acceptFrame(pending);
      });
  }

  #apply(event: ComputerStreamEvent): void {
    const next = reduceStreamState(this.#state, event);
    if (next === this.#state) return;
    this.#state = next;
    this.#handlers.onState(next);
  }
}

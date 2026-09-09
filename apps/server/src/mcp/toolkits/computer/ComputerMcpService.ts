import {
  COMPUTER_SCREENSHOT_DEFAULT_MAX_WIDTH_PX,
  COMPUTER_SHARED_FOCUS_LIMITATION,
  OpenbotComputerMcpFailure,
  type ComputerFocusWindowInput,
  type ComputerInputInput,
  type ComputerInputResult,
  type ComputerLaunchInput,
  type ComputerLaunchResult,
  type ComputerListWindowsResult,
  type ComputerScreenshotInput,
  type ComputerScreenshotResult,
  type ComputerStatusResult,
  type OpenbotChatComputer,
  type OpenbotComputerError,
  type ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { OpenbotChatComputerService } from "../../../openbot/computer/OpenbotChatComputer.ts";
import {
  McpInvocationContext,
  requireMcpCapability,
  type McpInvocationScope,
} from "../../McpInvocationContext.ts";

/**
 * The agent's side of its chat's computer.
 *
 * A thread never names a display: the chat it belongs to owns exactly one
 * screen, and `OpenbotChatComputerService` decides which one that is, creates
 * it on first use, and refuses anything aimed elsewhere. Underneath, the lease
 * is unchanged — agent input joins the person's own input in one ordered queue,
 * nothing here holds control across calls, and a person who has taken control
 * makes the batch fail rather than losing the pointer to an agent mid-sentence.
 */
export class ComputerMcpService extends Context.Service<
  ComputerMcpService,
  {
    /** Also what provisions the chat's screen: the first tool call in a chat
        is usually this one, and an agent that has to ask twice for a computer
        that exists to be created is worse than a status call with a side
        effect. */
    readonly status: (
      scope: McpInvocationScope,
    ) => Effect.Effect<ComputerStatusResult, OpenbotComputerMcpFailure>;
    readonly screenshot: (
      scope: McpInvocationScope,
      input: ComputerScreenshotInput,
    ) => Effect.Effect<ComputerScreenshotResult, OpenbotComputerMcpFailure>;
    readonly listWindows: (
      scope: McpInvocationScope,
    ) => Effect.Effect<ComputerListWindowsResult, OpenbotComputerMcpFailure>;
    /** Returns the window list after the change, which is the only honest
        confirmation that focus landed where it was asked to. Raising a window
        moves focus on a shared desktop, so it goes through the lease and fails
        while a person is controlling. */
    readonly focusWindow: (
      scope: McpInvocationScope,
      input: ComputerFocusWindowInput,
    ) => Effect.Effect<ComputerListWindowsResult, OpenbotComputerMcpFailure>;
    /** Input is attributed: the thread becomes the named controller for the
        length of the batch. */
    readonly input: (
      scope: McpInvocationScope,
      input: ComputerInputInput,
    ) => Effect.Effect<ComputerInputResult, OpenbotComputerMcpFailure>;
    /** Also lease-bound: launching activates the new app on a screen the
        person may be watching. */
    readonly launch: (
      scope: McpInvocationScope,
      input: ComputerLaunchInput,
    ) => Effect.Effect<ComputerLaunchResult, OpenbotComputerMcpFailure>;
  }
>()("t3/mcp/toolkits/computer/ComputerMcpService") {}

/**
 * Runs one computer tool: refuse unless this credential carries the "computer"
 * capability, then hand the calling scope to the service. Every `computer_*`
 * handler goes through here, so the gate cannot be forgotten on a new tool, and
 * a session whose user turned agent computer access off gets the same readable
 * failure from all of them.
 */
export const withComputerAccess = <A>(
  run: (
    service: ComputerMcpService["Service"],
    scope: McpInvocationScope,
  ) => Effect.Effect<A, OpenbotComputerMcpFailure>,
): Effect.Effect<A, OpenbotComputerMcpFailure, ComputerMcpService | McpInvocationContext> =>
  requireMcpCapability("computer").pipe(
    Effect.flatMap((scope) => Effect.flatMap(ComputerMcpService, (service) => run(service, scope))),
  );

/**
 * The badge other viewers see while this agent's batch holds the lease. Short
 * because it sits in a status pill beside the person's own name.
 */
export const agentControllerLabel = (threadId: ThreadId): string =>
  `Agent (${threadId.replace(/^thread[:-]/, "").slice(0, 8)})`;

/**
 * Codes carry over unchanged: the MCP failure exists to cross the tool
 * boundary, not to reinterpret the backend. Only `not_controlling` gains text,
 * because it is the one failure whose correct handling — say something, stop —
 * is the opposite of what a model does by default with a refused action.
 */
export const toComputerMcpFailure = (error: OpenbotComputerError): OpenbotComputerMcpFailure =>
  new OpenbotComputerMcpFailure({
    code: error.code,
    message:
      error.code === "not_controlling"
        ? `${error.message} A person is controlling the shared desktop right now. Tell them what you were about to do instead of retrying.`
        : error.message,
  });

const summarize = (computer: OpenbotChatComputer): ComputerStatusResult => ({
  chat: computer.channelName,
  state: computer.state,
  display: computer.display,
  detail: computer.detail,
  windows: computer.windows,
  controller: computer.controller,
  canLaunch: computer.canLaunch,
  sharing: COMPUTER_SHARED_FOCUS_LIMITATION,
});

/** The lease identity of one thread's tool call. Focus, launch, and input all
    answer to it, so an agent cannot move a window out from under the person
    who is controlling. */
const agentSource = (scope: McpInvocationScope) =>
  ({
    kind: "agent",
    threadId: scope.threadId,
    label: agentControllerLabel(scope.threadId),
  }) as const;

const make = Effect.gen(function* () {
  const chatComputer = yield* OpenbotChatComputerService;

  /** Which chat's computer this thread works on. Everything else in this file
      starts here, so a tool can never reach a screen another chat owns. */
  const channelFor = (scope: McpInvocationScope) =>
    chatComputer.channelForThread(scope.threadId).pipe(Effect.mapError(toComputerMcpFailure));

  const listWindows: ComputerMcpService["Service"]["listWindows"] = Effect.fn(
    "ComputerMcpService.listWindows",
  )(function* (scope) {
    const channelId = yield* channelFor(scope);
    const computer = yield* chatComputer
      .ensure(channelId)
      .pipe(Effect.mapError(toComputerMcpFailure));
    return { windows: computer.windows };
  });

  return ComputerMcpService.of({
    status: Effect.fn("ComputerMcpService.status")(function* (scope) {
      const channelId = yield* channelFor(scope);
      const computer = yield* chatComputer
        .ensure(channelId)
        .pipe(Effect.mapError(toComputerMcpFailure));
      return summarize(computer);
    }),
    screenshot: Effect.fn("ComputerMcpService.screenshot")(function* (scope, input) {
      const channelId = yield* channelFor(scope);
      // The chat's screen is also the coordinate space, so its width is what
      // turns image pixels back into points `computer_input` accepts.
      const computer = yield* chatComputer
        .ensure(channelId)
        .pipe(Effect.mapError(toComputerMcpFailure));
      if (computer.display === null) {
        return yield* new OpenbotComputerMcpFailure({
          code: "backend_unavailable",
          message: computer.detail ?? `This chat has no computer to capture (${computer.state}).`,
        });
      }
      const maxWidthPx = input.maxWidthPx ?? COMPUTER_SCREENSHOT_DEFAULT_MAX_WIDTH_PX;
      const snapshot = yield* chatComputer
        .snapshot(channelId, maxWidthPx)
        .pipe(Effect.mapError(toComputerMcpFailure));
      const widthPx = snapshot.widthPx;
      const heightPx = snapshot.heightPx;
      if (widthPx === undefined || heightPx === undefined || widthPx <= 0) {
        // Without the encoded size there is no scale, and a point read off an
        // image of unknown size would click somewhere else entirely.
        return yield* new OpenbotComputerMcpFailure({
          code: "capture_failed",
          message:
            "The capture did not report its pixel size, so image coordinates cannot be mapped to the display.",
        });
      }
      return {
        image: {
          mimeType: "image/jpeg",
          data: snapshot.dataBase64,
          widthPx,
          heightPx,
        },
        displayId: computer.display.id,
        scale: computer.display.widthPx / widthPx,
        capturedAt: snapshot.capturedAt,
        caveat: snapshot.caveat,
      } as const;
    }),
    listWindows,
    focusWindow: Effect.fn("ComputerMcpService.focusWindow")(function* (scope, input) {
      const channelId = yield* channelFor(scope);
      yield* chatComputer
        .focusWindow(agentSource(scope), channelId, input.windowId)
        .pipe(Effect.mapError(toComputerMcpFailure));
      return yield* listWindows(scope);
    }),
    input: Effect.fn("ComputerMcpService.input")(function* (scope, batch) {
      const channelId = yield* channelFor(scope);
      return yield* chatComputer
        .input(agentSource(scope), channelId, batch.events)
        .pipe(Effect.mapError(toComputerMcpFailure));
    }),
    launch: Effect.fn("ComputerMcpService.launch")(function* (scope, input) {
      const channelId = yield* channelFor(scope);
      const computer = yield* chatComputer
        .ensure(channelId)
        .pipe(Effect.mapError(toComputerMcpFailure));
      if (computer.display === null) {
        return yield* new OpenbotComputerMcpFailure({
          code: "backend_unavailable",
          message:
            computer.detail ?? `This chat has no computer to launch onto (${computer.state}).`,
        });
      }
      const launched = yield* chatComputer
        .launch(agentSource(scope), channelId, {
          app: input.app,
          ...(input.args === undefined ? {} : { args: input.args }),
        })
        .pipe(Effect.mapError(toComputerMcpFailure));
      return { pid: launched.pid, displayId: computer.display.id };
    }),
  });
});

export const layer = Layer.effect(ComputerMcpService, make);

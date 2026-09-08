import {
  COMPUTER_SCREENSHOT_DEFAULT_MAX_WIDTH_PX,
  OpenbotComputerMcpFailure,
  type ComputerFocusWindowInput,
  type ComputerInputInput,
  type ComputerInputResult,
  type ComputerLaunchInput,
  type ComputerLaunchResult,
  type ComputerListWindowsInput,
  type ComputerListWindowsResult,
  type ComputerManageDisplayInput,
  type ComputerManageDisplayRequest,
  type ComputerManageDisplayResult,
  type ComputerScreenshotInput,
  type ComputerScreenshotResult,
  type ComputerStatusResult,
  type OpenbotComputerDisplay,
  type OpenbotComputerDisplayId,
  type OpenbotComputerError,
  type OpenbotComputerStatus,
  type ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { OpenbotComputerSession } from "../../../openbot/computer/OpenbotComputerSession.ts";
import {
  McpInvocationContext,
  requireMcpCapability,
  type McpInvocationScope,
} from "../../McpInvocationContext.ts";

/**
 * The agent's side of the shared desktop.
 *
 * Every operation goes through the same `OpenbotComputerSession` the human
 * viewer uses, so agent input joins the person's own input in one ordered
 * per-display queue under one lease. Nothing here holds control across calls: a
 * batch takes the lease if it is free and gives it straight back, and a person
 * who has taken control makes the batch fail rather than losing the pointer to
 * an agent mid-sentence.
 */
export class ComputerMcpService extends Context.Service<
  ComputerMcpService,
  {
    readonly status: Effect.Effect<ComputerStatusResult, OpenbotComputerMcpFailure>;
    readonly screenshot: (
      input: ComputerScreenshotInput,
    ) => Effect.Effect<ComputerScreenshotResult, OpenbotComputerMcpFailure>;
    readonly listWindows: (
      input: ComputerListWindowsInput,
    ) => Effect.Effect<ComputerListWindowsResult, OpenbotComputerMcpFailure>;
    /** Returns the window list after the change, which is the only honest
        confirmation that focus landed where it was asked to. */
    readonly focusWindow: (
      input: ComputerFocusWindowInput,
    ) => Effect.Effect<ComputerListWindowsResult, OpenbotComputerMcpFailure>;
    /** Takes the calling scope because input is attributed: the thread becomes
        the named controller for the length of the batch. */
    readonly input: (
      scope: McpInvocationScope,
      input: ComputerInputInput,
    ) => Effect.Effect<ComputerInputResult, OpenbotComputerMcpFailure>;
    readonly manageDisplay: (
      input: ComputerManageDisplayInput,
    ) => Effect.Effect<ComputerManageDisplayResult, OpenbotComputerMcpFailure>;
    readonly launch: (
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

/**
 * Turns the flat tool input into the variant it meant. The schema cannot say
 * "widthPx only with create" without becoming an `anyOf` that MCP clients
 * reject, so the pairing is checked here, once, before anything reaches a
 * backend.
 */
const parseManageDisplay = (
  input: ComputerManageDisplayInput,
): Effect.Effect<ComputerManageDisplayRequest, OpenbotComputerMcpFailure> => {
  if (input.action === "create") {
    return input.widthPx === undefined || input.heightPx === undefined
      ? Effect.fail(
          new OpenbotComputerMcpFailure({
            code: "invalid_input",
            message: "Creating a display needs both widthPx and heightPx.",
          }),
        )
      : Effect.succeed({
          action: "create",
          name: input.name,
          widthPx: input.widthPx,
          heightPx: input.heightPx,
          hiDpi: input.hiDpi,
        });
  }
  return input.displayId === undefined
    ? Effect.fail(
        new OpenbotComputerMcpFailure({
          code: "invalid_input",
          message: "Destroying a display needs the displayId of a managed display.",
        }),
      )
    : Effect.succeed({ action: "destroy", displayId: input.displayId });
};

const summarizeStatus = (status: OpenbotComputerStatus): ComputerStatusResult => ({
  host: status.host,
  session: status.session,
  availability: status.availability,
  detail: status.detail,
  permissions: status.permissions,
  setup:
    status.setup === null
      ? null
      : {
          ready: status.setup.ready,
          missing: status.setup.dependencies
            .filter((dependency) => !dependency.present)
            .map((dependency) => dependency.name),
          install: status.setup.dependencies.flatMap((dependency) =>
            dependency.present || dependency.install === null ? [] : [dependency.install],
          ),
          notes: status.setup.notes,
        },
  capabilities: status.capabilities,
  displays: status.displays,
  controller: status.controller,
});

const make = Effect.gen(function* () {
  const session = yield* OpenbotComputerSession;

  /** Names the known displays when it fails: acting on the wrong screen is
      worse than one extra round trip. */
  const resolveDisplay = Effect.fn("ComputerMcpService.resolveDisplay")(function* (
    displayId: OpenbotComputerDisplayId | undefined,
  ) {
    const displays = yield* session.listDisplays.pipe(Effect.mapError(toComputerMcpFailure));
    const target: OpenbotComputerDisplay | undefined =
      displayId === undefined
        ? (displays.find((display) => display.main) ?? displays[0])
        : displays.find((display) => display.id === displayId);
    if (target === undefined) {
      return yield* new OpenbotComputerMcpFailure({
        code: "display_not_found",
        message:
          displays.length === 0
            ? "This computer reports no displays."
            : `No display ${displayId ?? "(main)"}. Known displays: ${displays
                .map((display) => `${display.id} (${display.name})`)
                .join(", ")}.`,
      });
    }
    return target;
  });

  const listWindows: ComputerMcpService["Service"]["listWindows"] = Effect.fn(
    "ComputerMcpService.listWindows",
  )(function* (input) {
    const windows = yield* session
      .listWindows(input.displayId)
      .pipe(Effect.mapError(toComputerMcpFailure));
    return { windows };
  });

  return ComputerMcpService.of({
    status: session.status.pipe(
      Effect.map(summarizeStatus),
      Effect.withSpan("ComputerMcpService.status"),
    ),
    screenshot: Effect.fn("ComputerMcpService.screenshot")(function* (input) {
      const target = yield* resolveDisplay(input.displayId);
      const maxWidthPx = input.maxWidthPx ?? COMPUTER_SCREENSHOT_DEFAULT_MAX_WIDTH_PX;
      const snapshot = yield* session
        .snapshot({ displayId: target.id, maxWidthPx })
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
        displayId: target.id,
        scale: target.widthPx / widthPx,
        capturedAt: snapshot.capturedAt,
        caveat: snapshot.caveat,
      } as const;
    }),
    listWindows,
    focusWindow: Effect.fn("ComputerMcpService.focusWindow")(function* (input) {
      yield* session.focusWindow(input.windowId).pipe(Effect.mapError(toComputerMcpFailure));
      return yield* listWindows({});
    }),
    input: Effect.fn("ComputerMcpService.input")(function* (scope, batch) {
      const source = {
        kind: "agent",
        threadId: scope.threadId,
        label: agentControllerLabel(scope.threadId),
      } as const;
      return yield* session
        .agentInput(source, batch.displayId, batch.events)
        .pipe(Effect.mapError(toComputerMcpFailure));
    }),
    manageDisplay: Effect.fn("ComputerMcpService.manageDisplay")(function* (input) {
      const request = yield* parseManageDisplay(input);
      const display =
        request.action === "create"
          ? yield* session
              .createDisplay({
                ...(request.name === undefined ? {} : { name: request.name }),
                widthPx: request.widthPx,
                heightPx: request.heightPx,
                ...(request.hiDpi === undefined ? {} : { hiDpi: request.hiDpi }),
              })
              .pipe(Effect.mapError(toComputerMcpFailure))
          : yield* session
              .destroyDisplay(request.displayId)
              .pipe(Effect.mapError(toComputerMcpFailure), Effect.as(null));
      const displays = yield* session.listDisplays.pipe(Effect.mapError(toComputerMcpFailure));
      return { action: request.action, display, displays };
    }),
    launch: Effect.fn("ComputerMcpService.launch")(function* (input) {
      const target = yield* resolveDisplay(input.displayId);
      const launched = yield* session
        .launch({
          app: input.app,
          ...(input.args === undefined ? {} : { args: input.args }),
          displayId: target.id,
        })
        .pipe(Effect.mapError(toComputerMcpFailure));
      return { pid: launched.pid, displayId: target.id };
    }),
  });
});

export const layer = Layer.effect(ComputerMcpService, make);

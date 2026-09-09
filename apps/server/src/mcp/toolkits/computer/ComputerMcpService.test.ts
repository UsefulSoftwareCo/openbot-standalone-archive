import { assert, it } from "@effect/vitest";
import {
  EnvironmentId,
  OpenbotChannelId,
  OpenbotComputerDisplayId,
  OpenbotComputerError,
  OpenbotComputerWindowId,
  ProviderInstanceId,
  ThreadId,
  type OpenbotChatComputer,
  type OpenbotComputerDisplay,
  type OpenbotComputerInputEvent,
  type OpenbotComputerWindow,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { OpenbotChatComputerService } from "../../../openbot/computer/OpenbotChatComputer.ts";
import {
  McpInvocationContext,
  type McpCapability,
  type McpInvocationScope,
} from "../../McpInvocationContext.ts";
import * as ComputerMcp from "./ComputerMcpService.ts";

const threadId = ThreadId.make("thread:computer-caller");
const channelId = OpenbotChannelId.make("channel:parent");
const chatDisplayId = OpenbotComputerDisplayId.make("managed-1");

const scopeWith = (capabilities: ReadonlyArray<McpCapability>): McpInvocationScope => ({
  environmentId: EnvironmentId.make("environment:computer-test"),
  threadId,
  providerSessionId: "provider-session:computer-test",
  providerInstanceId: ProviderInstanceId.make("codex"),
  capabilities: new Set(capabilities),
  issuedAt: 1,
});

const chatDisplay: OpenbotComputerDisplay = {
  id: chatDisplayId,
  name: "Research bot",
  kind: "managed-virtual",
  widthPx: 1680,
  heightPx: 1050,
  scale: 2,
  main: false,
  managed: true,
};

const chatWindow: OpenbotComputerWindow = {
  id: OpenbotComputerWindowId.make("window:safari"),
  displayId: chatDisplayId,
  title: "Safari",
  app: "Safari",
  pid: 501,
  x: 0,
  y: 0,
  width: 1200,
  height: 800,
  focused: false,
  minimized: false,
};

const chatComputer: OpenbotChatComputer = {
  channelId,
  channelName: "Research bot",
  state: "ready",
  display: chatDisplay,
  detail: null,
  windows: [chatWindow],
  controller: { kind: "viewer", label: "Rhys", since: "2026-09-08T10:00:00.000Z" },
  canLaunch: true,
  checkedAt: "2026-09-08T10:00:02.000Z",
};

const run = <A, E>(
  effect: Effect.Effect<A, E, ComputerMcp.ComputerMcpService | McpInvocationContext>,
  options: {
    readonly chatComputer: Partial<OpenbotChatComputerService["Service"]>;
    readonly capabilities?: ReadonlyArray<McpCapability>;
  },
) =>
  effect.pipe(
    Effect.provideService(McpInvocationContext, scopeWith(options.capabilities ?? ["computer"])),
    Effect.provide(
      ComputerMcp.layer.pipe(
        Layer.provide(
          Layer.mock(OpenbotChatComputerService)({
            channelForThread: () => Effect.succeed(channelId),
            ...options.chatComputer,
          } satisfies Partial<OpenbotChatComputerService["Service"]>),
        ),
      ),
    ),
  );

it.effect("refuses every computer tool when the credential withholds the capability", () =>
  Effect.gen(function* () {
    const failure = yield* run(
      ComputerMcp.withComputerAccess((service, scope) => service.status(scope)),
      {
        chatComputer: { ensure: () => Effect.succeed(chatComputer) },
        capabilities: ["preview", "orchestration"],
      },
    ).pipe(Effect.flip);

    assert.equal(failure._tag, "OpenbotComputerMcpFailure");
    assert.equal(failure.code, "unsupported");
    assert.include(failure.message, "not allowed to control the computer");
  }),
);

it.effect("status describes the calling thread's chat computer and provisions it", () =>
  Effect.gen(function* () {
    const ensured: Array<string> = [];

    const result = yield* run(
      ComputerMcp.withComputerAccess((service, scope) => service.status(scope)),
      {
        chatComputer: {
          ensure: (id) =>
            Effect.sync(() => {
              ensured.push(id);
              return chatComputer;
            }),
        },
      },
    );

    assert.deepEqual(ensured, [channelId]);
    assert.equal(result.chat, "Research bot");
    assert.equal(result.state, "ready");
    assert.equal(result.display?.widthPx, 1680);
    assert.deepEqual(result.windows, [chatWindow]);
    assert.deepEqual(result.controller, chatComputer.controller);
    assert.equal(result.canLaunch, true);
    assert.include(result.sharing, "one frontmost app");
    // Nothing in the result names a display the agent could target instead.
    assert.isUndefined((result as { displays?: unknown }).displays);
  }),
);

it.effect("reports the scale that maps screenshot pixels back to the chat display", () =>
  Effect.gen(function* () {
    const captured: Array<readonly [string, number | undefined]> = [];

    const result = yield* run(
      ComputerMcp.withComputerAccess((service, scope) => service.screenshot(scope, {})),
      {
        chatComputer: {
          ensure: () => Effect.succeed(chatComputer),
          snapshot: (id, maxWidthPx) =>
            Effect.sync(() => {
              captured.push([id, maxWidthPx]);
              return {
                mimeType: "image/jpeg" as const,
                dataBase64: "ZmFrZQ==",
                widthPx: 840,
                heightPx: 525,
                displayId: chatDisplayId,
                capturedAt: "2026-09-08T10:00:03.000Z",
                caveat: null,
              };
            }),
        },
      },
    );

    // The chat is named, never a display, and 1680 / 840 says a point measured
    // on the image doubles to reach the screen.
    assert.deepEqual(captured, [[channelId, 1280]]);
    assert.equal(result.displayId, chatDisplayId);
    assert.equal(result.scale, 2);
    assert.equal(result.image.widthPx, 840);
    assert.equal(result.image.data, "ZmFrZQ==");
  }),
);

it.effect("passes an input batch through untouched and names the agent as controller", () =>
  Effect.gen(function* () {
    const events: ReadonlyArray<OpenbotComputerInputEvent> = [
      { type: "move", point: { x: 10, y: 20 } },
      { type: "click", button: "left", count: 1, point: { x: 10, y: 20 } },
    ];
    const seen: Array<{
      readonly label: string;
      readonly channelId: string;
      readonly events: ReadonlyArray<OpenbotComputerInputEvent>;
    }> = [];

    const result = yield* run(
      ComputerMcp.withComputerAccess((service, scope) => service.input(scope, { events })),
      {
        chatComputer: {
          input: (source, id, batch) =>
            Effect.sync(() => {
              seen.push({ label: source.label, channelId: id, events: batch });
              return { delivered: batch.length, rejected: [] };
            }),
        },
      },
    );

    assert.deepEqual(result, { delivered: 2, rejected: [] });
    assert.deepEqual(seen, [
      { label: ComputerMcp.agentControllerLabel(threadId), channelId, events },
    ]);
  }),
);

it.effect("turns a human's control into a not_controlling failure that says to stop", () =>
  Effect.gen(function* () {
    const failure = yield* run(
      ComputerMcp.withComputerAccess((service, scope) =>
        service.input(scope, { events: [{ type: "key-press", key: "Enter" }] }),
      ),
      {
        chatComputer: {
          input: () =>
            Effect.fail(
              new OpenbotComputerError({
                code: "not_controlling",
                message: "Rhys is controlling this computer.",
              }),
            ),
        },
      },
    ).pipe(Effect.flip);

    assert.equal(failure.code, "not_controlling");
    assert.include(failure.message, "Rhys is controlling this computer.");
    assert.include(failure.message, "instead of retrying");
  }),
);

it.effect("focusing a window off the chat's screen keeps the backend's refusal", () =>
  Effect.gen(function* () {
    const failure = yield* run(
      ComputerMcp.withComputerAccess((service, scope) =>
        service.focusWindow(scope, {
          windowId: OpenbotComputerWindowId.make("window:on-the-persons-screen"),
        }),
      ),
      {
        chatComputer: {
          focusWindow: () =>
            Effect.fail(
              new OpenbotComputerError({
                code: "window_not_found",
                message: "Window window:on-the-persons-screen is not on Research bot's computer.",
              }),
            ),
        },
      },
    ).pipe(Effect.flip);

    assert.equal(failure.code, "window_not_found");
    assert.include(failure.message, "not on Research bot's computer");
  }),
);

it.effect("launches onto the chat's screen without being told which one", () =>
  Effect.gen(function* () {
    const launched: Array<{ readonly channelId: string; readonly app: string }> = [];

    const result = yield* run(
      ComputerMcp.withComputerAccess((service, scope) => service.launch(scope, { app: "Safari" })),
      {
        chatComputer: {
          ensure: () => Effect.succeed(chatComputer),
          launch: (_source, id, input) =>
            Effect.sync(() => {
              launched.push({ channelId: id, app: input.app });
              return { pid: 4321 };
            }),
        },
      },
    );

    assert.deepEqual(launched, [{ channelId, app: "Safari" }]);
    assert.deepEqual(result, { pid: 4321, displayId: chatDisplayId });
  }),
);

it.effect("says why there is nothing to capture when the chat has no computer", () =>
  Effect.gen(function* () {
    const failure = yield* run(
      ComputerMcp.withComputerAccess((service, scope) => service.screenshot(scope, {})),
      {
        chatComputer: {
          ensure: () =>
            Effect.succeed({
              ...chatComputer,
              state: "unavailable",
              display: null,
              windows: [],
              canLaunch: false,
              detail: "The helper is not running.",
            } satisfies OpenbotChatComputer),
        },
      },
    ).pipe(Effect.flip);

    assert.equal(failure.code, "backend_unavailable");
    assert.include(failure.message, "The helper is not running.");
  }),
);

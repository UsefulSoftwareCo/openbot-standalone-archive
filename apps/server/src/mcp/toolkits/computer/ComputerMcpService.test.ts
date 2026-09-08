import { assert, it } from "@effect/vitest";
import {
  EnvironmentId,
  NO_COMPUTER_CAPABILITIES,
  OpenbotComputerDisplayId,
  OpenbotComputerError,
  ProviderInstanceId,
  ThreadId,
  type OpenbotComputerDisplay,
  type OpenbotComputerInputEvent,
  type OpenbotComputerStatus,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { OpenbotComputerSession } from "../../../openbot/computer/OpenbotComputerSession.ts";
import {
  McpInvocationContext,
  type McpCapability,
  type McpInvocationScope,
} from "../../McpInvocationContext.ts";
import * as ComputerMcp from "./ComputerMcpService.ts";

const threadId = ThreadId.make("thread:computer-caller");
const mainDisplayId = OpenbotComputerDisplayId.make("1");
const secondDisplayId = OpenbotComputerDisplayId.make("2");

const scopeWith = (capabilities: ReadonlyArray<McpCapability>): McpInvocationScope => ({
  environmentId: EnvironmentId.make("environment:computer-test"),
  threadId,
  providerSessionId: "provider-session:computer-test",
  providerInstanceId: ProviderInstanceId.make("codex"),
  capabilities: new Set(capabilities),
  issuedAt: 1,
});

const mainDisplay: OpenbotComputerDisplay = {
  id: mainDisplayId,
  name: "Built-in Retina Display",
  kind: "physical",
  widthPx: 3024,
  heightPx: 1964,
  scale: 2,
  main: true,
  managed: false,
};

const managedDisplay: OpenbotComputerDisplay = {
  id: secondDisplayId,
  name: "Agent workspace",
  kind: "managed-virtual",
  widthPx: 1440,
  heightPx: 900,
  scale: 1,
  main: false,
  managed: true,
};

const status: OpenbotComputerStatus = {
  host: { label: "studio", platform: "darwin" },
  session: "signed-in-desktop",
  availability: "ready",
  detail: null,
  permissions: {
    screenCapture: "granted",
    accessibility: "denied",
    detail: "Grant it in Settings",
  },
  setup: {
    ready: false,
    dependencies: [
      { name: "ffmpeg", present: false, path: null, install: "brew install ffmpeg" },
      { name: "xdotool", present: false, path: null, install: null },
      { name: "Xvfb", present: true, path: "/usr/bin/Xvfb", install: null },
    ],
    notes: ["Wayland is not supported."],
  },
  capabilities: { ...NO_COMPUTER_CAPABILITIES, stream: true, input: true, windows: true },
  displays: [mainDisplay],
  windows: [],
  controller: { kind: "viewer", label: "Rhys", since: "2026-09-08T10:00:00.000Z" },
  lastCaptureAt: "2026-09-08T10:00:01.000Z",
  lastError: null,
  checkedAt: "2026-09-08T10:00:02.000Z",
};

const run = <A, E>(
  effect: Effect.Effect<A, E, ComputerMcp.ComputerMcpService | McpInvocationContext>,
  options: {
    readonly session: Partial<OpenbotComputerSession["Service"]>;
    readonly capabilities?: ReadonlyArray<McpCapability>;
  },
) =>
  effect.pipe(
    Effect.provideService(McpInvocationContext, scopeWith(options.capabilities ?? ["computer"])),
    Effect.provide(
      ComputerMcp.layer.pipe(
        Layer.provide(
          Layer.mock(OpenbotComputerSession)(
            options.session satisfies Partial<OpenbotComputerSession["Service"]>,
          ),
        ),
      ),
    ),
  );

it.effect("refuses every computer tool when the credential withholds the capability", () =>
  Effect.gen(function* () {
    const failure = yield* run(
      ComputerMcp.withComputerAccess((service) => service.status),
      { session: { status: Effect.succeed(status) }, capabilities: ["preview", "orchestration"] },
    ).pipe(Effect.flip);

    assert.equal(failure._tag, "OpenbotComputerMcpFailure");
    assert.equal(failure.code, "unsupported");
    assert.include(failure.message, "not allowed to control the computer");
  }),
);

it.effect("projects status down to what a decision needs, with install commands", () =>
  Effect.gen(function* () {
    const result = yield* run(
      ComputerMcp.withComputerAccess((service) => service.status),
      { session: { status: Effect.succeed(status) } },
    );

    assert.equal(result.session, "signed-in-desktop");
    assert.equal(result.availability, "ready");
    assert.equal(result.permissions.accessibility, "denied");
    assert.deepEqual(result.setup, {
      ready: false,
      missing: ["ffmpeg", "xdotool"],
      install: ["brew install ffmpeg"],
      notes: ["Wayland is not supported."],
    });
    assert.deepEqual(result.displays, [mainDisplay]);
    assert.deepEqual(result.controller, status.controller);
    // Windows move on every focus, so they belong to computer_list_windows.
    assert.isUndefined((result as { windows?: unknown }).windows);
  }),
);

it.effect("reports the scale that maps screenshot pixels back to display pixels", () =>
  Effect.gen(function* () {
    const result = yield* run(
      ComputerMcp.withComputerAccess((service) => service.screenshot({})),
      {
        session: {
          listDisplays: Effect.succeed([managedDisplay, mainDisplay]),
          snapshot: () =>
            Effect.succeed({
              mimeType: "image/jpeg" as const,
              dataBase64: "ZmFrZQ==",
              widthPx: 1512,
              heightPx: 982,
              displayId: mainDisplayId,
              capturedAt: "2026-09-08T10:00:03.000Z",
              caveat: null,
            }),
        },
      },
    );

    // Main display is picked over the first entry, and 3024 / 1512 says a point
    // measured on the image doubles to reach the display.
    assert.equal(result.displayId, mainDisplayId);
    assert.equal(result.scale, 2);
    assert.equal(result.image.widthPx, 1512);
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
      readonly displayId: string;
      readonly events: ReadonlyArray<OpenbotComputerInputEvent>;
    }> = [];

    const result = yield* run(
      ComputerMcp.withComputerAccess((service, scope) =>
        service.input(scope, { displayId: mainDisplayId, events }),
      ),
      {
        session: {
          agentInput: (source, displayId, batch) =>
            Effect.sync(() => {
              seen.push({ label: source.label, displayId, events: batch });
              return { delivered: batch.length, rejected: [] };
            }),
        },
      },
    );

    assert.deepEqual(result, { delivered: 2, rejected: [] });
    assert.deepEqual(seen, [
      { label: ComputerMcp.agentControllerLabel(threadId), displayId: mainDisplayId, events },
    ]);
  }),
);

it.effect("turns a human's control into a not_controlling failure that says to stop", () =>
  Effect.gen(function* () {
    const failure = yield* run(
      ComputerMcp.withComputerAccess((service, scope) =>
        service.input(scope, {
          displayId: mainDisplayId,
          events: [{ type: "key-press", key: "Enter" }],
        }),
      ),
      {
        session: {
          agentInput: () =>
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

it.effect("creates a managed display and returns the list it now belongs to", () =>
  Effect.gen(function* () {
    const result = yield* run(
      ComputerMcp.withComputerAccess((service) =>
        service.manageDisplay({
          action: "create",
          name: "Agent workspace",
          widthPx: 1440,
          heightPx: 900,
        }),
      ),
      {
        session: {
          createDisplay: () => Effect.succeed(managedDisplay),
          listDisplays: Effect.succeed([mainDisplay, managedDisplay]),
        },
      },
    );

    assert.equal(result.action, "create");
    assert.deepEqual(result.display, managedDisplay);
    assert.deepEqual(result.displays, [mainDisplay, managedDisplay]);
  }),
);

it.effect("destroys the named display and reports no created display", () =>
  Effect.gen(function* () {
    const destroyed: Array<string> = [];

    const result = yield* run(
      ComputerMcp.withComputerAccess((service) =>
        service.manageDisplay({ action: "destroy", displayId: secondDisplayId }),
      ),
      {
        session: {
          destroyDisplay: (id) => Effect.sync(() => void destroyed.push(id)),
          listDisplays: Effect.succeed([mainDisplay]),
        },
      },
    );

    assert.deepEqual(destroyed, [secondDisplayId]);
    assert.equal(result.action, "destroy");
    assert.equal(result.display, null);
    assert.deepEqual(result.displays, [mainDisplay]);
  }),
);

it.effect("refuses a manage_display call whose fields do not match its action", () =>
  Effect.gen(function* () {
    const failure = yield* run(
      ComputerMcp.withComputerAccess((service) => service.manageDisplay({ action: "create" })),
      { session: {} },
    ).pipe(Effect.flip);

    assert.equal(failure.code, "invalid_input");
    assert.include(failure.message, "widthPx");
  }),
);

it.effect("names the known displays when the requested one is gone", () =>
  Effect.gen(function* () {
    const failure = yield* run(
      ComputerMcp.withComputerAccess((service) =>
        service.screenshot({ displayId: secondDisplayId }),
      ),
      { session: { listDisplays: Effect.succeed([mainDisplay]) } },
    ).pipe(Effect.flip);

    assert.equal(failure.code, "display_not_found");
    assert.include(failure.message, mainDisplayId);
  }),
);

import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import type * as Types from "effect/Types";
import { McpProtocol, McpSchema, McpServer, Tool } from "effect/unstable/ai";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http";

import packageJson from "../../package.json" with { type: "json" };
import * as McpInvocationContext from "./McpInvocationContext.ts";
import * as OrchestratorMcpService from "./OrchestratorMcpService.ts";
import * as ThreadMetadataMcpService from "./ThreadMetadataMcpService.ts";
import * as McpSessionRegistry from "./McpSessionRegistry.ts";
import * as PreviewAutomationBroker from "./PreviewAutomationBroker.ts";
import * as ComputerMcpService from "./toolkits/computer/ComputerMcpService.ts";
import {
  ComputerScreenshotToolkitHandlersLive,
  ComputerStandardToolkitHandlersLive,
} from "./toolkits/computer/handlers.ts";
import {
  ComputerScreenshotTool,
  ComputerScreenshotToolkit,
  ComputerStandardToolkit,
} from "./toolkits/computer/tools.ts";
import { OpenbotToolkitHandlersLive } from "./toolkits/openbot/handlers.ts";
import * as OpenbotMcpService from "./toolkits/openbot/OpenbotMcpService.ts";
import { OpenbotToolkit } from "./toolkits/openbot/tools.ts";
import { OrchestratorToolkitHandlersLive } from "./toolkits/orchestrator/handlers.ts";
import { OrchestratorToolkit } from "./toolkits/orchestrator/tools.ts";
import {
  PreviewSnapshotToolkitHandlersLive,
  PreviewStandardToolkitHandlersLive,
} from "./toolkits/preview/handlers.ts";
import {
  PreviewSnapshotTool,
  PreviewSnapshotToolkit,
  PreviewStandardToolkit,
} from "./toolkits/preview/tools.ts";
import { WorktreeToolkitHandlersLive } from "./toolkits/worktree/handlers.ts";
import { WorktreeToolkit } from "./toolkits/worktree/tools.ts";
import * as WorktreeMcpService from "./WorktreeMcpService.ts";

const unauthorized = HttpServerResponse.jsonUnsafe(
  {
    error: "invalid_mcp_credential",
    message: "A valid provider-scoped MCP bearer credential is required.",
  },
  {
    status: 401,
    headers: {
      "cache-control": "no-store",
      "www-authenticate": "Bearer",
    },
  },
);

type AuthenticatedHttpEffect = Effect.Effect<
  HttpServerResponse.HttpServerResponse,
  Types.unhandled,
  McpInvocationContext.McpInvocationContext
>;

type McpAuthMiddleware = (
  httpEffect: AuthenticatedHttpEffect,
) => Effect.Effect<
  HttpServerResponse.HttpServerResponse,
  Types.unhandled,
  HttpServerRequest.HttpServerRequest
>;

export const normalizeMcpHttpResponse = (
  response: HttpServerResponse.HttpServerResponse,
): HttpServerResponse.HttpServerResponse => {
  const bodyIsEmpty =
    response.body._tag === "Empty" ||
    (response.body._tag === "Uint8Array" && response.body.contentLength === 0) ||
    (response.body._tag === "Raw" && response.body.contentLength === 0);
  return response.status === 200 && bodyIsEmpty
    ? HttpServerResponse.setStatus(response, 202)
    : response;
};

const makeMcpAuthMiddleware = McpSessionRegistry.McpSessionRegistry.pipe(
  Effect.map((registry): McpAuthMiddleware =>
    Effect.fn("McpHttpServer.authenticateRequest")(function* (httpEffect) {
      const request = yield* HttpServerRequest.HttpServerRequest;
      const authorization = request.headers.authorization;
      const token =
        authorization?.startsWith("Bearer ") === true
          ? authorization.slice("Bearer ".length).trim()
          : "";
      const invocation = yield* registry.resolve(token);
      if (!invocation) {
        // Without this the only symptom of a dead credential is the agent
        // quietly losing the whole `t3-code` toolkit for the rest of its
        // session, with nothing on the server to explain why.
        yield* Effect.logWarning("rejected MCP request with an unusable credential", {
          reason: token.length === 0 ? "missing_bearer_token" : "unknown_or_expired_token",
        });
        return unauthorized;
      }
      return yield* httpEffect.pipe(
        Effect.provideService(McpInvocationContext.McpInvocationContext, invocation),
        Effect.map(normalizeMcpHttpResponse),
      );
    }),
  ),
  Effect.withSpan("McpHttpServer.makeAuthMiddleware"),
);

const McpAuthMiddlewareLive = HttpRouter.middleware<{
  provides: McpInvocationContext.McpInvocationContext;
}>()(makeMcpAuthMiddleware).layer;

/**
 * A tool whose result carries an image is registered by hand, because the
 * toolkit layer can only return structured JSON and base64 image bytes in a
 * JSON field are invisible to a model that can actually see.
 */
interface ImageToolResultContent {
  /** Everything except the raw bytes, sent as JSON so the model can read the
      geometry it needs to act on the image. */
  readonly metadata: Record<string, unknown>;
  readonly mimeType: string;
  readonly base64Data: string;
}

/**
 * Splits `<imageKey>.data` out of a tool's own encoded success value.
 *
 * SAFETY: the value is the encoded form of the tool's declared success schema,
 * so the image field exists by construction. The checks are here so that a
 * schema change surfaces as a reported tool failure instead of a content block
 * holding nothing.
 */
const readImageToolResult = (
  encodedResult: unknown,
  imageKey: string,
): ImageToolResultContent | undefined => {
  if (typeof encodedResult !== "object" || encodedResult === null) return undefined;
  const record: Record<string, unknown> = { ...encodedResult };
  const image = record[imageKey];
  if (typeof image !== "object" || image === null) return undefined;
  const { data, ...imageMetadata }: Record<string, unknown> = { ...image };
  const mimeType = imageMetadata["mimeType"];
  if (typeof data !== "string" || typeof mimeType !== "string") return undefined;
  return {
    metadata: { ...record, [imageKey]: imageMetadata },
    mimeType,
    base64Data: data,
  };
};

interface ImageToolIdentity {
  /** Recorded in the structured error and the log line. */
  readonly operation: string;
  /** The sentence the model reads when the call failed. */
  readonly failureText: string;
  readonly fallbackErrorTag: string;
}

const imageToolFailure =
  ({ operation, failureText, fallbackErrorTag }: ImageToolIdentity) =>
  <E>(cause: Cause.Cause<E>) => {
    if (Cause.hasInterrupts(cause) || cause.reasons.some(Cause.isDieReason)) {
      return Effect.failCause(cause).pipe(Effect.orDie);
    }
    const failures = cause.reasons.filter(Cause.isFailReason);
    const firstFailure = failures[0]?.error;
    const errorTag =
      typeof firstFailure === "object" &&
      firstFailure !== null &&
      "_tag" in firstFailure &&
      typeof firstFailure._tag === "string"
        ? firstFailure._tag
        : fallbackErrorTag;
    const result = new McpSchema.CallToolResult({
      isError: true,
      structuredContent: {
        error: {
          _tag: errorTag,
          operation,
          failureCount: failures.length,
        },
      },
      content: [{ type: "text", text: failureText }],
    });
    return Effect.logWarning(`${operation} failed`, {
      operation,
      errorTag,
      failureCount: failures.length,
    }).pipe(Effect.as(result));
  };

const imageToolDefinition = (tool: Tool.Any) =>
  new McpSchema.Tool({
    name: tool.name,
    description: Tool.getDescription(tool),
    inputSchema: Tool.getJsonSchema(tool),
    annotations: {
      ...Context.getOption(tool.annotations, Tool.Title).pipe(
        Option.map((title) => ({ title })),
        Option.getOrUndefined,
      ),
      readOnlyHint: Context.get(tool.annotations, Tool.Readonly),
      destructiveHint: Context.get(tool.annotations, Tool.Destructive),
      idempotentHint: Context.get(tool.annotations, Tool.Idempotent),
      openWorldHint: Context.get(tool.annotations, Tool.OpenWorld),
    },
  });

const imageToolResult = <E>(
  options: ImageToolIdentity & {
    readonly imageKey: string;
    readonly run: Effect.Effect<{ readonly encodedResult: unknown }, E>;
  },
) =>
  options.run.pipe(
    Effect.matchCauseEffect({
      onFailure: imageToolFailure(options),
      onSuccess: ({ encodedResult }) => {
        const content = readImageToolResult(encodedResult, options.imageKey);
        if (content === undefined) {
          return imageToolFailure(options)(
            Cause.fail(new Error(`${options.operation} returned no ${options.imageKey}`)),
          );
        }
        return Effect.succeed(
          new McpSchema.CallToolResult({
            isError: false,
            structuredContent: content.metadata,
            content: [
              { type: "text", text: JSON.stringify(content.metadata) },
              {
                type: "image",
                data: new Uint8Array(Buffer.from(content.base64Data, "base64")),
                mimeType: content.mimeType,
              },
            ],
          }),
        );
      },
    }),
  );

const registerPreviewSnapshot = Effect.fn("McpHttpServer.registerPreviewSnapshot")(function* () {
  const server = yield* McpServer.McpServer;
  const broker = yield* PreviewAutomationBroker.PreviewAutomationBroker;
  const built = yield* PreviewSnapshotToolkit;
  yield* server.addTool({
    tool: imageToolDefinition(PreviewSnapshotTool),
    annotations: PreviewSnapshotTool.annotations,
    handle: (payload) =>
      Effect.withFiber((fiber) => {
        const invocation = Context.getUnsafe(
          fiber.context,
          McpInvocationContext.McpInvocationContext,
        );
        return imageToolResult({
          operation: "snapshot",
          failureText: "Preview snapshot failed.",
          fallbackErrorTag: "PreviewSnapshotError",
          imageKey: "screenshot",
          run: built
            .handle("preview_snapshot", payload)
            .pipe(
              Stream.unwrap,
              Stream.run(Sink.last()),
              Effect.flatMap(Effect.fromOption),
              Effect.provideService(PreviewAutomationBroker.PreviewAutomationBroker, broker),
              Effect.provideService(McpInvocationContext.McpInvocationContext, invocation),
            ),
        });
      }),
  });
});

const registerComputerScreenshot = Effect.fn("McpHttpServer.registerComputerScreenshot")(
  function* () {
    const server = yield* McpServer.McpServer;
    const computer = yield* ComputerMcpService.ComputerMcpService;
    const built = yield* ComputerScreenshotToolkit;
    yield* server.addTool({
      tool: imageToolDefinition(ComputerScreenshotTool),
      annotations: ComputerScreenshotTool.annotations,
      handle: (payload) =>
        Effect.withFiber((fiber) => {
          const invocation = Context.getUnsafe(
            fiber.context,
            McpInvocationContext.McpInvocationContext,
          );
          return imageToolResult({
            operation: "screenshot",
            failureText: "Computer screenshot failed.",
            fallbackErrorTag: "OpenbotComputerMcpFailure",
            imageKey: "image",
            run: built
              .handle("computer_screenshot", payload)
              .pipe(
                Stream.unwrap,
                Stream.run(Sink.last()),
                Effect.flatMap(Effect.fromOption),
                Effect.provideService(ComputerMcpService.ComputerMcpService, computer),
                Effect.provideService(McpInvocationContext.McpInvocationContext, invocation),
              ),
          });
        }),
    });
  },
);

const PreviewStandardToolkitRegistrationLive = McpServer.toolkit(PreviewStandardToolkit).pipe(
  Layer.provide(PreviewStandardToolkitHandlersLive),
);

const PreviewSnapshotRegistrationLive = Layer.effectDiscard(registerPreviewSnapshot()).pipe(
  Layer.provide(PreviewSnapshotToolkitHandlersLive),
);

export const PreviewToolkitRegistrationLive = Layer.mergeAll(
  PreviewStandardToolkitRegistrationLive,
  PreviewSnapshotRegistrationLive,
);

export const OrchestratorToolkitRegistrationLive = McpServer.toolkit(OrchestratorToolkit).pipe(
  Layer.provide(OrchestratorToolkitHandlersLive),
  Layer.provide(OrchestratorMcpService.layer),
  Layer.provide(ThreadMetadataMcpService.layer),
);

export const WorktreeToolkitRegistrationLive = McpServer.toolkit(WorktreeToolkit).pipe(
  Layer.provide(WorktreeToolkitHandlersLive),
  Layer.provide(WorktreeMcpService.layer),
);

const ComputerStandardToolkitRegistrationLive = McpServer.toolkit(ComputerStandardToolkit).pipe(
  Layer.provide(ComputerStandardToolkitHandlersLive),
);

const ComputerScreenshotRegistrationLive = Layer.effectDiscard(registerComputerScreenshot()).pipe(
  Layer.provide(ComputerScreenshotToolkitHandlersLive),
);

export const ComputerToolkitRegistrationLive = Layer.mergeAll(
  ComputerStandardToolkitRegistrationLive,
  ComputerScreenshotRegistrationLive,
).pipe(Layer.provide(ComputerMcpService.layer));

export const OpenbotToolkitRegistrationLive = McpServer.toolkit(OpenbotToolkit).pipe(
  Layer.provide(OpenbotToolkitHandlersLive),
  Layer.provide(OpenbotMcpService.layer),
);

const McpTransportLive = McpServer.layerHttp({
  name: "T3 Code",
  version: packageJson.version,
  path: "/mcp",
  protocols: [McpProtocol.v2025_06_18],
}).pipe(Layer.provide(McpAuthMiddlewareLive));

export const layer = Layer.mergeAll(
  PreviewToolkitRegistrationLive,
  ComputerToolkitRegistrationLive,
  OrchestratorToolkitRegistrationLive,
  WorktreeToolkitRegistrationLive,
  OpenbotToolkitRegistrationLive,
).pipe(Layer.provideMerge(McpTransportLive));

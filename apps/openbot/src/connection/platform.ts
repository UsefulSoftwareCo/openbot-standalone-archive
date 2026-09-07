import {
  ClientPresentation,
  CloudSession,
  PlatformConnectionSource,
  PrimaryEnvironmentAuth,
  RelayDeviceIdentity,
  SshEnvironmentGateway,
} from "@t3tools/client-runtime/platform";
import {
  ConnectionBlockedError,
  Connectivity,
  mapRemoteEnvironmentError,
  type PlatformConnectionRegistration,
  PrimaryConnectionRegistration,
  PrimaryConnectionTarget,
  Wakeups,
} from "@t3tools/client-runtime/connection";
import { fetchRemoteEnvironmentDescriptor } from "@t3tools/client-runtime/environment";
import { AuthStandardClientScopes } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import { HttpClient } from "effect/unstable/http";

import { connectionStorageLayer } from "./storage";

function currentNetworkStatus(): "unknown" | "offline" | "online" {
  if (typeof navigator === "undefined") return "unknown";
  return navigator.onLine ? "online" : "offline";
}

const connectivityLayer = Connectivity.layer({
  status: Effect.sync(currentNetworkStatus),
  changes: Stream.callback((queue) =>
    Effect.acquireRelease(
      Effect.sync(() => {
        const online = () => Queue.offerUnsafe(queue, "online");
        const offline = () => Queue.offerUnsafe(queue, "offline");
        window.addEventListener("online", online);
        window.addEventListener("offline", offline);
        return { online, offline };
      }),
      ({ online, offline }) =>
        Effect.sync(() => {
          window.removeEventListener("online", online);
          window.removeEventListener("offline", offline);
        }),
    ).pipe(Effect.asVoid),
  ),
});

const wakeupsLayer = Wakeups.layer({
  changes: Stream.callback<"application-active">((queue) =>
    Effect.acquireRelease(
      Effect.sync(() => {
        const listener = () => {
          if (document.visibilityState === "visible") {
            Queue.offerUnsafe(queue, "application-active");
          }
        };
        document.addEventListener("visibilitychange", listener);
        return listener;
      }),
      (listener) =>
        Effect.sync(() => {
          document.removeEventListener("visibilitychange", listener);
        }),
    ).pipe(Effect.asVoid),
  ),
});

const unsupported = (detail: string) =>
  Effect.fail(new ConnectionBlockedError({ reason: "unsupported", detail }));

const capabilitiesLayer = Layer.succeed(
  ClientPresentation,
  ClientPresentation.of({
    metadata: {
      label: "OpenBot",
      deviceType: "desktop",
      surface: "web",
      webDeployment: "server",
      ...(import.meta.env.APP_VERSION === "0.0.0"
        ? {}
        : { appVersion: import.meta.env.APP_VERSION }),
    },
    scopes: AuthStandardClientScopes,
  }),
).pipe(
  Layer.merge(
    Layer.succeed(
      PrimaryEnvironmentAuth,
      // Same-origin: the browser session cookie authenticates the socket.
      PrimaryEnvironmentAuth.of({ bearerToken: Effect.succeed(Option.none()) }),
    ),
  ),
  Layer.merge(
    Layer.succeed(
      CloudSession,
      CloudSession.of({
        identity: Effect.succeed(Option.none()),
        clerkToken: unsupported("OpenBot does not use T3 Connect."),
      }),
    ),
  ),
  Layer.merge(
    Layer.succeed(
      RelayDeviceIdentity,
      RelayDeviceIdentity.of({ deviceId: Effect.succeed(Option.none()) }),
    ),
  ),
  Layer.merge(
    Layer.succeed(
      SshEnvironmentGateway,
      SshEnvironmentGateway.of({
        provision: () => unsupported("SSH environments are not available in OpenBot."),
        prepare: () => unsupported("SSH environments are not available in OpenBot."),
        disconnect: () => Effect.void,
      }),
    ),
  ),
);

export function primaryTarget(): { readonly httpBaseUrl: string; readonly wsBaseUrl: string } {
  const http = new URL(window.location.origin);
  http.pathname = "/";
  const ws = new URL(http.toString());
  ws.protocol = ws.protocol === "https:" ? "wss:" : "ws:";
  return { httpBaseUrl: http.toString(), wsBaseUrl: ws.toString() };
}

const loadPrimaryRegistration = Effect.gen(function* () {
  const target = primaryTarget();
  const descriptor = yield* fetchRemoteEnvironmentDescriptor({
    httpBaseUrl: target.httpBaseUrl,
  }).pipe(Effect.mapError((error) => mapRemoteEnvironmentError(error)));
  return new PrimaryConnectionRegistration({
    target: new PrimaryConnectionTarget({
      environmentId: descriptor.environmentId,
      label: descriptor.label,
      httpBaseUrl: target.httpBaseUrl,
      wsBaseUrl: target.wsBaseUrl,
    }),
  });
});

// One primary environment: the server behind this origin. Discovered once at
// startup and retried until the descriptor answers.
const platformConnectionSourceLayer = Layer.effect(
  PlatformConnectionSource,
  Effect.gen(function* () {
    const httpClient = yield* HttpClient.HttpClient;
    const registrations: Stream.Stream<ReadonlyArray<PlatformConnectionRegistration>> =
      Stream.fromEffect(
        loadPrimaryRegistration.pipe(
          Effect.retry(Schedule.spaced("2 seconds").pipe(Schedule.upTo({ times: 30 }))),
          Effect.map((registration): ReadonlyArray<PlatformConnectionRegistration> => [
            registration,
          ]),
          Effect.provideService(HttpClient.HttpClient, httpClient),
        ),
      ).pipe(Stream.catchCause(() => Stream.empty));
    return PlatformConnectionSource.of({ registrations });
  }),
);

type ConnectionPlatformLayerSource =
  | typeof connectionStorageLayer
  | typeof connectivityLayer
  | typeof wakeupsLayer
  | typeof capabilitiesLayer
  | typeof platformConnectionSourceLayer;

export const connectionPlatformLayer: Layer.Layer<
  Layer.Success<ConnectionPlatformLayerSource>,
  Layer.Error<ConnectionPlatformLayerSource>,
  Layer.Services<ConnectionPlatformLayerSource>
> = Layer.mergeAll(
  connectionStorageLayer,
  connectivityLayer,
  wakeupsLayer,
  capabilitiesLayer,
  platformConnectionSourceLayer,
);

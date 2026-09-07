import { ManagedRelay } from "@t3tools/client-runtime/relay";
import { remoteHttpClientLayer } from "@t3tools/client-runtime/rpc";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";
import { FetchHttpClient } from "effect/unstable/http";
import * as Socket from "effect/unstable/socket/Socket";

/**
 * Base services for the OpenBot client. This app only ever talks to the
 * same-origin T3 server through the dev proxy, so the browser session cookie
 * is the credential and every request carries it.
 */
const httpClientLayer = Layer.merge(
  remoteHttpClientLayer((input, init) => globalThis.fetch(input, init)),
  Layer.succeed(FetchHttpClient.RequestInit, { credentials: "include" }),
);

const browserCryptoLayer = Layer.succeed(
  Crypto.Crypto,
  Crypto.make({
    randomBytes: (size) => globalThis.crypto.getRandomValues(new Uint8Array(size)),
    digest: (algorithm, data) =>
      Effect.promise(async () => {
        const input = new Uint8Array(data.length);
        input.set(data);
        return new Uint8Array(await globalThis.crypto.subtle.digest(algorithm, input.buffer));
      }),
  }),
);

// T3 Connect (relay) is out of scope for OpenBot step 1. The connection layer
// still requires these services, so they are present but inert: an insecure
// relay URL yields the disabled client, and the signer is never reached.
const relayDpopSignerLayer = Layer.succeed(
  ManagedRelay.ManagedRelayDpopSigner,
  ManagedRelay.ManagedRelayDpopSigner.of({
    thumbprint: Effect.fail(
      new ManagedRelay.ManagedRelayDpopKeyLoadError({
        keyStore: "indexed-db",
        cause: "OpenBot does not use T3 Connect.",
      }),
    ),
    createProof: (input) =>
      Effect.fail(
        new ManagedRelay.ManagedRelayDpopProofCreationError({
          method: input.method,
          url: input.url,
          cause: "OpenBot does not use T3 Connect.",
        }),
      ),
  }),
);

const managedRelayLayer = ManagedRelay.layer({
  relayUrl: "http://relay.invalid",
  clientId: "t3-web",
}).pipe(Layer.provideMerge(relayDpopSignerLayer));

const runtimeLayer = Layer.mergeAll(
  browserCryptoLayer,
  Socket.layerWebSocketConstructorGlobal,
  managedRelayLayer,
).pipe(Layer.provideMerge(httpClientLayer));

type RuntimeLayerSource = typeof runtimeLayer;

export const runtime: ManagedRuntime.ManagedRuntime<
  Layer.Success<RuntimeLayerSource>,
  Layer.Error<RuntimeLayerSource>
> = ManagedRuntime.make(runtimeLayer);

export const runtimeContextLayer: Layer.Layer<
  Layer.Success<RuntimeLayerSource>,
  Layer.Error<RuntimeLayerSource>
> = Layer.effectContext(runtime.contextEffect);

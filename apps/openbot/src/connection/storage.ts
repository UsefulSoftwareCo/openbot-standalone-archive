import { TokenStore } from "@t3tools/client-runtime/authorization";
import { CredentialStore, ProfileStore } from "@t3tools/client-runtime/connection";
import {
  ConnectionPersistenceError,
  ConnectionRegistrationStore,
  ConnectionTargetStore,
  EnvironmentCacheStore,
} from "@t3tools/client-runtime/platform";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

/**
 * OpenBot registers only the same-origin primary environment, which the
 * platform source rediscovers on every load. Nothing needs to persist across
 * reloads, so the catalog stores are empty and the environment cache is a
 * no-op; the server is always the source of truth.
 */
const persistenceError = (operation: ConnectionPersistenceError["operation"]) =>
  new ConnectionPersistenceError({
    operation,
    message: `OpenBot does not persist connections (${operation}).`,
  });

export const connectionStorageLayer = Layer.effectContext(
  Effect.sync(() =>
    Context.make(
      ConnectionTargetStore,
      ConnectionTargetStore.of({ list: Effect.succeed([]) }),
    ).pipe(
      Context.add(
        ConnectionRegistrationStore,
        ConnectionRegistrationStore.of({
          register: () => Effect.fail(persistenceError("register-connection")),
          remove: () => Effect.void,
        }),
      ),
      Context.add(
        ProfileStore.ConnectionProfileStore,
        ProfileStore.make({
          get: () => Effect.succeed(Option.none()),
          put: () => Effect.void,
          remove: () => Effect.void,
        }),
      ),
      Context.add(
        CredentialStore.ConnectionCredentialStore,
        CredentialStore.make({
          get: () => Effect.succeed(Option.none()),
          put: () => Effect.void,
          remove: () => Effect.void,
        }),
      ),
      Context.add(
        TokenStore.RemoteDpopAccessTokenStore,
        TokenStore.make({
          get: () => Effect.succeed(Option.none()),
          put: () => Effect.void,
          remove: () => Effect.void,
        }),
      ),
      Context.add(
        EnvironmentCacheStore,
        EnvironmentCacheStore.of({
          loadShell: () => Effect.succeed(Option.none()),
          saveShell: () => Effect.void,
          loadThread: () => Effect.succeed(Option.none()),
          saveThread: () => Effect.void,
          removeThread: () => Effect.void,
          loadServerConfig: () => Effect.succeed(Option.none()),
          saveServerConfig: () => Effect.void,
          loadVcsRefs: () => Effect.succeed(Option.none()),
          saveVcsRefs: () => Effect.void,
          removeVcsRefs: () => Effect.void,
          clearVcsRefs: () => Effect.void,
          clear: () => Effect.void,
        }),
      ),
    ),
  ),
);

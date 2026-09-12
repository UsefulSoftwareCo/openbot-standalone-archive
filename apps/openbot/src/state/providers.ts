import { type EnvironmentId, type ServerProvider } from "@t3tools/contracts";
import { useAtomValue } from "@effect/atom-react";
import { createServerEnvironmentAtoms } from "@t3tools/client-runtime/state/server";
import { AsyncResult, Atom } from "effect/unstable/reactivity";
import type { ServerConfig } from "@t3tools/contracts";
import { connectionAtomRuntime } from "../connection/atomRuntime";

const initialConfig = Atom.make<ServerConfig | null>(null);
const serverEnvironment = createServerEnvironmentAtoms(connectionAtomRuntime, {
  initialConfigValueAtom: () => initialConfig,
});
const EMPTY_PROVIDERS: ReadonlyArray<ServerProvider> = [];

/** The same live provider catalog and reconnect lifecycle used by T3 Code. */
export function useServerProviders(environmentId: EnvironmentId) {
  const projection = useAtomValue(serverEnvironment.configProjection({ environmentId, input: {} }));
  const providers = useAtomValue(serverEnvironment.providersValueAtom(environmentId));
  return { items: providers ?? EMPTY_PROVIDERS, failed: AsyncResult.isFailure(projection) };
}

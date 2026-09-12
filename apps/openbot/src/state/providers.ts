import { type EnvironmentId, type ServerProvider } from "@t3tools/contracts";
import { useAtomValue } from "@effect/atom-react";
import { AsyncResult } from "effect/unstable/reactivity";
import { serverEnvironment } from "../../../web/src/state/server";

const EMPTY_PROVIDERS: ReadonlyArray<ServerProvider> = [];

/** The same live provider catalog and reconnect lifecycle used by T3 Code. */
export function useServerProviders(environmentId: EnvironmentId) {
  const projection = useAtomValue(serverEnvironment.configProjection({ environmentId, input: {} }));
  const providers = useAtomValue(serverEnvironment.providersValueAtom(environmentId));
  return { items: providers ?? EMPTY_PROVIDERS, failed: AsyncResult.isFailure(projection) };
}

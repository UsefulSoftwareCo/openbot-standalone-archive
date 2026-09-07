import { Connection } from "@t3tools/client-runtime/connection";
import { RegistryContext } from "@effect/atom-react";
import * as Layer from "effect/Layer";
import { Atom, AtomRegistry } from "effect/unstable/reactivity";
import { createElement } from "react";

import { connectionPlatformLayer } from "./platform";
import { runtimeContextLayer } from "./runtime";

const providedConnectionPlatformLayer = connectionPlatformLayer.pipe(
  Layer.provide(runtimeContextLayer),
);

type ConnectionLayerSource =
  | typeof Connection.layer
  | typeof runtimeContextLayer
  | typeof connectionPlatformLayer;

const connectionLayer: Layer.Layer<
  Layer.Success<ConnectionLayerSource>,
  Layer.Error<ConnectionLayerSource>
> = Connection.layerWithOptions({}).pipe(
  Layer.provideMerge(Layer.mergeAll(runtimeContextLayer, providedConnectionPlatformLayer)),
);

export const connectionAtomRuntime: Atom.AtomRuntime<
  Layer.Success<ConnectionLayerSource>,
  Layer.Error<ConnectionLayerSource>
> = Atom.runtime(connectionLayer);

export const appAtomRegistry = AtomRegistry.make();

export function AppAtomRegistryProvider({ children }: React.PropsWithChildren) {
  return createElement(RegistryContext.Provider, { value: appAtomRegistry }, children);
}

import {
  isProviderAvailable,
  type EnvironmentId,
  type ModelSelection,
  type ServerProvider,
} from "@t3tools/contracts";
import { useEffect, useState } from "react";

import { getServerConfig, useAtomCommand } from "./channels";

/** The provider choices a chat can be pointed at, and whether reading them failed. */
export interface ServerProviders {
  /** Providers this server can actually run right now. Empty while loading. */
  readonly items: ReadonlyArray<ServerProvider>;
  /** Set when the server config could not be read; the list is then empty. */
  readonly failed: boolean;
}

const NONE: ServerProviders = { items: [], failed: false };

/**
 * The runnable providers of one server. A provider the server knows about but
 * cannot start is not a choice, so unavailable, disabled and uninstalled ones
 * are dropped before the caller ever sees them.
 */
export function useServerProviders(environmentId: EnvironmentId): ServerProviders {
  const readProviders = useAtomCommand(getServerConfig, { reportFailure: false });
  const [state, setState] = useState<ServerProviders>(NONE);
  useEffect(() => {
    let disposed = false;
    void readProviders({ environmentId, input: {} }).then((result) => {
      if (disposed) return;
      setState(
        result._tag === "Failure"
          ? { items: [], failed: true }
          : {
              items: result.value.providers.filter(
                (provider) =>
                  isProviderAvailable(provider) && provider.enabled && provider.installed,
              ),
              failed: false,
            },
      );
    });
    return () => {
      disposed = true;
    };
  }, [environmentId, readProviders]);
  return state;
}

/**
 * The selection for choosing `instanceId`, preferring that provider's default
 * model. `undefined` means "Automatic": let the server decide, which is also
 * what an unknown instance id resolves to.
 */
export function providerModelSelection(
  providers: ReadonlyArray<ServerProvider>,
  instanceId: string,
): ModelSelection | undefined {
  const provider = providers.find((entry) => entry.instanceId === instanceId);
  if (provider === undefined) return undefined;
  const model = provider.models.find((entry) => entry.isDefault) ?? provider.models[0];
  return model === undefined ? undefined : { instanceId: provider.instanceId, model: model.slug };
}

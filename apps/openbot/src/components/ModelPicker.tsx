import {
  ClientSettingsSchema,
  DEFAULT_CLIENT_SETTINGS,
  type ModelSelection,
  type ServerProvider,
} from "@t3tools/contracts";
import { CLIENT_SETTINGS_STORAGE_KEY } from "@t3tools/client-runtime/browser-client-settings";
import { useLocalStorage } from "@t3tools/client-runtime/local-storage";
import { ProviderModelPicker } from "@t3tools/ui/provider-model-picker";
import {
  deriveProviderInstanceEntries,
  NO_PROVIDER_MODEL_SELECTION,
} from "@t3tools/ui/provider-instances";
import { useMemo } from "react";

/** Connects T3's model picker to OpenBot's server catalog and the shared client preferences. */
export function ModelPicker({
  providers,
  selection,
  disabled,
  onChange,
}: {
  readonly providers: ReadonlyArray<ServerProvider>;
  readonly selection: ModelSelection | undefined;
  readonly disabled: boolean;
  readonly onChange: (selection: ModelSelection) => void;
}) {
  const entries = useMemo(() => deriveProviderInstanceEntries(providers), [providers]);
  const options = useMemo(
    () => new Map(entries.map((entry) => [entry.instanceId, entry.models])),
    [entries],
  );
  const [settings, setSettings] = useLocalStorage(
    CLIENT_SETTINGS_STORAGE_KEY,
    DEFAULT_CLIENT_SETTINGS,
    ClientSettingsSchema,
  );
  const active = selection ?? NO_PROVIDER_MODEL_SELECTION;
  return (
    <ProviderModelPicker
      activeInstanceId={active.instanceId}
      model={active.model}
      lockedProvider={null}
      instanceEntries={entries}
      modelOptionsByInstance={options}
      disabled={disabled || entries.length === 0}
      triggerAriaLabel="Choose model"
      preferences={{
        favorites: settings.favorites,
        onFavoritesChange: (favorites) => setSettings((current) => ({ ...current, favorites })),
      }}
      onInstanceModelChange={(instanceId, model) => onChange({ instanceId, model })}
    />
  );
}

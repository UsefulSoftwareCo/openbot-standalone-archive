import { type ModelSelection, type ServerProvider } from "@t3tools/contracts";
import { ProviderModelPicker } from "../../../web/src/components/chat/ProviderModelPicker";
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
      onInstanceModelChange={(instanceId, model) => onChange({ instanceId, model })}
    />
  );
}

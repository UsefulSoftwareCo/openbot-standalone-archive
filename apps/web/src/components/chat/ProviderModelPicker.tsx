import { memo, type ComponentProps } from "react";
import type { ResolvedKeybindingsConfig } from "@t3tools/contracts";
import { ProviderModelPicker as SharedPicker } from "@t3tools/ui/provider-model-picker";
import { useModelPickerPreferences } from "./useModelPickerPreferences";

/** T3 settings adapter for the shared model picker. */
export const ProviderModelPicker = memo(function ProviderModelPicker({
  keybindings,
  ...props
}: Omit<ComponentProps<typeof SharedPicker>, "preferences" | "shortcuts"> & {
  keybindings?: ResolvedKeybindingsConfig;
}) {
  const bindings = useModelPickerPreferences(keybindings, props.terminalOpen);
  return <SharedPicker {...props} {...bindings} />;
});

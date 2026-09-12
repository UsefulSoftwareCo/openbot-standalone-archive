import { memo, type ComponentProps } from "react";
import type { ResolvedKeybindingsConfig } from "@t3tools/contracts";
import { ModelPickerContent as SharedPicker } from "@t3tools/ui/model-picker-content";
import { useModelPickerPreferences } from "./useModelPickerPreferences";
export {
  resolveModelPickerSelectedModel,
  shouldIncludeModelPickerOption,
  shouldOfferModelPickerSetup,
} from "@t3tools/ui/model-picker-content";

/** T3 settings adapter for the shared model picker. */
export const ModelPickerContent = memo(function ModelPickerContent({
  keybindings,
  ...props
}: Omit<ComponentProps<typeof SharedPicker>, "preferences" | "shortcuts"> & {
  keybindings?: ResolvedKeybindingsConfig;
}) {
  const bindings = useModelPickerPreferences(keybindings, props.terminalOpen);
  return <SharedPicker {...props} {...bindings} />;
});

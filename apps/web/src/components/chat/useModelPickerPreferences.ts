import { useMemo } from "react";
import { useAtomValue } from "@effect/atom-react";
import type { ResolvedKeybindingsConfig } from "@t3tools/contracts";
import { useClientSettings, useUpdateClientSettings } from "../../hooks/useSettings";
import { primaryServerKeybindingsAtom } from "../../state/server";
import { isCommandPaletteOpen } from "../../commandPaletteBus";
import {
  modelPickerJumpCommandForIndex,
  modelPickerJumpIndexFromCommand,
  resolveShortcutCommand,
  shortcutLabelForCommand,
} from "../../keybindings";

/** Connect the shared picker to T3 client settings and its keyboard routing. */
export function useModelPickerPreferences(
  providedKeybindings?: ResolvedKeybindingsConfig,
  terminalOpen = false,
) {
  const favorites = useClientSettings((s) => s.favorites ?? []);
  const updateSettings = useUpdateClientSettings();
  const serverKeybindings = useAtomValue(primaryServerKeybindingsAtom);
  const keybindings = providedKeybindings ?? serverKeybindings;
  const preferences = useMemo(
    () => ({
      favorites,
      onFavoritesChange: (next: typeof favorites) => updateSettings({ favorites: next }),
    }),
    [favorites, updateSettings],
  );
  const shortcuts = useMemo(() => {
    const options = {
      platform: navigator.platform,
      context: { terminalFocus: false, terminalOpen, modelPickerOpen: true },
    };
    return {
      labelForIndex: (index: number) => {
        const command = modelPickerJumpCommandForIndex(index);
        return command ? shortcutLabelForCommand(keybindings, command, options) : null;
      },
      indexForEvent: (event: KeyboardEvent) =>
        modelPickerJumpIndexFromCommand(resolveShortcutCommand(event, keybindings, options) ?? ""),
      isSuppressed: isCommandPaletteOpen,
    };
  }, [keybindings, terminalOpen]);
  return { preferences, shortcuts };
}

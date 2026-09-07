// The searchable list of every Phosphor icon, for the icon picker.
//
// Names only: `import * as Phosphor from "@phosphor-icons/react"` would pull in
// all ~1,500 icon components (~5 MB), and importing the components one chunk at
// a time would make opening the picker fetch every chunk at once. The picker
// renders the ~120 icons it shows through `ProjectIcon`'s per-icon loader
// instead, so this module carries no icon code at all.
//
// Keep the picker as its only importer. It reads the whole per-icon module
// table, which a project row does not need, and the picker itself is reached
// through `lazy(() => import("./ProjectIconPicker"))`.
import { ALIAS_ICON_MODULES, BUNDLED_ICON_NAMES } from "./projectIconLoader";
import { ICON_MODULE_LOADERS } from "./projectIconModules";

export interface IconCatalogEntry {
  /** Contract name: the Phosphor export name without the `Icon` suffix. */
  readonly name: string;
  /** Human-readable, space-separated, for search and a11y labels. */
  readonly label: string;
}

function toEntry(name: string): IconCatalogEntry {
  return { name, label: name.replace(/([a-z0-9])([A-Z])/g, "$1 $2") };
}

// Every icon with a module of its own, plus the one bundled with the app and
// the deprecated v1 aliases, which have no module but are still valid names.
const names = new Set([
  ...ICON_MODULE_LOADERS.keys(),
  ...BUNDLED_ICON_NAMES,
  ...Object.keys(ALIAS_ICON_MODULES),
]);

export const ICON_CATALOG: ReadonlyArray<IconCatalogEntry> = [...names]
  .filter((name) => !name.includes("Sparkle"))
  .sort((a, b) => a.localeCompare(b))
  .map(toEntry);

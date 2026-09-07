// The searchable list of every Phosphor icon, for the icon picker.
//
// The names come from the contract's generated list, not from the module glob,
// so the picker cannot offer a name the server would reject: `OpenbotProjectIcon`
// validates against that same list. `projectIconModules` still owns the per-icon
// chunks; `iconCatalog.test.ts` checks the two agree.
//
// Names only: `import * as Phosphor from "@phosphor-icons/react"` would pull in
// all ~1,500 icon components (~5 MB), and importing the components one chunk at
// a time would make opening the picker fetch every chunk at once. The picker
// renders the ~120 icons it shows through `ProjectIcon`'s per-icon loader
// instead, so this module carries no icon code at all.
import { OPENBOT_ICON_NAMES, openbotIconLabel } from "@t3tools/contracts";

export interface IconCatalogEntry {
  /** Contract name: the Phosphor export name without the `Icon` suffix. */
  readonly name: string;
  /** Human-readable, space-separated, for search and a11y labels. */
  readonly label: string;
}

/** Already sorted and free of sparkles: the generated list is built that way. */
export const ICON_CATALOG: ReadonlyArray<IconCatalogEntry> = OPENBOT_ICON_NAMES.map((name) => ({
  name,
  label: openbotIconLabel(name),
}));

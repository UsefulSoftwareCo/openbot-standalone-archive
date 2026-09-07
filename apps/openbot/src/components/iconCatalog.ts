// The full Phosphor icon set. `import * as Phosphor from "@phosphor-icons/react"`
// defeats tree-shaking (it pulls in all ~1,500 icon components), so this module
// must only ever be reached through a dynamic `await import("./iconCatalog")`
// from a chunk that already needs the whole catalog (the icon picker). Never
// import it statically from a component that renders on every page, such as a
// sidebar row — use `ProjectIcon` for that instead.
import * as Phosphor from "@phosphor-icons/react";
import type { Icon } from "@phosphor-icons/react";

export interface IconCatalogEntry {
  /** Contract name: the Phosphor export name without the `Icon` suffix. */
  readonly name: string;
  /** Human-readable, space-separated, for search and a11y labels. */
  readonly label: string;
  readonly component: Icon;
}

// Non-component exports from the package root, kept out of the catalog even
// though none of them happen to end in "Icon" today.
const NON_ICON_EXPORTS = new Set(["IconContext", "IconBase", "SSR"]);

function toEntry(name: string, component: Icon): IconCatalogEntry {
  return {
    name: name.replace(/Icon$/, ""),
    label: name.replace(/Icon$/, "").replace(/([a-z0-9])([A-Z])/g, "$1 $2"),
    component,
  };
}

const catalog: IconCatalogEntry[] = [];
for (const [name, value] of Object.entries(Phosphor)) {
  if (NON_ICON_EXPORTS.has(name)) continue;
  if (!name.endsWith("Icon")) continue;
  if (/Sparkle/.test(name)) continue;
  catalog.push(toEntry(name, value as Icon));
}
catalog.sort((a, b) => a.name.localeCompare(b.name));

export const ICON_CATALOG: ReadonlyArray<IconCatalogEntry> = catalog;

export const ICON_CATALOG_BY_NAME: ReadonlyMap<string, Icon> = new Map(
  catalog.map((entry) => [entry.name, entry.component]),
);

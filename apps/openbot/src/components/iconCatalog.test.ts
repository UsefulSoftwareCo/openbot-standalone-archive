import { describe, expect, it } from "vite-plus/test";

import { ICON_CATALOG } from "./iconCatalog";

// The catalog is built from an `import.meta.glob` over the icon package's
// per-icon modules. A glob that stops matching (a package layout change, say)
// would empty the picker silently, so assert the shape of what it produced.
describe("ICON_CATALOG", () => {
  it("covers the whole Phosphor set", () => {
    expect(ICON_CATALOG.length).toBeGreaterThan(1500);
  });

  it("includes the icons that have no module of their own", () => {
    const names = new Set(ICON_CATALOG.map((entry) => entry.name));
    expect(names.has("Folder")).toBe(true); // bundled as the fallback glyph
    expect(names.has("ArchiveBox")).toBe(true); // deprecated alias of BoxArrowDown
    expect(names.has("Basket")).toBe(true);
  });

  it("omits Sparkle icons and is sorted and searchable by label", () => {
    expect(ICON_CATALOG.some((entry) => entry.name.includes("Sparkle"))).toBe(false);
    expect(ICON_CATALOG.find((entry) => entry.name === "ArchiveBox")?.label).toBe("Archive Box");

    const names = ICON_CATALOG.map((entry) => entry.name);
    expect(names).toEqual([...names].sort((a, b) => a.localeCompare(b)));
  });
});

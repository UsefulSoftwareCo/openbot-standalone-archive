import { OPENBOT_ICON_NAMES } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { ICON_CATALOG } from "./iconCatalog";
import { ALIAS_ICON_MODULES, BUNDLED_ICON_NAMES } from "./projectIconLoader";
import { ICON_MODULE_LOADERS } from "./projectIconModules";

describe("ICON_CATALOG", () => {
  it("offers exactly the names the contract accepts", () => {
    expect(ICON_CATALOG.length).toBe(OPENBOT_ICON_NAMES.length);
    expect(ICON_CATALOG.map((entry) => entry.name)).toEqual([...OPENBOT_ICON_NAMES]);
  });

  // The generated list is committed, so a Phosphor bump or a new alias only
  // reaches the contract when someone regenerates it. Until then the picker
  // would quietly lose or gain names against what the server will store.
  it("matches the icon modules the bundler actually globs", () => {
    const installed = new Set([
      ...ICON_MODULE_LOADERS.keys(),
      ...BUNDLED_ICON_NAMES,
      ...Object.keys(ALIAS_ICON_MODULES),
    ]);
    const expected = [...installed]
      .filter((name) => !name.includes("Sparkle"))
      .sort((a, b) => a.localeCompare(b));

    expect(
      [...OPENBOT_ICON_NAMES],
      "openbotIcons.generated.ts has drifted. Run: node packages/contracts/scripts/generate-openbot-icons.ts",
    ).toEqual(expected);
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

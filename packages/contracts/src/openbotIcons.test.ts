import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import {
  DEFAULT_OPENBOT_PROJECT_ICON,
  OpenbotProjectIcon,
  openbotIconLabel,
  searchOpenbotIcons,
} from "./openbot.ts";
import { OPENBOT_ICON_NAMES } from "./openbotIcons.generated.ts";

const decodeIcon = Schema.decodeUnknownEffect(OpenbotProjectIcon);

// The committed list is what stands between an agent and a name that renders as
// the fallback glyph. `apps/openbot`'s iconCatalog test checks it against the
// installed package; these check what the contract does with it.
it("lists the whole icon set, sorted, without sparkles", () => {
  assert.isAbove(OPENBOT_ICON_NAMES.length, 1500);
  assert.include(OPENBOT_ICON_NAMES, DEFAULT_OPENBOT_PROJECT_ICON.name);
  assert.include(OPENBOT_ICON_NAMES, "ArchiveBox"); // deprecated v1 alias the loader still resolves
  assert.isFalse(OPENBOT_ICON_NAMES.some((name) => name.includes("Sparkle")));
  assert.deepStrictEqual(
    [...OPENBOT_ICON_NAMES],
    [...OPENBOT_ICON_NAMES].sort((left, right) => left.localeCompare(right)),
  );
});

it.effect("accepts a real icon name", () =>
  Effect.gen(function* () {
    const icon = yield* decodeIcon({ name: "Folder", color: "default" });
    assert.strictEqual(icon.name, "Folder");
  }),
);

// The measured failure: a name that passes the PascalCase pattern but has no
// icon behind it used to be stored and then silently drawn as `Folder`.
it.effect("rejects a well-formed name that no icon answers to", () =>
  Effect.gen(function* () {
    const error = yield* decodeIcon({ name: "Telescope", color: "blue" }).pipe(Effect.flip);
    assert.include(
      error.message,
      'Unknown project icon "Telescope". Search valid names with openbot_search_icons.',
    );
  }),
);

it("labels an icon by splitting its name into words", () => {
  assert.strictEqual(openbotIconLabel("ArchiveBox"), "Archive Box");
  assert.strictEqual(openbotIconLabel("Folder"), "Folder");
});

it("ranks an exact icon name above prefix and substring matches", () => {
  const { icons, total } = searchOpenbotIcons("folder", 5);

  assert.strictEqual(icons[0]?.name, "Folder");
  assert.isAtLeast(total, icons.length);
  assert.strictEqual(icons.length, 5);
  assert.deepStrictEqual(
    icons.slice(1).map((icon) => icon.name.toLowerCase().startsWith("folder")),
    [true, true, true, true],
  );
});

it("matches the spaced label so a multi-word query still finds the icon", () => {
  const { icons } = searchOpenbotIcons("archive box");

  assert.strictEqual(icons[0]?.name, "ArchiveBox");
  assert.strictEqual(icons[0]?.label, "Archive Box");
});

it("returns nothing rather than guessing for a name outside the set", () => {
  assert.deepStrictEqual(searchOpenbotIcons("telescope"), { icons: [], total: 0 });
});

it("defaults to twenty matches and honours a smaller limit", () => {
  const defaulted = searchOpenbotIcons("a");
  const limited = searchOpenbotIcons("a", 3);

  assert.strictEqual(defaulted.icons.length, 20);
  assert.strictEqual(limited.icons.length, 3);
  assert.strictEqual(limited.total, defaulted.total);
});

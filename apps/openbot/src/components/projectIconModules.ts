/**
 * Per-icon module map for `./projectIconLoader`.
 *
 * `import.meta.glob` over `@phosphor-icons/react`'s `dist/csr` directory makes
 * the bundler emit one small chunk per icon (a few kB each) instead of the one
 * ~5 MB chunk a whole-package import produces. The resulting table names all
 * ~1,500 chunks, so it lives in this module on its own and is reached through a
 * dynamic import: the entry chunk stays free of it, and it is fetched once,
 * alongside the first non-default project icon the app renders.
 *
 * `Folder` is excluded because `ProjectIcon` imports it statically as the
 * fallback glyph; the loader answers for it from that import. `Sparkle` is
 * excluded because the product never offers it.
 */
const iconModules = import.meta.glob([
  "../../node_modules/@phosphor-icons/react/dist/csr/*.es.js",
  "!../../node_modules/@phosphor-icons/react/dist/csr/Folder.es.js",
  "!../../node_modules/@phosphor-icons/react/dist/csr/Sparkle*.es.js",
]);

const SUFFIX = ".es.js";

/** Icon module name (`Basket`) to the import that fetches only that icon's chunk. */
export const ICON_MODULE_LOADERS: ReadonlyMap<string, () => Promise<unknown>> = new Map(
  Object.entries(iconModules).map(([path, load]) => [
    path.slice(path.lastIndexOf("/") + 1, -SUFFIX.length),
    load,
  ]),
);

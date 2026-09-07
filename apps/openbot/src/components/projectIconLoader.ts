import { FolderIcon, type Icon } from "@phosphor-icons/react";

/**
 * Loads one Phosphor icon component on demand.
 *
 * A project row needs exactly one glyph, so `import * as Phosphor` to render it
 * would ship the whole ~1,500 icon set (~5 MB) with the app.
 * `./projectIconModules` gives each icon a chunk of its own instead, and this
 * module fetches and caches the one a row asks for.
 */

type IconModule = Readonly<Record<string, unknown>>;
type IconImporter = (moduleName: string) => Promise<IconModule | null>;

/** Phosphor export names are PascalCase identifiers; anything else is not an icon. */
const ICON_NAME = /^[A-Z][A-Za-z0-9]*$/;

/**
 * Deprecated Phosphor v1 names still exported by the package root but with no
 * module of their own: `FolderNotchIcon` lives in `dist/csr/Folder`. The picker
 * offers them and saved projects can hold them, so map them to the owning
 * module. Every other catalog name matches its module name exactly.
 */
export const ALIAS_ICON_MODULES: Readonly<Record<string, string>> = {
  Activity: "Pulse",
  ArchiveBox: "BoxArrowDown",
  ArchiveTray: "TrayArrowDown",
  Caduceus: "Asclepius",
  CircleWavy: "Seal",
  CircleWavyCheck: "SealCheck",
  CircleWavyQuestion: "SealQuestion",
  CircleWavyWarning: "SealWarning",
  FileDotted: "FileDashed",
  FileSearch: "FileMagnifyingGlass",
  FolderDotted: "FolderDashed",
  FolderNotch: "Folder",
  FolderNotchMinus: "FolderMinus",
  FolderNotchOpen: "FolderOpen",
  FolderNotchPlus: "FolderPlus",
  FolderSimpleDotted: "FolderSimpleDashed",
  Lemniscate: "Infinity",
  TextBolder: "TextB",
};

/** The one glyph bundled with the app: the fallback, and the default project icon. */
const STATIC_MODULES: Readonly<Record<string, IconModule>> = {
  Folder: { FolderIcon, FolderNotchIcon: FolderIcon },
};

/** Icon names served from the app bundle rather than a chunk of their own. */
export const BUNDLED_ICON_NAMES: ReadonlyArray<string> = Object.keys(STATIC_MODULES);

const loadIconModule: IconImporter = async (moduleName) => {
  const staticModule = STATIC_MODULES[moduleName];
  if (staticModule) return staticModule;
  const { ICON_MODULE_LOADERS } = await import("./projectIconModules");
  const load = ICON_MODULE_LOADERS.get(moduleName);
  return load ? ((await load()) as IconModule) : null;
};

let importer: IconImporter = loadIconModule;

const resolvedIcons = new Map<string, Icon>();
const pendingIcons = new Map<string, Promise<Icon | null>>();

/** Swaps the module loader; call with nothing to restore the real one. */
export function setIconImporterForTests(next?: IconImporter): void {
  importer = next ?? loadIconModule;
  resolvedIcons.clear();
  pendingIcons.clear();
}

/** The already-loaded component for `name`, or null if it still needs fetching. */
export function getLoadedProjectIcon(name: string): Icon | null {
  return resolvedIcons.get(name) ?? null;
}

/**
 * Resolves the component for a contract icon name, or null when the name is
 * unusable or its chunk fails to load. A failure drops the cache entry so the
 * next render retries instead of reusing a rejected promise forever.
 */
export function loadProjectIconComponent(name: string): Promise<Icon | null> {
  const cached = resolvedIcons.get(name);
  if (cached) return Promise.resolve(cached);

  const inFlight = pendingIcons.get(name);
  if (inFlight) return inFlight;

  if (!ICON_NAME.test(name) || name.includes("Sparkle")) return Promise.resolve(null);

  const load = importer(ALIAS_ICON_MODULES[name] ?? name)
    .then((module) => {
      pendingIcons.delete(name);
      const component = module?.[`${name}Icon`] ?? module?.[name] ?? null;
      if (component === null || (typeof component !== "function" && typeof component !== "object"))
        return null;
      const icon = component as Icon;
      resolvedIcons.set(name, icon);
      return icon;
    })
    .catch(() => {
      pendingIcons.delete(name);
      return null;
    });

  pendingIcons.set(name, load);
  return load;
}

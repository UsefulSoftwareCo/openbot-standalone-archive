import { useEffect, useSyncExternalStore } from "react";
import { FolderIcon } from "@phosphor-icons/react";
import type { OpenbotProjectIcon, OpenbotProjectIconColor } from "@t3tools/contracts";

type IconCatalogModule = typeof import("./iconCatalog");

export const PROJECT_ICON_COLORS: Record<OpenbotProjectIconColor, string> = {
  default: "var(--foreground)",
  gray: "#a1a1aa",
  brown: "#bc967b",
  orange: "#edaa6a",
  yellow: "#dfc66b",
  green: "#80bd98",
  blue: "#80ade8",
  purple: "#b59ae3",
  pink: "#dc97bb",
  red: "#e78f8f",
};

// Module-level cache so the ~1,500-icon catalog chunk is fetched once for the
// whole app, however many ProjectIcon rows are mounted (sidebar, headers, ...).
let cachedCatalog: IconCatalogModule | null = null;
let pendingLoad: Promise<IconCatalogModule> | null = null;
const listeners = new Set<() => void>();

/** Preload the icon catalog chunk; safe to call repeatedly. */
export function preloadIconCatalog(): void {
  if (pendingLoad) return;
  pendingLoad = import("./iconCatalog").then((module) => {
    cachedCatalog = module;
    for (const listener of listeners) listener();
    return module;
  });
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function getSnapshot(): IconCatalogModule | null {
  return cachedCatalog;
}

/** Hook returning the loaded catalog, or null while it is still loading. */
export function useIconCatalog(): IconCatalogModule | null {
  useEffect(() => {
    preloadIconCatalog();
  }, []);
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

/**
 * Renders a project's icon anywhere in the app. Resolves from the lazily
 * loaded catalog once it lands; until then (and for any unrecognized name)
 * falls back to the plain folder glyph so rows never show a gap.
 */
export function ProjectIcon({
  icon,
  size = 16,
  className,
}: {
  readonly icon: OpenbotProjectIcon;
  /** Pixel size passed to the Phosphor component. Default 16. */
  readonly size?: number;
  readonly className?: string;
}) {
  const catalog = useIconCatalog();
  const Resolved = catalog?.ICON_CATALOG_BY_NAME.get(icon.name) ?? FolderIcon;
  return (
    <Resolved
      aria-hidden
      size={size}
      weight="fill"
      style={{ color: PROJECT_ICON_COLORS[icon.color] }}
      className={className}
    />
  );
}

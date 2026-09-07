import { useEffect, useState } from "react";
import { FolderIcon, type Icon } from "@phosphor-icons/react";
import type { OpenbotProjectIcon, OpenbotProjectIconColor } from "@t3tools/contracts";

import { getLoadedProjectIcon, loadProjectIconComponent } from "./projectIconLoader";

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

/**
 * Resolves one icon's component, null until its chunk lands. Renders once per
 * name: a cache hit is read during render, so a remount of an already-seen icon
 * never flashes the fallback and never schedules an update.
 */
function useProjectIconComponent(name: string): Icon | null {
  const [state, setState] = useState<{ readonly name: string; readonly icon: Icon | null }>(() => ({
    name,
    icon: getLoadedProjectIcon(name),
  }));

  if (state.name !== name) {
    setState({ name, icon: getLoadedProjectIcon(name) });
  }

  useEffect(() => {
    if (getLoadedProjectIcon(name)) return;
    let cancelled = false;
    void loadProjectIconComponent(name).then((icon) => {
      if (cancelled || !icon) return;
      setState((current) => (current.name === name ? { name, icon } : current));
    });
    return () => {
      cancelled = true;
    };
  }, [name]);

  return state.name === name ? state.icon : null;
}

/**
 * Renders a project's icon anywhere in the app. Shows the plain folder glyph
 * while the icon's own module loads, and keeps it for any name that is unknown
 * or whose chunk fails to arrive, so rows never show a gap.
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
  const Resolved = useProjectIconComponent(icon.name) ?? FolderIcon;
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

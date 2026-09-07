import { useState } from "react";
import { CheckIcon, FolderIcon } from "@phosphor-icons/react";
import type { OpenbotProjectIcon, OpenbotProjectIconColor } from "@t3tools/contracts";
import { Button } from "@t3tools/ui/button";
import { cn } from "@t3tools/ui/cn";
import { Dialog, DialogPopup, DialogTitle } from "@t3tools/ui/dialog";
import { Input } from "@t3tools/ui/input";

// Statically imported alongside the picker on purpose: this dialog is only
// ever reached through `lazy(() => import("./ProjectIconPicker"))`, so the
// full catalog belongs in the same chunk rather than a second lazy hop.
import { ICON_CATALOG, ICON_CATALOG_BY_NAME } from "./iconCatalog";
import { PROJECT_ICON_COLORS } from "./ProjectIcon";

const ICON_PAGE_SIZE = 120;

const COLOR_OPTIONS: ReadonlyArray<OpenbotProjectIconColor> = [
  "default",
  "gray",
  "brown",
  "orange",
  "yellow",
  "green",
  "blue",
  "purple",
  "pink",
  "red",
];

function normalize(text: string): string {
  return text.toLowerCase().replace(/\s+/g, "");
}

function capitalize(text: string): string {
  return `${text.charAt(0).toUpperCase()}${text.slice(1)}`;
}

const CONTROL_FOCUS_CLASS =
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background";

export default function ProjectIconPicker({
  projectName,
  value,
  busy,
  error,
  onSelect,
  onClose,
}: {
  readonly projectName: string;
  readonly value: OpenbotProjectIcon;
  readonly busy: boolean;
  readonly error: string | null;
  readonly onSelect: (icon: OpenbotProjectIcon) => void;
  readonly onClose: () => void;
}) {
  const [query, setQuery] = useState("");
  const [limit, setLimit] = useState(ICON_PAGE_SIZE);

  const matches = query
    ? ICON_CATALOG.filter((icon) => normalize(icon.label).includes(normalize(query)))
    : ICON_CATALOG;
  const visible = matches.slice(0, limit);
  const SelectedIcon = ICON_CATALOG_BY_NAME.get(value.name) ?? FolderIcon;

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogPopup className="w-[min(440px,calc(100vw-32px))] p-[22px]">
        <div className="mb-5 flex items-center gap-3">
          <span
            className="grid size-12 shrink-0 place-items-center rounded-[10px] bg-muted"
            style={{ color: PROJECT_ICON_COLORS[value.color] }}
          >
            <SelectedIcon aria-hidden size={30} weight="fill" />
          </span>
          <div>
            <DialogTitle>Project icon</DialogTitle>
            <p className="mt-[3px] text-muted-foreground text-xs">{projectName}</p>
          </div>
        </div>

        {/* biome-ignore lint/a11y/noRedundantRoles: fieldset is the simplest way to disable every control below while a save is in flight */}
        <fieldset disabled={busy} className="contents">
          <Input
            autoFocus
            aria-label="Search icons"
            placeholder="Search icons…"
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              setLimit(ICON_PAGE_SIZE);
            }}
          />

          <div aria-label="Icon colour" className="flex justify-between gap-1 py-4">
            {COLOR_OPTIONS.map((color) => {
              const pressed = value.color === color;
              return (
                <button
                  key={color}
                  aria-label={`${capitalize(color)} icon colour`}
                  aria-pressed={pressed}
                  className={cn(
                    "relative grid size-7 place-items-center rounded-full",
                    CONTROL_FOCUS_CLASS,
                    pressed && "outline outline-1 outline-current",
                  )}
                  onClick={() => onSelect({ ...value, color })}
                  style={{ color: PROJECT_ICON_COLORS[color] }}
                  type="button"
                >
                  <span className="size-[18px] rounded-full bg-current" />
                  {pressed && (
                    <CheckIcon
                      aria-hidden
                      className="absolute text-background"
                      size={12}
                      weight="bold"
                    />
                  )}
                </button>
              );
            })}
          </div>

          <div className="flex justify-between pt-[3px] pb-3 text-[11px] text-muted-foreground">
            <span>
              {query
                ? `${matches.length.toLocaleString()} results`
                : `${matches.length.toLocaleString()} icons`}
            </span>
            <span className="opacity-60">Phosphor</span>
          </div>

          <div className="h-[min(320px,40dvh)] overflow-y-auto">
            <div className="grid grid-cols-8 gap-1 p-0.5">
              {visible.map((icon) => {
                const IconComponent = icon.component;
                const pressed = value.name === icon.name;
                return (
                  <button
                    key={icon.name}
                    aria-label={icon.label}
                    aria-pressed={pressed}
                    className={cn(
                      "grid h-10 place-items-center rounded-md hover:bg-muted",
                      CONTROL_FOCUS_CLASS,
                      pressed && "bg-muted outline outline-1 outline-current",
                    )}
                    onClick={() => onSelect({ ...value, name: icon.name })}
                    style={{ color: PROJECT_ICON_COLORS[value.color] }}
                    type="button"
                  >
                    <IconComponent aria-hidden size={23} weight="fill" />
                  </button>
                );
              })}
            </div>
            {matches.length === 0 && (
              <p className="px-3 py-10 text-center text-muted-foreground text-xs">
                No icons found. Try another word.
              </p>
            )}
            {matches.length > limit && (
              <Button
                className="mt-3 w-full"
                onClick={() => setLimit((current) => current + ICON_PAGE_SIZE)}
                size="sm"
                variant="ghost"
              >
                Show more icons
              </Button>
            )}
          </div>
        </fieldset>

        {error !== null && (
          <p className="mt-3 text-error-foreground text-xs" role="alert">
            {error}
          </p>
        )}

        <div className="mt-3 flex items-center justify-between border-border border-t pt-4">
          <span className="text-[11px] text-muted-foreground">Choose an icon and a colour.</span>
          <Button disabled={busy} onClick={onClose} size="sm">
            {busy ? "Saving…" : "Done"}
          </Button>
        </div>
      </DialogPopup>
    </Dialog>
  );
}

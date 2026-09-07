import type {
  EnvironmentId,
  OpenbotChannel,
  OpenbotChannelId,
  OpenbotChannelView,
  OpenbotProject,
  OpenbotProjectId,
} from "@t3tools/contracts";
import { Button } from "@t3tools/ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "@t3tools/ui/dialog";
import { Input } from "@t3tools/ui/input";
import { AlarmClock, ArrowLeft, Menu, PanelRight, Plus, Square } from "lucide-react";
import { useEffect, useState } from "react";

import {
  cancelChannel,
  snoozeChannel,
  startThread,
  useAtomCommand,
  wakeChannel,
} from "../state/channels";
import { commandErrorText } from "../state/errors";
import { ChatAvatar } from "./ChatProfileFields";
import { ChatSettingsDialog } from "./ChatSettingsDialog";
import { NewThreadDialog } from "./NewThreadDialog";
import { ProjectIcon } from "./ProjectIcon";

/**
 * A snooze stays on the thread as a raw timestamp; T3 never emits a wake
 * event when the deadline passes. Read it against the clock exactly like
 * `effectiveSnoozed` in client-runtime, and rerender once the deadline lands
 * so the banner does not outlive the snooze.
 */
export function snoozeActive(snoozedUntil: string | null, nowMs: number): boolean {
  if (snoozedUntil === null) return false;
  const wakeAtMs = Date.parse(snoozedUntil);
  return Number.isFinite(wakeAtMs) && wakeAtMs > nowMs;
}

function useSnoozeActive(snoozedUntil: string | null): boolean {
  const [, bump] = useState(0);
  const active = snoozeActive(snoozedUntil, Date.now());
  useEffect(() => {
    if (!active || snoozedUntil === null) return;
    const delay = Math.min(Math.max(0, Date.parse(snoozedUntil) - Date.now()) + 50, 2_147_483_647);
    const id = window.setTimeout(() => bump((tick) => tick + 1), delay);
    return () => window.clearTimeout(id);
  }, [active, snoozedUntil]);
  return active;
}

function formatSnoozedUntil(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime())
    ? iso
    : date.toLocaleString(undefined, {
        month: "short",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit",
      });
}

/** `datetime-local` wants local wall-clock text, not an ISO instant. */
function toLocalInputValue(date: Date): string {
  const offset = date.getTimezoneOffset() * 60_000;
  return new Date(date.getTime() - offset).toISOString().slice(0, 16);
}

function inMinutes(minutes: number): string {
  return new Date(Date.now() + minutes * 60_000).toISOString();
}

function tomorrowMorning(): string {
  const date = new Date();
  date.setDate(date.getDate() + 1);
  date.setHours(9, 0, 0, 0);
  return date.toISOString();
}

function SnoozeDialog({
  open,
  onOpenChange,
  busy,
  onSnooze,
}: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly busy: boolean;
  readonly onSnooze: (untilIso: string) => void;
}) {
  const [custom, setCustom] = useState(() => toLocalInputValue(new Date(Date.now() + 3_600_000)));
  const presets = [
    { label: "30 minutes", value: () => inMinutes(30) },
    { label: "2 hours", value: () => inMinutes(120) },
    { label: "Tomorrow at 9:00", value: tomorrowMorning },
  ];
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!busy) onOpenChange(next);
      }}
    >
      <DialogPopup className="max-w-sm" bottomStickOnMobile={false}>
        <DialogHeader>
          <DialogTitle>Snooze this chat</DialogTitle>
          <DialogDescription>
            Scheduled work and incoming replies wait until then. You can wake it at any time.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel className="space-y-3">
          <div className="flex flex-col gap-2">
            {presets.map((preset) => (
              <Button
                key={preset.label}
                type="button"
                variant="outline"
                disabled={busy}
                onClick={() => onSnooze(preset.value())}
              >
                {preset.label}
              </Button>
            ))}
          </div>
          <label className="flex flex-col gap-1 text-sm">
            Custom time
            <Input
              type="datetime-local"
              value={custom}
              disabled={busy}
              onChange={(event) => setCustom(event.target.value)}
            />
          </label>
        </DialogPanel>
        <DialogFooter>
          <Button type="button" variant="ghost" disabled={busy} onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            type="button"
            disabled={busy || custom === ""}
            onClick={() => {
              const date = new Date(custom);
              if (!Number.isNaN(date.getTime())) onSnooze(date.toISOString());
            }}
          >
            Snooze until then
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

/**
 * Title row plus the controls that act on the whole chat. A child chat shows
 * its way back to the parent instead of a project icon, and cannot start
 * further threads: nesting is one level deep.
 */
export function ChatHeader({
  environmentId,
  view,
  project,
  parent,
  detailsOpen,
  onToggleDetails,
  onOpenSidebar,
  onOpenProjectIcon,
  onSelectChannel,
}: {
  readonly environmentId: EnvironmentId;
  readonly view: OpenbotChannelView;
  /** The project this chat belongs to, when it has one. */
  readonly project: OpenbotProject | null;
  /** The parent chat, when this is a thread. */
  readonly parent: OpenbotChannel | null;
  readonly detailsOpen: boolean;
  readonly onToggleDetails: () => void;
  readonly onOpenSidebar: () => void;
  readonly onOpenProjectIcon: (projectId: OpenbotProjectId) => void;
  readonly onSelectChannel: (channelId: OpenbotChannelId) => void;
}) {
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [threadOpen, setThreadOpen] = useState(false);
  const [snoozeOpen, setSnoozeOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [threadError, setThreadError] = useState<string | null>(null);
  const snooze = useAtomCommand(snoozeChannel, { reportFailure: false });
  const wake = useAtomCommand(wakeChannel, { reportFailure: false });
  const cancel = useAtomCommand(cancelChannel, { reportFailure: false });
  const start = useAtomCommand(startThread, { reportFailure: false });

  const isThread = parent !== null;
  const { channel } = view;
  const snoozed = useSnoozeActive(view.snoozedUntil);

  /** Runs one chat control and surfaces its failure next to the buttons. */
  const runControl = async (run: () => ReturnType<typeof cancel>) => {
    setBusy(true);
    setError(null);
    const result = await run();
    setBusy(false);
    if (result._tag === "Failure") setError(commandErrorText(result));
    else setSnoozeOpen(false);
  };

  return (
    <>
      <header className="flex h-12 shrink-0 items-center gap-2 border-b border-border px-2 pt-[env(safe-area-inset-top)] md:px-4">
        <Button
          variant="ghost"
          size="icon"
          className="shrink-0 md:hidden"
          aria-label="Open projects and chats"
          onClick={onOpenSidebar}
        >
          <Menu />
        </Button>
        {isThread ? (
          <Button
            variant="ghost"
            size="xs"
            className="shrink-0"
            onClick={() => onSelectChannel(parent.id)}
          >
            <ArrowLeft />
            <span className="max-w-40 truncate">Back to {parent.name}</span>
          </Button>
        ) : project !== null ? (
          <button
            type="button"
            className="openbot-header-icon shrink-0"
            aria-label={`Change the ${project.name} icon`}
            onClick={() => onOpenProjectIcon(project.id)}
          >
            <ProjectIcon icon={project.icon} size={18} />
          </button>
        ) : (
          <ChatAvatar avatar={channel.avatar} name={channel.name} className="size-6" />
        )}
        <h1 className="min-w-0 flex-1 truncate font-medium text-sm">{channel.name}</h1>
        <Button
          variant="ghost"
          size="icon-xs"
          aria-label={detailsOpen ? "Hide computer and routines" : "Show computer and routines"}
          aria-pressed={detailsOpen}
          onClick={onToggleDetails}
        >
          <PanelRight />
        </Button>
      </header>
      {isThread && (
        <p className="shrink-0 border-b border-border/50 px-4 py-1.5 text-muted-foreground text-xs">
          A thread in {parent.name}
          {project === null ? "" : ` · ${project.name}`}
        </p>
      )}
      <div className="flex shrink-0 flex-wrap items-center gap-1 border-b border-border/50 px-2 py-1.5 md:px-4">
        <Button
          variant="ghost"
          size="xs"
          className="text-muted-foreground"
          onClick={() => setSettingsOpen(true)}
        >
          {channel.modelSelection.model}
        </Button>
        {!isThread && (
          <Button
            variant="ghost"
            size="xs"
            className="text-muted-foreground"
            onClick={() => {
              setThreadError(null);
              setThreadOpen(true);
            }}
          >
            <Plus />
            New thread
          </Button>
        )}
        {!snoozed ? (
          <Button
            variant="ghost"
            size="xs"
            className="text-muted-foreground"
            disabled={busy}
            onClick={() => setSnoozeOpen(true)}
          >
            <AlarmClock />
            Snooze
          </Button>
        ) : (
          <Button
            variant="ghost"
            size="xs"
            className="text-muted-foreground"
            disabled={busy}
            onClick={() =>
              void runControl(() => wake({ environmentId, input: { channelId: channel.id } }))
            }
          >
            <AlarmClock />
            Wake
          </Button>
        )}
        {view.status === "working" && (
          <Button
            variant="ghost"
            size="xs"
            className="text-muted-foreground"
            disabled={busy}
            onClick={() =>
              void runControl(() => cancel({ environmentId, input: { channelId: channel.id } }))
            }
          >
            <Square />
            Stop
          </Button>
        )}
        {error !== null && (
          <span role="alert" className="text-error-foreground text-xs">
            {error}
          </span>
        )}
      </div>
      {snoozed && view.snoozedUntil !== null && (
        <p className="shrink-0 bg-warning-surface px-4 py-1.5 text-warning-foreground text-xs">
          Snoozed until {formatSnoozedUntil(view.snoozedUntil)}
        </p>
      )}
      <ChatSettingsDialog
        key={channel.id}
        environmentId={environmentId}
        channel={channel}
        open={settingsOpen}
        onOpenChange={setSettingsOpen}
      />
      <SnoozeDialog
        open={snoozeOpen}
        onOpenChange={setSnoozeOpen}
        busy={busy}
        onSnooze={(until) =>
          void runControl(() => snooze({ environmentId, input: { channelId: channel.id, until } }))
        }
      />
      {threadOpen && (
        <NewThreadDialog
          open={threadOpen}
          onOpenChange={setThreadOpen}
          parentName={channel.name}
          busy={busy}
          error={threadError}
          onStart={async (input) => {
            setBusy(true);
            setThreadError(null);
            const result = await start({
              environmentId,
              input: { parentChannelId: channel.id, ...input },
            });
            setBusy(false);
            if (result._tag === "Failure") {
              setThreadError(commandErrorText(result));
              return;
            }
            setThreadOpen(false);
            onSelectChannel(result.value.channel.id);
          }}
        />
      )}
    </>
  );
}

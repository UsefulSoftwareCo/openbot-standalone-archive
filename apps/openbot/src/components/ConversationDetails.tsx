import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import {
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  DEFAULT_RUNTIME_MODE,
  type EnvironmentId,
  type OpenbotChannelView,
  type ScheduledTask,
  type ScheduledTaskUpsertInput,
} from "@t3tools/contracts";
import { Button } from "@t3tools/ui/button";
import { Input } from "@t3tools/ui/input";
import { Tooltip, TooltipPopup, TooltipTrigger } from "@t3tools/ui/tooltip";
import { ArrowLeft, ChevronRight, Clock3, Plus, X } from "lucide-react";
import { Switch } from "@base-ui/react/switch";
import * as Effect from "effect/Effect";
import * as Random from "effect/Random";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";
import { AsyncResult } from "effect/unstable/reactivity";
import { useEffect, useState } from "react";
import {
  deleteRoutine,
  getRoutineThread,
  saveRoutine,
  setRoutineEnabled,
  testRoutine,
  useAtomCommand,
  useRoutines,
} from "../state/channels";
import { ComputerCard } from "./computer/ComputerCard";
import { describeCron } from "./cronDescription";

const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const fieldClass = "w-full rounded-md border border-border bg-background px-3 py-2 text-sm";
function failureText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
function scheduleLabel(schedule: ScheduledTask["schedule"]): string {
  if (schedule.type === "interval") return `Every ${schedule.everyMs / 60000} minutes`;
  if (schedule.type === "cron") return describeCron(schedule.expression) ?? schedule.expression;
  const selected = schedule.weekdays;
  const label =
    selected === undefined || selected.length === 0 || selected.length === 7
      ? "Every day"
      : selected.length === 5 && [1, 2, 3, 4, 5].every((day) => selected.includes(day))
        ? "Weekdays"
        : selected.map((day) => days[day]).join(", ");
  return `${label} at ${schedule.timeOfDay}`;
}

/**
 * The second line of a routine row. A cron expression means different times in
 * different zones, so the zone is still reachable on hover, but it is noise in
 * a list that is scanned, and the routine editor is where it is read and set.
 */
function ScheduleLine({ task }: { readonly task: ScheduledTask }) {
  const line = (
    <span className="block text-xs text-muted-foreground">
      {scheduleLabel(task.schedule)}
      {task.enabled ? "" : " · Paused"}
    </span>
  );
  if (task.schedule.type !== "cron") return line;
  const zone = task.schedule.timeZone;
  return (
    <Tooltip>
      <TooltipTrigger render={line} />
      <TooltipPopup side="bottom">{zone}</TooltipPopup>
    </Tooltip>
  );
}

type DetailPage =
  | { readonly type: "list" }
  | { readonly type: "new" }
  | { readonly type: "routine"; readonly id: ScheduledTask["id"] };
/** Grok-style details: a compact routine list, replaced by the selected routine editor. */
export function ConversationDetails({
  environmentId,
  view,
  onClose,
  onOpenComputer,
}: {
  readonly environmentId: EnvironmentId;
  readonly view: OpenbotChannelView;
  readonly onClose: () => void;
  /** Opens the host's screen full pane; the card here is only a glance at it. */
  readonly onOpenComputer: () => void;
}) {
  const query = useRoutines(environmentId);
  const result = Option.getOrUndefined(AsyncResult.value(query));
  const [page, setPage] = useState<DetailPage>({ type: "list" });
  const routines = result?.tasks.filter((task) => task.threadId === view.channel.threadId) ?? [];
  const selected =
    page.type === "routine" ? routines.find((task) => task.id === page.id) : undefined;
  return (
    <aside
      aria-label="Conversation details"
      className="flex h-full min-h-0 w-full flex-col bg-background"
    >
      <header className="flex h-12 shrink-0 items-center justify-between border-b border-border px-3">
        {page.type === "list" ? (
          <span className="px-1 font-medium text-sm">Details</span>
        ) : (
          <>
            <Button variant="ghost" size="sm" onClick={() => setPage({ type: "list" })}>
              <ArrowLeft className="size-4" />
              Routines
            </Button>
            <span className="font-medium text-sm">Routine</span>
          </>
        )}
        <Button variant="ghost" size="icon" aria-label="Close details" onClick={onClose}>
          <X className="size-4" />
        </Button>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto p-4">
        {result === undefined ? (
          <p role="status" className="text-sm text-muted-foreground">
            {query._tag === "Failure"
              ? "Could not load routines. Check the connection."
              : "Loading routines…"}
          </p>
        ) : page.type === "list" ? (
          <>
            <ComputerCard environmentId={environmentId} onOpen={onOpenComputer} />
            <div className="mb-3 flex items-center justify-between">
              <h2 className="font-medium text-sm">Routines</h2>
              <Button
                variant="ghost"
                size="icon"
                aria-label="Create Routine"
                onClick={() => setPage({ type: "new" })}
              >
                <Plus className="size-4" />
              </Button>
            </div>
            {routines.length === 0 ? (
              <p className="text-sm text-muted-foreground">No routines yet.</p>
            ) : (
              <ul className="space-y-1" aria-label="Routines">
                {routines.map((task) => (
                  <li key={task.id}>
                    <button
                      className="flex w-full items-center gap-3 rounded-lg px-2 py-3 text-left hover:bg-accent"
                      onClick={() => setPage({ type: "routine", id: task.id })}
                    >
                      <Clock3 className="size-4 shrink-0 text-muted-foreground" />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm font-medium">{task.title}</span>
                        <ScheduleLine task={task} />
                      </span>
                      <ChevronRight className="size-4 text-muted-foreground" />
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </>
        ) : page.type === "new" || selected !== undefined ? (
          <RoutineEditor
            key={selected?.id ?? "new"}
            environmentId={environmentId}
            view={view}
            task={selected}
            onSaved={(task) => setPage({ type: "routine", id: task.id })}
            onDeleted={() => setPage({ type: "list" })}
          />
        ) : (
          <p className="text-sm text-muted-foreground">This routine was deleted.</p>
        )}
      </div>
    </aside>
  );
}

function RoutineEditor({
  environmentId,
  view,
  task,
  onSaved,
  onDeleted,
}: {
  readonly environmentId: EnvironmentId;
  readonly view: OpenbotChannelView;
  readonly task: ScheduledTask | undefined;
  readonly onSaved: (task: ScheduledTask) => void;
  readonly onDeleted: () => void;
}) {
  const [title, setTitle] = useState(task?.title ?? "");
  const [prompt, setPrompt] = useState(task?.prompt ?? "");
  // The mode follows the stored schedule type only, so saving never silently
  // switches a routine between variants.
  const [mode, setMode] = useState<"interval" | "fixed_time" | "cron">(
    task?.schedule.type ?? "fixed_time",
  );
  const [cronExpression, setCronExpression] = useState(
    task?.schedule.type === "cron" ? task.schedule.expression : "0 9 * * 1-5",
  );
  const [cronTimeZone, setCronTimeZone] = useState(
    task?.schedule.type === "cron"
      ? task.schedule.timeZone
      : new Intl.DateTimeFormat().resolvedOptions().timeZone,
  );
  const [time, setTime] = useState(
    task?.schedule.type === "fixed_time" ? task.schedule.timeOfDay : "08:00",
  );
  const [weekdays, setWeekdays] = useState<ReadonlyArray<number>>(
    task?.schedule.type === "fixed_time" &&
      task.schedule.weekdays !== undefined &&
      task.schedule.weekdays.length > 0
      ? task.schedule.weekdays
      : [0, 1, 2, 3, 4, 5, 6],
  );
  const [minutes, setMinutes] = useState(
    task?.schedule.type === "interval" ? String(task.schedule.everyMs / 60000) : "60",
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [commandId] = useState(() =>
    CommandId.make(
      `openbot-routine:${Effect.runSync(Effect.all([Random.nextInt, Random.nextInt, Random.nextInt, Random.nextInt])).join("-")}`,
    ),
  );
  const save = useAtomCommand(saveRoutine, { reportFailure: false });
  const enable = useAtomCommand(setRoutineEnabled, { reportFailure: false });
  const remove = useAtomCommand(deleteRoutine, { reportFailure: false });
  const run = useAtomCommand(testRoutine, { reportFailure: false });
  const readHistory = useAtomCommand(getRoutineThread, { reportFailure: false });
  const [history, setHistory] = useState<ReadonlyArray<{
    readonly id: string;
    readonly at: string;
    readonly status: string;
  }> | null>(null);
  const [historyError, setHistoryError] = useState<string | null>(null);
  useEffect(() => {
    if (task === undefined) return;
    let disposed = false;
    void readHistory({ environmentId, input: { threadId: view.channel.threadId } }).then(
      (result) => {
        if (disposed) return;
        if (result._tag === "Failure") {
          setHistoryError(failureText(squashAtomCommandFailure(result)));
          return;
        }
        setHistoryError(null);
        const prefix = `scheduled-task-message:${task.id}:`;
        setHistory(
          result.value.messages
            .filter((message) => message.id.startsWith(prefix))
            .map((message) => ({
              id: message.id,
              at: DateTime.formatIso(message.createdAt),
              status:
                result.value.runs.find((run) => run.userMessageId === message.id)?.status ??
                "queued",
            }))
            .reverse(),
        );
      },
    );
    return () => {
      disposed = true;
    };
  }, [environmentId, readHistory, task?.id, task?.runCount, view.channel.threadId, view.status]);
  // The server owns real cron syntax and zone validation; this only keeps
  // obviously incomplete input from being sent.
  const scheduleValid =
    mode === "cron"
      ? cronExpression.trim().split(/\s+/).length === 5 && cronTimeZone.trim().length > 0
      : mode === "interval"
        ? Number.isFinite(Number(minutes)) && Number(minutes) >= 1
        : /^([01]\d|2[0-3]):[0-5]\d$/.test(time) && weekdays.length > 0;
  const valid = title.trim().length > 0 && prompt.trim().length > 0 && scheduleValid;
  // Reads back what the typed expression means, so the user is not left
  // decoding their own cron. Stays honest while the expression is half-typed.
  const cronDescription = describeCron(cronExpression);
  const cronZone = cronTimeZone.trim();
  const cronPreview =
    cronDescription === undefined
      ? "Not a complete cron expression yet."
      : cronZone.length === 0
        ? cronDescription
        : `${cronDescription} · ${cronZone}`;
  const persist = async () => {
    if (!valid) return undefined;
    const input: ScheduledTaskUpsertInput = {
      commandId,
      ...(task === undefined ? {} : { id: task.id }),
      title: title.trim(),
      prompt: prompt.trim(),
      enabled: task?.enabled ?? false,
      schedule:
        mode === "cron"
          ? { type: "cron", expression: cronExpression.trim(), timeZone: cronTimeZone.trim() }
          : mode === "interval"
            ? { type: "interval", everyMs: Math.round(Number(minutes) * 60000) }
            : { type: "fixed_time", timeOfDay: time, weekdays },
      projectId: view.channel.projectId,
      threadId: view.channel.threadId,
      workspaceStrategy: task?.workspaceStrategy ?? { type: "root" },
      modelSelection: task?.modelSelection ?? view.channel.modelSelection,
      runtimeMode: task?.runtimeMode ?? DEFAULT_RUNTIME_MODE,
      interactionMode: task?.interactionMode ?? DEFAULT_PROVIDER_INTERACTION_MODE,
      deliveryMode: "queue",
      createdBy: "agent",
      creationSource: "web",
    };
    const result = await save({ environmentId, input });
    if (result._tag === "Failure") {
      setError(failureText(squashAtomCommandFailure(result)));
      return undefined;
    }
    onSaved(result.value.task);
    return result.value.task;
  };
  return (
    <form
      className="space-y-5"
      onSubmit={async (event) => {
        event.preventDefault();
        setBusy(true);
        setError(null);
        setNotice(null);
        const saved = await persist();
        if (saved !== undefined) setNotice("Saved");
        setBusy(false);
      }}
    >
      {task !== undefined && (
        <div className="flex items-center gap-2">
          <label className="mr-auto flex items-center gap-2 text-sm">
            <Switch.Root
              className="inline-flex h-5 w-9 items-center rounded-full bg-input p-0.5 data-checked:bg-primary"
              checked={task.enabled}
              disabled={busy}
              onCheckedChange={async (checked) => {
                setBusy(true);
                setError(null);
                const result = await enable({
                  environmentId,
                  input: { id: task.id, enabled: checked },
                });
                if (result._tag === "Failure")
                  setError(failureText(squashAtomCommandFailure(result)));
                setBusy(false);
              }}
            >
              <Switch.Thumb className="size-4 rounded-full bg-background shadow-sm transition-transform data-checked:translate-x-4" />
            </Switch.Root>
            Active
          </label>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={busy}
            onClick={() => setConfirmDelete(true)}
          >
            Delete
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={busy || !valid}
            onClick={async () => {
              setBusy(true);
              setError(null);
              setNotice(null);
              const saved = await persist();
              if (saved !== undefined) {
                const result = await run({ environmentId, input: { id: saved.id } });
                if (result._tag === "Failure")
                  setError(failureText(squashAtomCommandFailure(result)));
                else setNotice("Test run queued. Its reply will appear in the conversation.");
              }
              setBusy(false);
            }}
          >
            Test run
          </Button>
        </div>
      )}
      {confirmDelete && task !== undefined && (
        <div className="space-y-2 rounded-md border border-border p-3 text-sm">
          <p>Delete this routine?</p>
          <div className="flex gap-2">
            <Button
              type="button"
              variant="destructive"
              size="sm"
              disabled={busy}
              onClick={async () => {
                setBusy(true);
                const result = await remove({ environmentId, input: { id: task.id } });
                if (result._tag === "Failure") {
                  setError(failureText(squashAtomCommandFailure(result)));
                  setBusy(false);
                } else onDeleted();
              }}
            >
              Delete routine
            </Button>
            <Button type="button" variant="ghost" size="sm" onClick={() => setConfirmDelete(false)}>
              Cancel
            </Button>
          </div>
        </div>
      )}
      <label className="block space-y-2 text-sm">
        <span>Name</span>
        <Input
          value={title}
          placeholder="Name this routine"
          disabled={busy}
          onChange={(event) => setTitle(event.target.value)}
        />
      </label>
      <label className="block space-y-2 text-sm">
        <span>Instruction</span>
        <textarea
          className={`${fieldClass} min-h-48 resize-y`}
          value={prompt}
          placeholder="What should this routine do each time it runs?"
          disabled={busy}
          onChange={(event) => setPrompt(event.target.value)}
        />
      </label>
      {
        <fieldset disabled={busy} className="space-y-3">
          <legend className="mb-2 text-sm">When to run</legend>
          <select
            aria-label="Schedule type"
            className={fieldClass}
            value={mode}
            onChange={(event) => {
              const next = event.target.value;
              if (next === "interval" || next === "fixed_time" || next === "cron") setMode(next);
            }}
          >
            <option value="fixed_time">At a set time</option>
            <option value="interval">At an interval</option>
            <option value="cron">Cron expression</option>
          </select>
          {mode === "cron" ? (
            <>
              <input
                aria-label="Cron expression"
                className={`${fieldClass} font-mono`}
                placeholder="0 9 * * 1-5"
                value={cronExpression}
                onChange={(event) => setCronExpression(event.target.value)}
              />
              <input
                aria-label="Time zone"
                className={fieldClass}
                placeholder="UTC"
                value={cronTimeZone}
                onChange={(event) => setCronTimeZone(event.target.value)}
              />
              <p className="text-muted-foreground text-xs">{cronPreview}</p>
              <p className="text-muted-foreground text-xs">
                Five fields: minute, hour, day of month, month, weekday. Evaluated in the time zone
                above.
              </p>
            </>
          ) : mode === "fixed_time" ? (
            <>
              <input
                aria-label="Time"
                type="time"
                className={fieldClass}
                value={time}
                onChange={(event) => setTime(event.target.value)}
              />
              <div className="flex flex-wrap gap-1">
                {days.map((day, index) => (
                  <button
                    key={day}
                    type="button"
                    aria-pressed={weekdays.includes(index)}
                    className={`rounded-md border px-2 py-1.5 text-xs ${weekdays.includes(index) ? "border-primary bg-primary text-primary-foreground" : "border-border text-muted-foreground"}`}
                    onClick={() =>
                      setWeekdays((current) =>
                        current.includes(index)
                          ? current.filter((item) => item !== index)
                          : [...current, index].sort(),
                      )
                    }
                  >
                    {day}
                  </button>
                ))}
              </div>
            </>
          ) : (
            <label className="flex items-center gap-2 text-sm">
              Every
              <Input
                type="number"
                min="1"
                step="1"
                aria-label="Interval minutes"
                value={minutes}
                onChange={(event) => setMinutes(event.target.value)}
              />
              minutes
            </label>
          )}
          {mode !== "cron" && (
            <p className="text-xs text-muted-foreground">Times use the server’s local time zone.</p>
          )}
        </fieldset>
      }
      {error !== null && (
        <p role="alert" className="text-sm text-error-foreground">
          {error}
        </p>
      )}
      {notice !== null && (
        <p role="status" className="text-xs text-muted-foreground">
          {notice}
        </p>
      )}
      <Button type="submit" disabled={busy || !valid}>
        {task === undefined ? "Create routine" : "Save"}
      </Button>
      {task !== undefined && (
        <section className="space-y-3 border-t border-border pt-4">
          <h3 className="text-sm font-medium">Run history</h3>
          {historyError !== null ? (
            <p className="text-xs text-error-foreground">{historyError}</p>
          ) : history === null ? (
            <p className="text-xs text-muted-foreground">Loading run history…</p>
          ) : history.length === 0 ? (
            <p className="text-xs text-muted-foreground">No runs yet.</p>
          ) : (
            <ul className="space-y-3">
              {history.map((run) => (
                <li key={run.id} className="flex items-center justify-between gap-2 text-xs">
                  <time dateTime={run.at}>
                    {new Date(run.at).toLocaleString(undefined, {
                      month: "short",
                      day: "numeric",
                      hour: "numeric",
                      minute: "2-digit",
                    })}
                  </time>
                  <span className="capitalize text-muted-foreground">{run.status}</span>
                </li>
              ))}
            </ul>
          )}
        </section>
      )}
    </form>
  );
}

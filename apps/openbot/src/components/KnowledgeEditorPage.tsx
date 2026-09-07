import type {
  EnvironmentId,
  OpenbotKnowledge,
  OpenbotKnowledgeId,
  OpenbotProjectId,
} from "@t3tools/contracts";
import { Button } from "@t3tools/ui/button";
import { Input } from "@t3tools/ui/input";
import { Spinner } from "@t3tools/ui/spinner";
import { ArrowLeft } from "lucide-react";
import { type ReactNode, useEffect, useState } from "react";
import { commandErrorText } from "../state/errors";
import { type CommandAttempt, commandAttempt } from "../state/ids";
import {
  createKnowledge,
  deleteKnowledge,
  updateKnowledge,
  useAtomCommand,
  useKnowledge,
  useProjects,
} from "../state/channels";

type KnowledgeCreateAttempt = CommandAttempt<{ readonly title: string; readonly body: string }>;

/** Adds or removes one project link. The owner is always relevant and cannot be removed. */
export function toggleProjectLink(
  current: ReadonlySet<OpenbotProjectId>,
  ownerProjectId: OpenbotProjectId | null,
  projectId: OpenbotProjectId,
): ReadonlySet<OpenbotProjectId> {
  const next = new Set(current);
  if (projectId === ownerProjectId) {
    next.add(projectId);
    return next;
  }
  if (next.has(projectId)) next.delete(projectId);
  else next.add(projectId);
  return next;
}

/** The link set to save: what the user picked, plus the owner. */
export function linkedProjectIds(
  selected: ReadonlySet<OpenbotProjectId>,
  ownerProjectId: OpenbotProjectId | null,
): ReadonlyArray<OpenbotProjectId> {
  const linked = new Set(selected);
  if (ownerProjectId !== null) linked.add(ownerProjectId);
  return [...linked];
}

function sameLinks(
  selected: ReadonlySet<OpenbotProjectId>,
  saved: ReadonlyArray<OpenbotProjectId>,
): boolean {
  return selected.size === saved.length && saved.every((projectId) => selected.has(projectId));
}

/** What the fields were loaded with, so an edit is measured against it. */
interface KnowledgeSeed {
  readonly id: OpenbotKnowledgeId | null;
  readonly title: string;
  readonly body: string;
  readonly projectIds: ReadonlyArray<OpenbotProjectId>;
}

function PageFrame({ children }: { readonly children: ReactNode }) {
  return (
    <div className="flex h-full min-h-0 flex-1 flex-col overflow-auto">
      <div className="mx-auto flex w-full max-w-3xl flex-1 flex-col px-6 py-6">{children}</div>
    </div>
  );
}

/** Full-page knowledge editor: create, edit, and delete one entry. Replaces the main area. */
export function KnowledgeEditorPage(props: {
  readonly environmentId: EnvironmentId;
  readonly knowledgeId: OpenbotKnowledgeId | null;
  /** Owner project for a new entry, and the scope this editor reads from. */
  readonly projectId: OpenbotProjectId | null;
  /** Leaves without saving; the caller warns about a discarded edit. */
  readonly onCancel: () => void;
  /** Leaves after the entry was written or deleted; nothing is left to discard. */
  readonly onSaved: () => void;
  /** Reports whether leaving this page would discard an edit. */
  readonly onUnsavedChange: (unsaved: boolean) => void;
}) {
  const { environmentId, knowledgeId, projectId, onCancel, onSaved, onUnsavedChange } = props;
  const knowledge = useKnowledge(environmentId, projectId);
  const projects = useProjects(environmentId);
  const existing =
    knowledgeId === null
      ? null
      : (knowledge.items.find((entry) => entry.id === knowledgeId) ?? null);

  const emptySeed: KnowledgeSeed = {
    id: null,
    title: "",
    body: "",
    projectIds: projectId === null ? [] : [projectId],
  };
  const [seed, setSeed] = useState<KnowledgeSeed>(emptySeed);
  const [title, setTitle] = useState(emptySeed.title);
  const [body, setBody] = useState(emptySeed.body);
  const [selected, setSelected] = useState<ReadonlySet<OpenbotProjectId>>(
    () => new Set(emptySeed.projectIds),
  );
  const [attempt, setAttempt] = useState<KnowledgeCreateAttempt | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const create = useAtomCommand(createKnowledge, { reportFailure: false });
  const update = useAtomCommand(updateKnowledge, { reportFailure: false });
  const remove = useAtomCommand(deleteKnowledge, { reportFailure: false });

  const ownerProjectId = existing?.ownerProjectId ?? projectId;

  /** Loads an entry into the fields; also the "Load latest" action after a conflict. */
  const loadEntry = (entry: OpenbotKnowledge) => {
    setSeed({ id: entry.id, title: entry.title, body: entry.body, projectIds: entry.projectIds });
    setTitle(entry.title);
    setBody(entry.body);
    setSelected(new Set(entry.projectIds));
    setError(null);
  };

  // Seed the fields once the subscription delivers the entry being edited. This
  // is the React-recommended render-phase adjustment, and it only runs when the
  // editor moves to a different entry, so it never overwrites a draft.
  if (existing !== null && seed.id !== existing.id) loadEntry(existing);

  const dirty = title !== seed.title || body !== seed.body || !sameLinks(selected, seed.projectIds);
  useEffect(() => {
    onUnsavedChange(dirty);
    return () => onUnsavedChange(false);
  }, [dirty, onUnsavedChange]);

  if (knowledgeId !== null && existing === null) {
    return (
      <PageFrame>
        {knowledge.loading ? (
          <div className="flex flex-1 items-center justify-center">
            <Spinner className="size-5 text-muted-foreground" />
          </div>
        ) : (
          <>
            <p role={knowledge.error === null ? undefined : "alert"} className="text-sm">
              {knowledge.error ?? "This entry no longer exists."}
            </p>
            <Button variant="ghost" size="sm" className="mt-3 self-start" onClick={onCancel}>
              <ArrowLeft />
              Back
            </Button>
          </>
        )}
      </PageFrame>
    );
  }

  const onSave = async () => {
    setBusy(true);
    setError(null);
    const projectIds = linkedProjectIds(selected, ownerProjectId);
    if (existing === null) {
      const next = commandAttempt(attempt, "knowledge-create", { title, body });
      setAttempt(next);
      const result = await create({
        environmentId,
        input: {
          title,
          body,
          ownerProjectId: projectId,
          projectIds,
          commandId: next.commandId,
        },
      });
      setBusy(false);
      if (result._tag === "Success") onSaved();
      else setError(commandErrorText(result));
      return;
    }
    const result = await update({
      environmentId,
      input: {
        knowledgeId: existing.id,
        expectedRevision: existing.revision,
        title,
        body,
        projectIds,
      },
    });
    setBusy(false);
    if (result._tag === "Success") onSaved();
    else setError(commandErrorText(result));
  };

  const onDelete = async () => {
    if (existing === null) return;
    setBusy(true);
    setError(null);
    const result = await remove({
      environmentId,
      input: { knowledgeId: existing.id, expectedRevision: existing.revision },
    });
    setBusy(false);
    if (result._tag === "Success") onSaved();
    else setError(commandErrorText(result));
  };

  return (
    <PageFrame>
      <Button variant="ghost" size="xs" className="mb-5 self-start" onClick={onCancel}>
        <ArrowLeft />
        Back
      </Button>
      <label className="flex flex-col gap-1 text-sm">
        Title
        <Input
          value={title}
          maxLength={200}
          placeholder="Entry title"
          onChange={(event) => setTitle(event.target.value)}
        />
      </label>
      <label className="mt-5 flex flex-1 flex-col gap-1 text-sm">
        Content
        <textarea
          className="min-h-72 flex-1 resize-y rounded-lg border border-border bg-background p-4 text-sm leading-7 outline-none focus:ring-1 focus:ring-ring"
          value={body}
          maxLength={64_000}
          onChange={(event) => setBody(event.target.value)}
        />
      </label>
      <div className="mt-5 font-medium text-sm">Relevant projects</div>
      <p className="mt-1 text-muted-foreground text-xs">
        Links guide what the assistant looks at. The owning project is always included.
      </p>
      <div className="mt-2 flex flex-wrap gap-2">
        {projects.map((project) => {
          const isOwner = project.id === ownerProjectId;
          if (isOwner) {
            return (
              <span
                key={project.id}
                className="inline-flex h-7 items-center gap-1.5 rounded-[var(--control-radius)] bg-secondary px-2 text-secondary-foreground text-sm sm:h-6 sm:text-xs"
              >
                {project.name}
                <span className="text-[10px] opacity-70">Owner</span>
              </span>
            );
          }
          const isSelected = selected.has(project.id);
          return (
            <Button
              key={project.id}
              type="button"
              variant={isSelected ? "default" : "outline"}
              size="xs"
              aria-pressed={isSelected}
              disabled={busy}
              onClick={() =>
                setSelected((current) => toggleProjectLink(current, ownerProjectId, project.id))
              }
            >
              {project.name}
            </Button>
          );
        })}
      </div>
      {error !== null && (
        <div role="alert" className="mt-5 space-y-2 text-error-foreground text-sm">
          <p>{error} Your edit is still here.</p>
          {existing !== null && (
            <Button variant="outline" size="sm" disabled={busy} onClick={() => loadEntry(existing)}>
              Load latest
            </Button>
          )}
        </div>
      )}
      <div className="mt-6 flex items-center gap-2">
        <Button disabled={busy || title.trim() === "" || !dirty} onClick={() => void onSave()}>
          {busy ? "Saving…" : "Save"}
        </Button>
        <Button variant="ghost" disabled={busy} onClick={onCancel}>
          Cancel
        </Button>
        {existing !== null && !confirmDelete && (
          <Button
            variant="ghost"
            className="ml-auto"
            disabled={busy}
            onClick={() => setConfirmDelete(true)}
          >
            Delete
          </Button>
        )}
      </div>
      {confirmDelete && existing !== null && (
        <div className="mt-3 space-y-2 rounded-md border border-border p-3 text-sm">
          <p>Delete “{existing.title}”? This cannot be undone.</p>
          <div className="flex gap-2">
            <Button
              type="button"
              variant="destructive"
              size="sm"
              disabled={busy}
              onClick={() => void onDelete()}
            >
              Delete entry
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={busy}
              onClick={() => setConfirmDelete(false)}
            >
              Cancel
            </Button>
          </div>
        </div>
      )}
    </PageFrame>
  );
}

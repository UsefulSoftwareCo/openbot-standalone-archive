import type { EnvironmentId, OpenbotKnowledgeId, OpenbotProjectId } from "@t3tools/contracts";
import { Button } from "@t3tools/ui/button";
import { Input } from "@t3tools/ui/input";
import { Spinner } from "@t3tools/ui/spinner";
import { useState } from "react";
import { commandErrorText } from "../state/errors";
import { newCommandId } from "../state/ids";
import {
  createKnowledge,
  deleteKnowledge,
  updateKnowledge,
  useAtomCommand,
  useKnowledge,
  useProjects,
} from "../state/channels";

/** Full-page knowledge editor: create, edit, and delete one entry. Replaces the main area. */
export function KnowledgeEditorPage(props: {
  readonly environmentId: EnvironmentId;
  readonly knowledgeId: OpenbotKnowledgeId | null;
  readonly projectId: OpenbotProjectId | null;
  readonly onClose: () => void;
}) {
  const { environmentId, knowledgeId, projectId, onClose } = props;
  const entries = useKnowledge(environmentId, null);
  const projects = useProjects(environmentId);
  const existing =
    knowledgeId === null ? null : (entries.find((e) => e.id === knowledgeId) ?? null);
  // Editing an existing entry always starts from a list that already contained it (the caller
  // navigated here from a row showing this id), so an empty subscription snapshot means the
  // stream has not delivered data yet, not that the entry is gone.
  const listArrived = knowledgeId === null || entries.length > 0;

  const [title, setTitle] = useState(() => existing?.title ?? "");
  const [body, setBody] = useState(() => existing?.body ?? "");
  const [projectIds, setProjectIds] = useState<ReadonlySet<OpenbotProjectId>>(
    () => new Set(existing?.projectIds ?? (projectId === null ? [] : [projectId])),
  );
  const [seededId, setSeededId] = useState<OpenbotKnowledgeId | null>(existing?.id ?? null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [commandId] = useState(() => newCommandId("knowledge-create"));

  const create = useAtomCommand(createKnowledge, { reportFailure: false });
  const update = useAtomCommand(updateKnowledge, { reportFailure: false });
  const remove = useAtomCommand(deleteKnowledge, { reportFailure: false });

  const ownerProjectId = existing?.ownerProjectId ?? projectId;

  // Seed the draft once the subscription delivers the existing entry (React-recommended
  // render-phase state adjustment; guarded so it only fires the first time this id resolves).
  if (existing !== null && seededId !== existing.id) {
    setTitle(existing.title);
    setBody(existing.body);
    setProjectIds(new Set(existing.projectIds));
    setSeededId(existing.id);
  }

  if (knowledgeId !== null && !listArrived) {
    return (
      <div className="flex h-full min-h-0 flex-1 flex-col overflow-auto">
        <div className="mx-auto flex w-full max-w-3xl flex-1 items-center justify-center px-6 py-6">
          <Spinner className="size-5 text-muted-foreground" />
        </div>
      </div>
    );
  }

  if (knowledgeId !== null && existing === null) {
    return (
      <div className="flex h-full min-h-0 flex-1 flex-col overflow-auto">
        <div className="mx-auto w-full max-w-3xl px-6 py-6">
          <p className="text-sm text-muted-foreground">This entry no longer exists.</p>
          <Button variant="ghost" size="sm" className="mt-3" onClick={onClose}>
            Back
          </Button>
        </div>
      </div>
    );
  }

  const toggleProject = (id: OpenbotProjectId) => {
    if (id === ownerProjectId) return;
    setProjectIds((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const onSave = async () => {
    setBusy(true);
    setError(null);
    const nextProjectIds = Array.from(projectIds);
    const result =
      existing == null
        ? await create({
            environmentId,
            input: {
              title,
              body,
              ownerProjectId: projectId,
              projectIds: nextProjectIds,
              commandId,
            },
          })
        : await update({
            environmentId,
            input: {
              knowledgeId: existing.id,
              expectedRevision: existing.revision,
              title,
              body,
              projectIds: nextProjectIds,
            },
          });
    setBusy(false);
    if (result._tag === "Success") onClose();
    else setError(commandErrorText(result));
  };

  const onDelete = async () => {
    if (existing == null) return;
    setBusy(true);
    setError(null);
    const result = await remove({
      environmentId,
      input: { knowledgeId: existing.id, expectedRevision: existing.revision },
    });
    setBusy(false);
    if (result._tag === "Success") onClose();
    else setError(commandErrorText(result));
  };

  return (
    <div className="flex h-full min-h-0 flex-1 flex-col overflow-auto">
      <div className="mx-auto flex w-full max-w-3xl flex-1 flex-col px-6 py-6">
        <label className="flex flex-col gap-1 text-sm">
          Title
          <Input
            value={title}
            maxLength={200}
            disabled={busy}
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
            disabled={busy}
            onChange={(event) => setBody(event.target.value)}
          />
        </label>
        <div className="mt-5 text-sm font-medium">Relevant projects</div>
        <div className="mt-2 flex flex-wrap gap-2">
          {projects.map((project) => {
            const selected = projectIds.has(project.id) || project.id === ownerProjectId;
            const isOwner = project.id === ownerProjectId;
            return (
              <Button
                key={project.id}
                type="button"
                variant={selected ? "default" : "outline"}
                size="xs"
                aria-pressed={selected}
                disabled={busy || isOwner}
                title={isOwner ? "Owner" : undefined}
                onClick={() => toggleProject(project.id)}
              >
                {project.name}
                {isOwner && <span className="text-[10px] opacity-80">Owner</span>}
              </Button>
            );
          })}
        </div>
        {error !== null && (
          <p role="alert" className="mt-5 text-sm text-error-foreground">
            {error} Your draft is still here.
          </p>
        )}
        <div className="mt-6 flex items-center gap-2">
          <Button disabled={busy || title.trim() === ""} onClick={() => void onSave()}>
            {busy ? "Saving…" : "Save"}
          </Button>
          <Button variant="ghost" disabled={busy} onClick={onClose}>
            Cancel
          </Button>
          {existing != null && !confirmDelete && (
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
        {confirmDelete && existing != null && (
          <div className="mt-3 space-y-2 rounded-md border border-border p-3 text-sm">
            <p>Delete this entry?</p>
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
      </div>
    </div>
  );
}

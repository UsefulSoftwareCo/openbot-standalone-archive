import type { EnvironmentId, OpenbotKnowledgeId, OpenbotProject } from "@t3tools/contracts";
import { Button } from "@t3tools/ui/button";
import { cn } from "@t3tools/ui/cn";
import { Input } from "@t3tools/ui/input";
import { ArrowLeft, BookOpen } from "lucide-react";
import { useEffect, useState } from "react";
import { commandErrorText } from "../state/errors";
import {
  getProject,
  updateProject,
  useAtomCommand,
  useKnowledge,
  useProjects,
} from "../state/channels";

const SETTINGS_TABS = ["knowledge", "instructions"] as const;
const TAB_LABEL: Record<(typeof SETTINGS_TABS)[number], string> = {
  knowledge: "Knowledge",
  instructions: "Instructions",
};

/** Local draft of the fields this page can save, so unsaved edits survive a stray re-render. */
interface InstructionsDraft {
  readonly name: string;
  readonly instructions: string;
  readonly revision: OpenbotProject["revision"];
}

function draftFromProject(project: OpenbotProject): InstructionsDraft {
  return { name: project.name, instructions: project.instructions, revision: project.revision };
}

/** Full-page project settings: knowledge links and standing instructions. Replaces the main area. */
export function ProjectSettingsPage(props: {
  readonly environmentId: EnvironmentId;
  readonly project: OpenbotProject;
  readonly tab: "knowledge" | "instructions";
  readonly onTabChange: (tab: "knowledge" | "instructions") => void;
  readonly onBack: () => void;
  readonly onOpenKnowledge: (knowledgeId: OpenbotKnowledgeId) => void;
  readonly onNewKnowledge: () => void;
}) {
  const { environmentId, project, tab, onTabChange, onBack, onOpenKnowledge, onNewKnowledge } =
    props;
  return (
    <div className="flex h-full min-h-0 flex-1 flex-col overflow-auto">
      <div className="mx-auto w-full max-w-3xl px-6 py-6">
        <Button variant="ghost" size="xs" className="mb-5" onClick={onBack}>
          <ArrowLeft />
          Back to chat
        </Button>
        <h2 className="text-lg font-medium">{project.name} settings</h2>
        <div className="mt-5 mb-6 flex gap-5 border-b border-border" role="tablist">
          {SETTINGS_TABS.map((section) => (
            <button
              key={section}
              type="button"
              role="tab"
              aria-selected={tab === section}
              onClick={() => onTabChange(section)}
              className={cn(
                "border-b-2 pb-3 text-sm",
                tab === section
                  ? "border-primary text-foreground"
                  : "border-transparent text-muted-foreground",
              )}
            >
              {TAB_LABEL[section]}
            </button>
          ))}
        </div>
        {tab === "knowledge" ? (
          <KnowledgeTab
            environmentId={environmentId}
            project={project}
            onOpenKnowledge={onOpenKnowledge}
            onNewKnowledge={onNewKnowledge}
          />
        ) : (
          <InstructionsTab environmentId={environmentId} project={project} />
        )}
      </div>
    </div>
  );
}

function KnowledgeTab({
  environmentId,
  project,
  onOpenKnowledge,
  onNewKnowledge,
}: {
  readonly environmentId: EnvironmentId;
  readonly project: OpenbotProject;
  readonly onOpenKnowledge: (knowledgeId: OpenbotKnowledgeId) => void;
  readonly onNewKnowledge: () => void;
}) {
  const entries = useKnowledge(environmentId, project.id);
  const projects = useProjects(environmentId);
  return (
    <div>
      <div className="mb-6 flex items-start justify-between gap-3">
        <p className="text-sm leading-6 text-muted-foreground">
          Facts and decisions saved from conversations in this project. An entry can be relevant to
          more than one project.
        </p>
        <Button size="sm" onClick={onNewKnowledge} className="shrink-0">
          New entry
        </Button>
      </div>
      {entries.length === 0 ? (
        <p className="text-sm text-muted-foreground">Nothing saved for this project yet.</p>
      ) : (
        <div className="flex flex-col">
          {entries.map((entry) => (
            <button
              key={entry.id}
              type="button"
              onClick={() => onOpenKnowledge(entry.id)}
              className="block w-full border-b border-border py-4 text-left hover:bg-accent/50"
            >
              <div className="flex items-center gap-2 text-sm">
                <BookOpen className="size-4 shrink-0 text-muted-foreground" />
                <span className="font-medium">{entry.title}</span>
              </div>
              <p className="mt-2 line-clamp-2 text-xs leading-5 text-muted-foreground">
                {entry.body}
              </p>
              <div className="mt-3 flex flex-wrap gap-1">
                {entry.projectIds.map((projectId) => {
                  const linked = projects.find((candidate) => candidate.id === projectId);
                  return (
                    <span
                      key={projectId}
                      className="rounded border border-border px-1.5 py-0.5 text-[10px] text-muted-foreground"
                    >
                      {linked?.name ?? projectId}
                    </span>
                  );
                })}
              </div>
              <div className="mt-2 text-[10px] text-muted-foreground">
                Updated{" "}
                {new Date(entry.updatedAt).toLocaleString(undefined, {
                  month: "short",
                  day: "numeric",
                  hour: "numeric",
                  minute: "2-digit",
                })}
              </div>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function InstructionsTab({
  environmentId,
  project,
}: {
  readonly environmentId: EnvironmentId;
  readonly project: OpenbotProject;
}) {
  const [draft, setDraft] = useState<InstructionsDraft>(() => draftFromProject(project));
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const save = useAtomCommand(updateProject, { reportFailure: false });
  const read = useAtomCommand(getProject, { reportFailure: false });

  // Reseed from the live projection when it moves and the user has no unsaved edits, so a
  // concurrent edit elsewhere (or our own save) is reflected without ever discarding a draft.
  useEffect(() => {
    if (!dirty) setDraft(draftFromProject(project));
  }, [project, dirty]);

  const loadLatest = async () => {
    setBusy(true);
    const result = await read({ environmentId, input: { projectId: project.id } });
    setBusy(false);
    if (result._tag === "Success") {
      setDraft(draftFromProject(result.value));
      setDirty(false);
      setError(null);
    } else {
      setError(commandErrorText(result));
    }
  };

  const onSave = async () => {
    setBusy(true);
    setError(null);
    setSaved(false);
    const result = await save({
      environmentId,
      input: {
        projectId: project.id,
        expectedRevision: draft.revision,
        name: draft.name,
        instructions: draft.instructions,
      },
    });
    setBusy(false);
    if (result._tag === "Success") {
      setDraft(draftFromProject(result.value));
      setDirty(false);
      setSaved(true);
    } else {
      setError(commandErrorText(result));
    }
  };

  return (
    <div className="space-y-6">
      <label className="flex flex-col gap-1 text-sm">
        Name
        <Input
          value={draft.name}
          maxLength={80}
          disabled={busy}
          onChange={(event) => {
            setDraft((current) => ({ ...current, name: event.target.value }));
            setDirty(true);
            setSaved(false);
          }}
        />
      </label>
      <label className="flex flex-col gap-1 text-sm">
        Instructions
        <textarea
          className="min-h-36 rounded-md border border-border bg-background p-3 text-sm leading-6 outline-none focus:ring-1 focus:ring-ring"
          value={draft.instructions}
          maxLength={16_000}
          disabled={busy}
          placeholder="Used when the assistant replies in this project's chat and threads."
          onChange={(event) => {
            setDraft((current) => ({ ...current, instructions: event.target.value }));
            setDirty(true);
            setSaved(false);
          }}
        />
      </label>
      {error !== null && (
        <div role="alert" className="space-y-2 text-sm text-error-foreground">
          <p>{error} Your draft is still here.</p>
          <Button variant="ghost" size="sm" disabled={busy} onClick={() => void loadLatest()}>
            Load latest
          </Button>
        </div>
      )}
      <div className="flex items-center gap-3">
        <Button disabled={busy || draft.name.trim() === ""} onClick={() => void onSave()}>
          {busy ? "Saving…" : "Save"}
        </Button>
        {saved && !dirty && <span className="text-xs text-muted-foreground">Saved</span>}
      </div>
      <div className="border-t border-border pt-5">
        <h3 className="text-sm font-medium">Working directory</h3>
        <p className="mt-1 text-xs leading-5 text-muted-foreground">
          {project.workspace.kind === "managed" ? "App-managed" : "Attached folder"}. This is where
          this project's agents read and write files.
        </p>
        <p className="mt-2 font-mono text-xs text-muted-foreground">{project.workspace.path}</p>
      </div>
    </div>
  );
}

import type { EnvironmentId, OpenbotKnowledgeId, OpenbotProject } from "@t3tools/contracts";
import { Button } from "@t3tools/ui/button";
import { cn } from "@t3tools/ui/cn";
import { Input } from "@t3tools/ui/input";
import { Spinner } from "@t3tools/ui/spinner";
import { ArrowLeft, BookOpen } from "lucide-react";
import { useEffect, useId, useState } from "react";
import { commandErrorText } from "../state/errors";
import {
  getProject,
  updateProject,
  useAtomCommand,
  useKnowledge,
  useProjects,
} from "../state/channels";

const SETTINGS_TABS = ["knowledge", "instructions"] as const;
type SettingsTab = (typeof SETTINGS_TABS)[number];
const TAB_LABEL: Record<SettingsTab, string> = {
  knowledge: "Knowledge",
  instructions: "Instructions",
};

/** Full-page project settings: knowledge links and standing instructions. Replaces the main area. */
export function ProjectSettingsPage(props: {
  readonly environmentId: EnvironmentId;
  readonly project: OpenbotProject;
  readonly tab: SettingsTab;
  readonly onTabChange: (tab: SettingsTab) => void;
  readonly onBack: () => void;
  readonly onOpenKnowledge: (knowledgeId: OpenbotKnowledgeId) => void;
  readonly onNewKnowledge: () => void;
  /** Reports whether leaving this page would discard an edit. */
  readonly onUnsavedChange: (unsaved: boolean) => void;
}) {
  const {
    environmentId,
    project,
    tab,
    onTabChange,
    onBack,
    onOpenKnowledge,
    onNewKnowledge,
    onUnsavedChange,
  } = props;
  const panelId = useId();
  return (
    <div className="flex h-full min-h-0 flex-1 flex-col overflow-auto">
      <div className="mx-auto w-full max-w-3xl px-6 py-6">
        <Button variant="ghost" size="xs" className="mb-5" onClick={onBack}>
          <ArrowLeft />
          Back to chat
        </Button>
        <h2 className="font-medium text-lg">{project.name} settings</h2>
        <div className="mt-5 mb-6 flex gap-5 border-border border-b" role="tablist">
          {SETTINGS_TABS.map((section) => (
            <button
              key={section}
              type="button"
              role="tab"
              id={`${panelId}-${section}`}
              aria-controls={panelId}
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
        <div role="tabpanel" id={panelId} aria-labelledby={`${panelId}-${tab}`}>
          {tab === "knowledge" ? (
            <KnowledgeTab
              environmentId={environmentId}
              project={project}
              onOpenKnowledge={onOpenKnowledge}
              onNewKnowledge={onNewKnowledge}
            />
          ) : (
            <InstructionsTab
              environmentId={environmentId}
              project={project}
              onUnsavedChange={onUnsavedChange}
            />
          )}
        </div>
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
  const knowledge = useKnowledge(environmentId, project.id);
  const projects = useProjects(environmentId);
  return (
    <div>
      <div className="mb-6 flex items-start justify-between gap-3">
        <p className="text-muted-foreground text-sm leading-6">
          Facts and decisions saved from conversations in this project. An entry can be relevant to
          more than one project.
        </p>
        <Button size="sm" onClick={onNewKnowledge} className="shrink-0">
          New entry
        </Button>
      </div>
      {knowledge.error !== null ? (
        <p role="alert" className="text-error-foreground text-sm">
          {knowledge.error}
        </p>
      ) : knowledge.loading ? (
        <div className="flex justify-center py-8">
          <Spinner className="size-4 text-muted-foreground" />
        </div>
      ) : knowledge.items.length === 0 ? (
        <p className="text-muted-foreground text-sm">Nothing saved for this project yet.</p>
      ) : (
        <div className="flex flex-col">
          {knowledge.items.map((entry) => {
            // The current project is implied by the list it is in; only the
            // other projects an entry serves are worth naming here.
            const alsoIn = entry.projectIds.filter((projectId) => projectId !== project.id);
            return (
              <button
                key={entry.id}
                type="button"
                onClick={() => onOpenKnowledge(entry.id)}
                className="block w-full border-border border-b py-4 text-left hover:bg-accent/50"
              >
                <span className="flex items-center gap-2 text-sm">
                  <BookOpen className="size-4 shrink-0 text-muted-foreground" />
                  <span className="truncate font-medium">{entry.title}</span>
                </span>
                <span className="mt-2 line-clamp-2 block text-muted-foreground text-xs leading-5">
                  {entry.body}
                </span>
                <span className="mt-2 flex flex-wrap items-center gap-2 text-[10px] text-muted-foreground">
                  <span>
                    Updated{" "}
                    {new Date(entry.updatedAt).toLocaleString(undefined, {
                      month: "short",
                      day: "numeric",
                      hour: "numeric",
                      minute: "2-digit",
                    })}
                  </span>
                  {alsoIn.length > 0 && (
                    <span>
                      Also in{" "}
                      {alsoIn
                        .map(
                          (projectId) =>
                            projects.find((candidate) => candidate.id === projectId)?.name ??
                            projectId,
                        )
                        .join(", ")}
                    </span>
                  )}
                </span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

/** The fields this tab can save. */
interface InstructionsDraft {
  readonly name: string;
  readonly instructions: string;
}

function InstructionsTab({
  environmentId,
  project,
  onUnsavedChange,
}: {
  readonly environmentId: EnvironmentId;
  readonly project: OpenbotProject;
  readonly onUnsavedChange: (unsaved: boolean) => void;
}) {
  // The result of our own last save wins until the projection catches up, so a
  // second save cannot send the pre-save revision and lose to itself.
  const [fetched, setFetched] = useState<OpenbotProject | null>(null);
  const latest = fetched !== null && fetched.revision > project.revision ? fetched : project;
  // Only set while the user has typed something; otherwise the live projection
  // is what the fields show, so an edit from another device lands immediately.
  const [draft, setDraft] = useState<InstructionsDraft | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const save = useAtomCommand(updateProject, { reportFailure: false });
  const read = useAtomCommand(getProject, { reportFailure: false });

  const dirty =
    draft !== null && (draft.name !== latest.name || draft.instructions !== latest.instructions);
  // A draft that matches the saved values is not an edit, so the live
  // projection takes over again and a change from another device is visible.
  const values: InstructionsDraft = dirty
    ? draft
    : { name: latest.name, instructions: latest.instructions };

  useEffect(() => {
    onUnsavedChange(dirty);
    return () => onUnsavedChange(false);
  }, [dirty, onUnsavedChange]);

  const edit = (change: Partial<InstructionsDraft>) => {
    setDraft((current) => ({ ...(current ?? values), ...change }));
    setSaved(false);
  };

  const loadLatest = async () => {
    setBusy(true);
    const result = await read({ environmentId, input: { projectId: project.id } });
    setBusy(false);
    if (result._tag !== "Success") {
      setError(commandErrorText(result));
      return;
    }
    setFetched(result.value);
    setDraft(null);
    setError(null);
  };

  const onSave = async () => {
    setBusy(true);
    setError(null);
    setSaved(false);
    const result = await save({
      environmentId,
      input: {
        projectId: project.id,
        expectedRevision: latest.revision,
        name: values.name.trim(),
        instructions: values.instructions,
      },
    });
    setBusy(false);
    if (result._tag !== "Success") {
      setError(commandErrorText(result));
      return;
    }
    setFetched(result.value);
    setDraft(null);
    setSaved(true);
  };

  return (
    <div className="space-y-6">
      <label className="flex flex-col gap-1 text-sm">
        Name
        <Input
          value={values.name}
          maxLength={80}
          onChange={(event) => edit({ name: event.target.value })}
        />
      </label>
      <label className="flex flex-col gap-1 text-sm">
        Instructions
        <textarea
          className="min-h-36 rounded-md border border-border bg-background p-3 text-sm leading-6 outline-none focus:ring-1 focus:ring-ring"
          value={values.instructions}
          maxLength={16_000}
          placeholder="Used when the assistant replies in this project's chat and threads."
          onChange={(event) => edit({ instructions: event.target.value })}
        />
      </label>
      {error !== null && (
        <div role="alert" className="space-y-2 text-error-foreground text-sm">
          <p>{error} Your edit is still here.</p>
          <Button variant="outline" size="sm" disabled={busy} onClick={() => void loadLatest()}>
            Load latest
          </Button>
        </div>
      )}
      <div className="flex items-center gap-3">
        <Button
          disabled={busy || !dirty || values.name.trim() === ""}
          onClick={() => void onSave()}
        >
          {busy ? "Saving…" : "Save"}
        </Button>
        {saved && !dirty && <span className="text-muted-foreground text-xs">Saved</span>}
      </div>
      <div className="border-border border-t pt-5">
        <h3 className="font-medium text-sm">Working directory</h3>
        <p className="mt-1 text-muted-foreground text-xs leading-5">
          {project.workspace.kind === "managed" ? "App-managed" : "Attached folder"}. This is where
          this project's agents read and write files.
        </p>
        <p className="mt-2 font-mono text-muted-foreground text-xs">{project.workspace.path}</p>
      </div>
    </div>
  );
}

import { ProjectFolderPicker } from "../../../web/src/components/CommandPalette";
import { usePrimaryEnvironmentId } from "../state/channels";
import {
  DEFAULT_OPENBOT_PROJECT_ICON,
  type OpenbotProjectCreateInput,
  type OpenbotProjectIcon,
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
import { lazy, Suspense, useState } from "react";

import { type CommandAttempt, commandAttempt } from "../state/ids";
import { ProjectIcon } from "./ProjectIcon";

const ProjectIconPicker = lazy(() => import("./ProjectIconPicker"));

/**
 * A project needs nothing but a name: without an attached folder the server
 * creates an app-managed working directory, so no file picker is required to
 * get started.
 */
export function NewProjectDialog({
  open,
  onOpenChange,
  onCreate,
  busy,
  error,
}: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly onCreate: (input: OpenbotProjectCreateInput) => void;
  readonly busy: boolean;
  readonly error: string | null;
}) {
  const environmentId = usePrimaryEnvironmentId();
  const [folderPickerOpen, setFolderPickerOpen] = useState(false);
  const [name, setName] = useState("");
  const [attachedPath, setAttachedPath] = useState("");
  const [icon, setIcon] = useState<OpenbotProjectIcon>(DEFAULT_OPENBOT_PROJECT_ICON);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [attempt, setAttempt] = useState<CommandAttempt<{
    readonly name: string;
    readonly attachedPath: string;
  }> | null>(null);
  const trimmedName = name.trim();
  const trimmedPath = attachedPath.trim();
  return (
    <>
      <Dialog
        open={open}
        onOpenChange={(next) => {
          if (!busy) onOpenChange(next);
        }}
      >
        <DialogPopup className="max-w-md" bottomStickOnMobile={false}>
          <form
            className="flex min-h-0 flex-col overflow-hidden"
            onSubmit={(event) => {
              event.preventDefault();
              if (trimmedName === "" || busy) return;
              // The icon is not part of the key: the server compares the name
              // and the folder decision when a create replays.
              const next = commandAttempt(attempt, "project-create", {
                name: trimmedName,
                attachedPath: trimmedPath,
              });
              setAttempt(next);
              onCreate({
                name: trimmedName,
                icon,
                commandId: next.commandId,
                ...(trimmedPath === "" ? {} : { attachedPath: trimmedPath }),
              });
            }}
          >
            <DialogHeader>
              <DialogTitle>New project</DialogTitle>
              <DialogDescription>
                A project has its own main chat, instructions and knowledge.
              </DialogDescription>
            </DialogHeader>
            <DialogPanel className="space-y-4">
              <div className="flex items-end gap-3">
                <Button
                  type="button"
                  variant="outline"
                  size="icon-lg"
                  disabled={busy}
                  aria-label="Choose the project icon"
                  onClick={() => setPickerOpen(true)}
                >
                  <ProjectIcon icon={icon} size={20} />
                </Button>
                <label className="flex min-w-0 flex-1 flex-col gap-1 text-sm">
                  Name
                  <Input
                    autoFocus
                    autoComplete="off"
                    maxLength={80}
                    value={name}
                    disabled={busy}
                    onChange={(event) => setName(event.target.value)}
                  />
                </label>
              </div>
              <div className="flex flex-col gap-2 text-sm">
                <span>Attach a folder</span>
                <Button
                  type="button"
                  variant="outline"
                  className="justify-start truncate"
                  disabled={busy || environmentId === null}
                  onClick={() => setFolderPickerOpen(true)}
                >
                  {attachedPath || "Choose a folder…"}
                </Button>
                {attachedPath && (
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="self-start"
                    disabled={busy}
                    onClick={() => setAttachedPath("")}
                  >
                    Remove folder
                  </Button>
                )}
                <span className="text-muted-foreground text-xs">
                  Optional. Without a folder, OpenBot creates a working directory for this project.
                </span>
              </div>
              {error !== null && (
                <p role="alert" className="text-error-foreground text-sm">
                  {error}
                </p>
              )}
            </DialogPanel>
            <DialogFooter variant="bare">
              <Button
                type="button"
                variant="ghost"
                disabled={busy}
                onClick={() => onOpenChange(false)}
              >
                Cancel
              </Button>
              <Button type="submit" disabled={trimmedName === "" || busy}>
                {busy ? "Creating…" : "Create project"}
              </Button>
            </DialogFooter>
          </form>
        </DialogPopup>
      </Dialog>
      {folderPickerOpen && environmentId !== null && (
        <ProjectFolderPicker
          environmentId={environmentId}
          open
          onOpenChange={setFolderPickerOpen}
          onSelect={setAttachedPath}
        />
      )}
      {pickerOpen && (
        <Suspense fallback={null}>
          <ProjectIconPicker
            projectName={trimmedName === "" ? "New project" : trimmedName}
            value={icon}
            busy={false}
            error={null}
            onSelect={setIcon}
            onClose={() => setPickerOpen(false)}
          />
        </Suspense>
      )}
    </>
  );
}

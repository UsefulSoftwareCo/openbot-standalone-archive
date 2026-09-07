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
import { useState } from "react";

import { type CommandAttempt, commandAttempt } from "../state/ids";

/**
 * Starts a focused child chat and dispatches its first work request in one
 * step. The request id is keyed to the text, so a retry after a dropped socket
 * returns the same child instead of starting a second one, while an edited
 * task still gets through: the server rejects a replay carrying new text.
 */
export function NewThreadDialog({
  open,
  onOpenChange,
  parentName,
  onStart,
  busy,
  error,
}: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly parentName: string;
  readonly onStart: (input: {
    readonly title: string;
    readonly task: string;
    readonly clientRequestId: string;
  }) => void;
  readonly busy: boolean;
  readonly error: string | null;
}) {
  const [title, setTitle] = useState("");
  const [task, setTask] = useState("");
  const [attempt, setAttempt] = useState<CommandAttempt<{
    readonly title: string;
    readonly task: string;
  }> | null>(null);
  const ready = title.trim() !== "" && task.trim() !== "";
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!busy) onOpenChange(next);
      }}
    >
      <DialogPopup className="max-w-lg" bottomStickOnMobile={false}>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            if (!ready || busy) return;
            const next = commandAttempt(attempt, "thread-start", {
              title: title.trim(),
              task: task.trim(),
            });
            setAttempt(next);
            onStart({ ...next.payload, clientRequestId: next.commandId });
          }}
        >
          <DialogHeader>
            <DialogTitle>New thread</DialogTitle>
            <DialogDescription>
              A focused chat under {parentName}. Its result comes back here.
            </DialogDescription>
          </DialogHeader>
          <DialogPanel className="max-h-[65dvh] space-y-4 overflow-y-auto">
            <label className="flex flex-col gap-1 text-sm">
              Title
              <Input
                autoFocus
                autoComplete="off"
                maxLength={80}
                value={title}
                disabled={busy}
                onChange={(event) => setTitle(event.target.value)}
              />
            </label>
            <label className="flex flex-col gap-1 text-sm">
              First message
              <textarea
                className="min-h-40 resize-y rounded-md border border-border bg-background p-3 text-sm"
                maxLength={32000}
                placeholder="What should this thread work on?"
                value={task}
                disabled={busy}
                onChange={(event) => setTask(event.target.value)}
              />
            </label>
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
            <Button type="submit" disabled={!ready || busy}>
              {busy ? "Starting…" : "Start thread"}
            </Button>
          </DialogFooter>
        </form>
      </DialogPopup>
    </Dialog>
  );
}

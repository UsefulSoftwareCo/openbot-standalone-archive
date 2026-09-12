import type { OpenbotChannel, OpenbotProject } from "@t3tools/contracts";
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

/** A snapshot of the object the person chose to remove. */
export type DeleteTarget =
  | { readonly type: "channel"; readonly channel: OpenbotChannel }
  | { readonly type: "project"; readonly project: OpenbotProject };

/** Name the deletion scope before the destructive command is sent. */
export function DeleteDialog({
  target,
  childCount,
  busy,
  error,
  onCancel,
  onConfirm,
}: {
  readonly target: DeleteTarget;
  readonly childCount: number;
  readonly busy: boolean;
  readonly error: string | null;
  readonly onCancel: () => void;
  readonly onConfirm: () => void;
}) {
  const name = target.type === "project" ? target.project.name : target.channel.name;
  const kind =
    target.type === "project"
      ? "project"
      : target.channel.parentChannelId === null
        ? "chat"
        : "thread";
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !busy) onCancel();
      }}
    >
      <DialogPopup className="max-w-sm" bottomStickOnMobile={false}>
        <DialogHeader>
          <DialogTitle>Delete “{name}”?</DialogTitle>
          <DialogDescription>
            {target.type === "project"
              ? `This removes the project and its ${childCount} ${childCount === 1 ? "conversation" : "conversations"}. Unshared knowledge owned by the project is removed too.`
              : childCount > 0
                ? `This removes the chat and its ${childCount} ${childCount === 1 ? "thread" : "threads"}.`
                : `This removes the ${kind} and its conversation.`}
          </DialogDescription>
        </DialogHeader>
        <DialogPanel className="space-y-3 text-sm text-muted-foreground">
          <p>Active work will stop. Workspace files will stay. This cannot be undone in OpenBot.</p>
          {error !== null && (
            <p role="alert" className="text-error-foreground">
              {error}
            </p>
          )}
        </DialogPanel>
        <DialogFooter>
          <Button variant="ghost" disabled={busy} onClick={onCancel}>
            Cancel
          </Button>
          <Button variant="destructive" disabled={busy} onClick={onConfirm}>
            {busy ? "Deleting…" : `Delete ${kind}`}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

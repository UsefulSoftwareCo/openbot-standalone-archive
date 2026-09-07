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

export function NewChannelDialog({
  open,
  onOpenChange,
  onCreate,
  busy,
  error,
}: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly onCreate: (name: string) => void;
  readonly busy: boolean;
  readonly error: string | null;
}) {
  const [name, setName] = useState("");
  const trimmed = name.trim();
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) setName("");
        onOpenChange(next);
      }}
    >
      <DialogPopup className="max-w-sm" bottomStickOnMobile={false}>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            if (trimmed.length === 0 || busy) return;
            onCreate(trimmed);
          }}
        >
          <DialogHeader>
            <DialogTitle>New channel</DialogTitle>
            <DialogDescription>A place for an ongoing conversation with OpenBot.</DialogDescription>
          </DialogHeader>
          <DialogPanel className="flex flex-col gap-2">
            <label className="font-medium text-sm" htmlFor="openbot-channel-name">
              Name
            </label>
            <Input
              id="openbot-channel-name"
              autoComplete="off"
              data-1p-ignore
              autoFocus
              placeholder="e.g. Work or Life"
              value={name}
              onChange={(event) => setName(event.target.value)}
              maxLength={80}
            />
            {error !== null && <p className="text-error-foreground text-sm">{error}</p>}
          </DialogPanel>
          <DialogFooter variant="bare">
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={trimmed.length === 0 || busy}>
              Create channel
            </Button>
          </DialogFooter>
        </form>
      </DialogPopup>
    </Dialog>
  );
}

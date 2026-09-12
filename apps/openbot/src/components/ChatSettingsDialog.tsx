import type { EnvironmentId, OpenbotChannel } from "@t3tools/contracts";
import { Button } from "@t3tools/ui/button";
import {
  Dialog,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "@t3tools/ui/dialog";
import { useState } from "react";

import { commandErrorText } from "../state/errors";
import { updateChannel, useAtomCommand } from "../state/channels";
import { ChatProfileFields, type ChatProfileDraft } from "./ChatProfileFields";
import { ThreadContextDialog } from "./ThreadContextDialog";

/**
 * Name, avatar and next-message model for one chat. Standing instructions and
 * agent-owned knowledge live behind their own dialog so a background memory
 * update is never clobbered by a profile save.
 */
export function ChatSettingsDialog({
  environmentId,
  channel,
  open,
  onOpenChange,
}: {
  readonly environmentId: EnvironmentId;
  readonly channel: OpenbotChannel;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
}) {
  const [draft, setDraft] = useState<ChatProfileDraft>(channel);
  const [revision, setRevision] = useState(channel.revision);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const save = useAtomCommand(updateChannel, { reportFailure: false });
  const load = () => {
    setDraft(channel);
    setRevision(channel.revision);
    setError(null);
  };
  const incomplete =
    draft.name.trim() === "" ||
    draft.modelSelection === undefined ||
    draft.modelSelection.model.trim() === "";
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (busy) return;
        if (next) load();
        onOpenChange(next);
      }}
    >
      <DialogPopup className="max-w-md" bottomStickOnMobile={false}>
        <form
          onSubmit={async (event) => {
            event.preventDefault();
            if (busy || incomplete || draft.modelSelection === undefined) return;
            setBusy(true);
            setError(null);
            const result = await save({
              environmentId,
              input: {
                channelId: channel.id,
                expectedRevision: revision,
                name: draft.name.trim(),
                avatar: draft.avatar,
                description: draft.description,
                modelSelection: draft.modelSelection,
              },
            });
            setBusy(false);
            if (result._tag === "Success") onOpenChange(false);
            else setError(commandErrorText(result));
          }}
        >
          <DialogHeader>
            <DialogTitle>Chat settings</DialogTitle>
          </DialogHeader>
          <DialogPanel className="max-h-[65dvh] space-y-4 overflow-y-auto">
            <ChatProfileFields
              environmentId={environmentId}
              value={draft}
              onChange={setDraft}
              disabled={busy}
              allowAutomatic={false}
            />
            <p className="text-muted-foreground text-xs">
              Model changes apply to your next message. Existing routines keep their selected model.
            </p>
            <ThreadContextDialog environmentId={environmentId} channel={channel} />
            {error !== null && (
              <p role="alert" className="text-error-foreground text-sm">
                {error} Your draft is still here.
              </p>
            )}
          </DialogPanel>
          <DialogFooter>
            <Button type="button" variant="ghost" disabled={busy} onClick={load}>
              Load latest
            </Button>
            <Button type="submit" disabled={busy || incomplete}>
              {busy ? "Saving…" : "Save"}
            </Button>
          </DialogFooter>
        </form>
      </DialogPopup>
    </Dialog>
  );
}

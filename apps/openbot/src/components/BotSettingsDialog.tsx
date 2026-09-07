import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
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
import { updateBotProfile, useAtomCommand } from "../state/channels";
import { BotProfileFields, type BotProfileDraft } from "./BotProfileFields";
import { ThreadContextDialog } from "./ThreadContextDialog";

/** Edit profile separately from agent-owned knowledge so background memory updates cannot be overwritten. */
export function BotSettingsDialog({
  environmentId,
  channel,
}: {
  readonly environmentId: EnvironmentId;
  readonly channel: OpenbotChannel;
}) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<BotProfileDraft>(channel);
  const [revision, setRevision] = useState(channel.revision);
  const [avatarBusy, setAvatarBusy] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const save = useAtomCommand(updateBotProfile, { reportFailure: false });
  const load = () => {
    setDraft(channel);
    setRevision(channel.revision);
    setError(null);
  };
  return (
    <>
      <Button
        variant="ghost"
        size="sm"
        onClick={() => {
          load();
          setOpen(true);
        }}
      >
        Bot settings
      </Button>
      <Dialog
        open={open}
        onOpenChange={(next) => {
          if (!busy && !avatarBusy) setOpen(next);
        }}
      >
        <DialogPopup className="max-w-md" bottomStickOnMobile={false}>
          <form
            onSubmit={async (event) => {
              event.preventDefault();
              if (
                busy ||
                avatarBusy ||
                draft.modelSelection === undefined ||
                draft.modelSelection.model.trim() === "" ||
                draft.name.trim() === ""
              )
                return;
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
              if (result._tag === "Success") setOpen(false);
              else {
                const failure = squashAtomCommandFailure(result);
                setError(
                  failure instanceof Error ? failure.message : "Could not save bot settings.",
                );
              }
            }}
          >
            <DialogHeader>
              <DialogTitle>Bot settings</DialogTitle>
            </DialogHeader>
            <DialogPanel className="max-h-[65dvh] space-y-4 overflow-y-auto">
              <BotProfileFields
                environmentId={environmentId}
                value={draft}
                onChange={setDraft}
                disabled={busy || avatarBusy}
                allowAutomatic={false}
                onBusyChange={setAvatarBusy}
              />
              <p className="text-xs text-muted-foreground">
                Model changes apply to your next message. Existing routines keep their selected
                model.
              </p>
              <ThreadContextDialog environmentId={environmentId} channel={channel} />
              {error !== null && (
                <p role="alert" className="text-sm text-error-foreground">
                  {error} Your draft is still here.
                </p>
              )}
            </DialogPanel>
            <DialogFooter>
              <Button type="button" variant="ghost" disabled={busy || avatarBusy} onClick={load}>
                Load latest
              </Button>
              <Button
                type="submit"
                disabled={
                  busy ||
                  avatarBusy ||
                  draft.name.trim() === "" ||
                  draft.modelSelection === undefined ||
                  draft.modelSelection.model.trim() === ""
                }
              >
                {busy ? "Saving…" : "Save"}
              </Button>
            </DialogFooter>
          </form>
        </DialogPopup>
      </Dialog>
    </>
  );
}

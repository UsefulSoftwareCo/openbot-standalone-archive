import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId, OpenbotChannel, OpenbotThreadContext } from "@t3tools/contracts";
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
import { useState } from "react";
import { getThreadContext, updateThreadContext, useAtomCommand } from "../state/channels";

function contextError(result: Parameters<typeof squashAtomCommandFailure>[0]): string {
  const error = squashAtomCommandFailure(result);
  return error instanceof Error ? error.message : String(error);
}

export function ThreadContextDialog({
  environmentId,
  channel,
}: {
  readonly environmentId: EnvironmentId;
  readonly channel: OpenbotChannel;
}) {
  const [open, setOpen] = useState(false);
  const [context, setContext] = useState<OpenbotThreadContext | null>(null);
  const [instructions, setInstructions] = useState("");
  const [knowledge, setKnowledge] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const read = useAtomCommand(getThreadContext, { reportFailure: false });
  const save = useAtomCommand(updateThreadContext, { reportFailure: false });
  const load = async () => {
    setBusy(true);
    setError(null);
    const result = await read({ environmentId, input: { channelId: channel.id } });
    setBusy(false);
    if (result._tag === "Success") {
      setContext(result.value);
      setInstructions(result.value.instructions);
      setKnowledge(result.value.knowledge);
    } else {
      setError(contextError(result));
    }
  };
  return (
    <>
      <Button
        variant="ghost"
        size="sm"
        onClick={() => {
          setOpen(true);
          void load();
        }}
      >
        Instructions and knowledge
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogPopup className="max-w-2xl" bottomStickOnMobile={false}>
          <DialogHeader>
            <DialogTitle>{channel.name}</DialogTitle>
            <DialogDescription>
              Instructions guide every turn. Knowledge holds facts and decisions the thread can
              update as it works.
            </DialogDescription>
          </DialogHeader>
          <DialogPanel className="flex max-h-[65dvh] flex-col gap-3 overflow-y-auto">
            <label className="flex flex-col gap-1 text-sm">
              Standing instructions
              <textarea
                className="min-h-32 rounded-md border border-border bg-background p-3"
                value={instructions}
                maxLength={16000}
                disabled={busy || context === null}
                onChange={(event) => setInstructions(event.target.value)}
              />
            </label>
            <label className="flex flex-col gap-1 text-sm">
              Knowledge
              <textarea
                className="min-h-56 rounded-md border border-border bg-background p-3"
                value={knowledge}
                maxLength={32000}
                disabled={busy || context === null}
                onChange={(event) => setKnowledge(event.target.value)}
              />
            </label>
            {error !== null && (
              <p role="alert" className="text-sm text-error-foreground">
                {error} Your draft is still here. Copy it before loading the latest version.
              </p>
            )}
          </DialogPanel>
          <DialogFooter>
            <Button variant="ghost" disabled={busy} onClick={() => void load()}>
              Load latest
            </Button>
            <Button
              disabled={busy || context === null}
              onClick={async () => {
                if (context === null) return;
                setBusy(true);
                setError(null);
                const result = await save({
                  environmentId,
                  input: {
                    channelId: channel.id,
                    instructions,
                    knowledge,
                    expectedRevision: context.revision,
                  },
                });
                setBusy(false);
                if (result._tag === "Success") {
                  setContext(result.value);
                  setOpen(false);
                } else setError(contextError(result));
              }}
            >
              {busy ? "Working…" : "Save"}
            </Button>
          </DialogFooter>
        </DialogPopup>
      </Dialog>
    </>
  );
}

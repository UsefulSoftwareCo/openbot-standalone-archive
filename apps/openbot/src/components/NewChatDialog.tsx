import type { EnvironmentId, OpenbotChannelCreateInput } from "@t3tools/contracts";
import { CommandId } from "@t3tools/contracts";
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
import * as Effect from "effect/Effect";
import * as Random from "effect/Random";
import { useState } from "react";
import { ChatProfileFields, type ChatProfileDraft } from "./ChatProfileFields";

/** Create a chat with a stable command id for retries after a dropped connection. */
export function NewChatDialog({
  open,
  environmentId,
  onOpenChange,
  onCreate,
  busy,
  error,
}: {
  readonly open: boolean;
  readonly environmentId: EnvironmentId;
  readonly onOpenChange: (open: boolean) => void;
  readonly onCreate: (input: OpenbotChannelCreateInput) => void;
  readonly busy: boolean;
  readonly error: string | null;
}) {
  const [avatarBusy, setAvatarBusy] = useState(false);
  const [draft, setDraft] = useState<ChatProfileDraft>({
    name: "",
    avatar: "",
    description: "",
    modelSelection: undefined,
  });
  const [commandId] = useState(() =>
    CommandId.make(
      `command:openbot:create:${Effect.runSync(Effect.all([Random.nextInt, Random.nextInt, Random.nextInt, Random.nextInt])).join("-")}`,
    ),
  );
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!busy && !avatarBusy) onOpenChange(next);
      }}
    >
      <DialogPopup className="max-w-md" bottomStickOnMobile={false}>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            if (
              draft.name.trim() === "" ||
              busy ||
              avatarBusy ||
              draft.modelSelection?.model.trim() === ""
            )
              return;
            onCreate({ ...draft, name: draft.name.trim(), commandId });
          }}
        >
          <DialogHeader>
            <DialogTitle>New chat</DialogTitle>
            <DialogDescription>
              A standalone chat. Threads can branch off it later.
            </DialogDescription>
          </DialogHeader>
          <DialogPanel className="max-h-[65dvh] space-y-4 overflow-y-auto">
            <ChatProfileFields
              environmentId={environmentId}
              value={draft}
              onChange={setDraft}
              disabled={busy || avatarBusy}
              onBusyChange={setAvatarBusy}
            />
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
              disabled={busy || avatarBusy}
              onClick={() => onOpenChange(false)}
            >
              Cancel
            </Button>
            <Button
              type="submit"
              disabled={
                draft.name.trim() === "" ||
                busy ||
                avatarBusy ||
                draft.modelSelection?.model.trim() === ""
              }
            >
              Create chat
            </Button>
          </DialogFooter>
        </form>
      </DialogPopup>
    </Dialog>
  );
}

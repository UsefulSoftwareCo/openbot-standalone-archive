import type {
  EnvironmentId,
  ModelSelection,
  OpenbotChannelId,
  OpenbotProject,
  OpenbotProjectId,
} from "@t3tools/contracts";
import { Button } from "@t3tools/ui/button";
import { Menu } from "lucide-react";
import { type ComponentProps, useEffect, useRef, useState } from "react";

import { createChannel, sendChannelMessage, useAtomCommand } from "../state/channels";
import { commandErrorText } from "../state/errors";
import { type CommandAttempt, commandAttempt } from "../state/ids";
import { useServerProviders } from "../state/providers";
import { Composer } from "./Composer";
import { ModelPicker } from "./ModelPicker";
import { resolveDefaultProviderModelSelection } from "@t3tools/ui/provider-instances";
import { ComposerSelectControl } from "@t3tools/ui/composer-control";
import { Select, SelectItem, SelectPopup, SelectValue } from "@t3tools/ui/select";
import {
  chatTitleFromMessage,
  newChatAttemptPayload,
  newChatCreateInput,
  type NewChatDraft,
} from "./NewChatPage.logic";

/**
 * The draft page: a composer with no chat behind it yet. The first message
 * creates the chat and is then sent to it, so an abandoned draft leaves
 * nothing on the server. Project and model are fixed at creation, so both
 * controls lock once the chat exists; changing the chat's profile afterwards
 * is the settings dialog's job.
 */
export function NewChatPage({
  environmentId,
  projects,
  disabled,
  onOpenSidebar,
  onStart,
  onCreated,
}: {
  readonly environmentId: EnvironmentId;
  readonly projects: ReadonlyArray<OpenbotProject>;
  readonly disabled: boolean;
  readonly onOpenSidebar: () => void;
  /** Pins the draft route before creation updates the channel list. */
  readonly onStart: () => void;
  /** Called once the first message has landed, with the chat that now owns it. */
  readonly onCreated: (channelId: OpenbotChannelId) => void;
}) {
  const [projectId, setProjectId] = useState<OpenbotProjectId | null>(null);
  const [modelSelection, setModelSelection] = useState<ModelSelection | undefined>(undefined);
  const [channelId, setChannelId] = useState<OpenbotChannelId | null>(null);
  const [error, setError] = useState<string | null>(null);
  const attempt = useRef<CommandAttempt<Record<string, string>> | null>(null);
  // A send that completes after the user has moved on must not drag them back
  // here; the chat it made is already in the sidebar.
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const { items: providers, failed: providersFailed } = useServerProviders(environmentId);
  const effectiveModel =
    resolveDefaultProviderModelSelection(providers, modelSelection) ?? undefined;
  const create = useAtomCommand(createChannel, { reportFailure: false });
  const send = useAtomCommand(sendChannelMessage, { reportFailure: false });
  const project = projects.find((entry) => entry.id === projectId) ?? null;
  // Everything here describes the chat that does not exist yet.
  const locked = channelId !== null;

  /**
   * Creates the chat on the first message, then sends that message to it. A
   * failed send keeps the chat, so a retry sends again instead of creating a
   * second one; returning false leaves the draft and its files in the composer.
   */
  const sendFirstMessage: ComponentProps<typeof Composer>["onSend"] = async (message) => {
    onStart();
    setError(null);
    let target = channelId;
    if (target === null) {
      const draft: NewChatDraft = {
        name: chatTitleFromMessage(
          message.text,
          message.attachments.map((attachment) => attachment.name),
        ),
        parentChannelId: project?.mainChannelId ?? null,
        modelSelection: effectiveModel,
      };
      const next = commandAttempt(attempt.current, "chat-create", newChatAttemptPayload(draft));
      attempt.current = next;
      const created = await create({
        environmentId,
        input: newChatCreateInput(draft, next.commandId),
      });
      if (created._tag === "Failure") {
        setError(commandErrorText(created));
        return false;
      }
      target = created.value.id;
      setChannelId(target);
    }
    const sent = await send({
      environmentId,
      input: {
        channelId: target,
        text: message.text,
        attachments: message.attachments,
        messageId: message.messageId,
        commandId: message.commandId,
      },
    });
    if (sent._tag === "Failure") {
      setError(commandErrorText(sent));
      return false;
    }
    if (mounted.current) onCreated(target);
    return true;
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <header className="flex h-12 shrink-0 items-center px-2 pt-[env(safe-area-inset-top)] md:hidden">
        <Button
          variant="ghost"
          size="icon"
          className="shrink-0"
          aria-label="Open projects and chats"
          onClick={onOpenSidebar}
        >
          <Menu />
        </Button>
      </header>
      <div className="mx-auto flex min-h-0 w-full max-w-3xl flex-1 flex-col justify-center overflow-y-auto">
        <div className="mx-auto w-full max-w-3xl px-4 pb-5 text-center">
          <h1 className="font-medium text-xl tracking-tight">What are we working on?</h1>
        </div>
        <Composer
          channelName="OpenBot"
          environmentId={environmentId}
          disabled={disabled || effectiveModel === undefined}
          autoFocus
          controls={
            <div className="flex min-w-0 items-center gap-1">
              <Select
                value={projectId ?? ""}
                disabled={locked}
                items={[
                  { value: "", label: "No project" },
                  ...projects.map((entry) => ({ value: entry.id, label: entry.name })),
                ]}
                onValueChange={(id) =>
                  setProjectId(projects.find((entry) => entry.id === id)?.id ?? null)
                }
              >
                <ComposerSelectControl aria-label="Project" className="max-w-44">
                  <SelectValue />
                </ComposerSelectControl>
                <SelectPopup alignItemWithTrigger={false}>
                  <SelectItem value="">No project</SelectItem>
                  {projects.map((entry) => (
                    <SelectItem key={entry.id} value={entry.id}>
                      {entry.name}
                    </SelectItem>
                  ))}
                </SelectPopup>
              </Select>
              <ModelPicker
                providers={providers}
                selection={effectiveModel}
                disabled={locked}
                onChange={setModelSelection}
              />
              {providersFailed && <span role="alert">Could not load provider choices.</span>}
            </div>
          }
          onSend={sendFirstMessage}
        />
        {error !== null && (
          <p
            role="alert"
            className="mx-auto w-full max-w-3xl px-4 pb-1 text-error-foreground text-xs"
          >
            {error}
          </p>
        )}
      </div>
    </div>
  );
}

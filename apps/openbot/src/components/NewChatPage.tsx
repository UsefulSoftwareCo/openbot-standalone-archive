import type {
  EnvironmentId,
  ModelSelection,
  OpenbotChannelId,
  OpenbotProject,
  OpenbotProjectId,
} from "@t3tools/contracts";
import { Button } from "@t3tools/ui/button";
import { Menu } from "lucide-react";
import { type ComponentProps, useEffect, useId, useRef, useState } from "react";

import { createChannel, sendChannelMessage, useAtomCommand } from "../state/channels";
import { commandErrorText } from "../state/errors";
import { type CommandAttempt, commandAttempt } from "../state/ids";
import { providerModelSelection, useServerProviders } from "../state/providers";
import { Composer } from "./Composer";
import {
  chatTitleFromMessage,
  newChatAttemptPayload,
  newChatCreateInput,
  type NewChatDraft,
} from "./NewChatPage.logic";

const controlClass =
  "h-7 rounded-md border border-border bg-background px-1.5 text-foreground text-xs disabled:opacity-64";

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
  onCreated,
}: {
  readonly environmentId: EnvironmentId;
  readonly projects: ReadonlyArray<OpenbotProject>;
  readonly disabled: boolean;
  readonly onOpenSidebar: () => void;
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
  const modelListId = useId();
  const { items: providers, failed: providersFailed } = useServerProviders(environmentId);
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
    setError(null);
    let target = channelId;
    if (target === null) {
      const draft: NewChatDraft = {
        name: chatTitleFromMessage(
          message.text,
          message.attachments.map((attachment) => attachment.name),
        ),
        parentChannelId: project?.mainChannelId ?? null,
        modelSelection,
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
      <div className="flex min-h-0 flex-1 flex-col justify-center overflow-y-auto">
        <div className="mx-auto w-full max-w-3xl px-4 pb-5 text-center">
          <h1 className="font-medium text-xl tracking-tight">What are we working on?</h1>
          <p className="mt-1 text-muted-foreground text-sm">
            Send a message to start a chat. Pick a project to keep it with that work.
          </p>
        </div>
        <Composer
          channelName="OpenBot"
          environmentId={environmentId}
          disabled={disabled}
          autoFocus
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
        <div className="mx-auto flex w-full max-w-3xl flex-wrap items-center gap-2 px-4 pb-4 text-muted-foreground text-xs">
          <select
            aria-label="Project"
            className={controlClass}
            value={projectId ?? ""}
            disabled={locked}
            onChange={(event) =>
              setProjectId(projects.find((entry) => entry.id === event.target.value)?.id ?? null)
            }
          >
            <option value="">No project</option>
            {projects.map((entry) => (
              <option key={entry.id} value={entry.id}>
                {entry.name}
              </option>
            ))}
          </select>
          <select
            aria-label="Provider"
            className={controlClass}
            value={modelSelection?.instanceId ?? ""}
            disabled={locked}
            onChange={(event) =>
              setModelSelection(providerModelSelection(providers, event.target.value))
            }
          >
            <option value="">Automatic</option>
            {providers.map((provider) => (
              <option key={provider.instanceId} value={provider.instanceId}>
                {provider.displayName ?? provider.instanceId}
              </option>
            ))}
          </select>
          {modelSelection !== undefined && (
            <>
              <input
                aria-label="Model"
                list={modelListId}
                className={controlClass}
                value={modelSelection.model}
                disabled={locked}
                onChange={(event) =>
                  setModelSelection({ ...modelSelection, model: event.target.value })
                }
              />
              <datalist id={modelListId}>
                {providers
                  .find((provider) => provider.instanceId === modelSelection.instanceId)
                  ?.models.map((model) => (
                    <option key={model.slug} value={model.slug}>
                      {model.name}
                    </option>
                  ))}
              </datalist>
            </>
          )}
          {providersFailed && <span role="alert">Could not load provider choices.</span>}
        </div>
      </div>
    </div>
  );
}

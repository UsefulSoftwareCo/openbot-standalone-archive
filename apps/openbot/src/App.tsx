import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type { OpenbotChannelId } from "@t3tools/contracts";
import { Spinner } from "@t3tools/ui/spinner";
import { useEffect, useState } from "react";

import { ChannelSidebar } from "./components/ChannelSidebar";
import { ChannelView } from "./components/ChannelView";
import { Composer } from "./components/Composer";
import { NewChannelDialog } from "./components/NewChannelDialog";
import {
  createChannel,
  sendChannelMessage,
  useAtomCommand,
  useChannelView,
  useChannels,
  useConnectionPhase,
  usePrimaryEnvironmentId,
} from "./state/channels";

const SELECTED_CHANNEL_KEY = "openbot:selected-channel";

function readSelectedChannel(): OpenbotChannelId | null {
  const value = window.localStorage.getItem(SELECTED_CHANNEL_KEY);
  return value === null || value === "" ? null : (value as OpenbotChannelId);
}

function errorText(error: unknown): string {
  if (typeof error === "object" && error !== null && "message" in error) {
    return String((error as { message: unknown }).message);
  }
  return String(error);
}

export function App() {
  const environmentId = usePrimaryEnvironmentId();
  const phase = useConnectionPhase(environmentId);
  const channels = useChannels(environmentId);
  const [selectedChannelId, setSelectedChannelId] = useState<OpenbotChannelId | null>(
    readSelectedChannel,
  );
  const [dialogOpen, setDialogOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [sendError, setSendError] = useState<string | null>(null);

  const runCreate = useAtomCommand(createChannel, { reportFailure: false });
  const runSend = useAtomCommand(sendChannelMessage, { reportFailure: false });

  // Fall back to the first channel when the stored selection no longer exists.
  const activeChannelId =
    selectedChannelId !== null && channels.some((channel) => channel.id === selectedChannelId)
      ? selectedChannelId
      : (channels[0]?.id ?? null);
  useEffect(() => {
    if (activeChannelId !== null) {
      window.localStorage.setItem(SELECTED_CHANNEL_KEY, activeChannelId);
    }
  }, [activeChannelId]);

  const view = useChannelView(environmentId, activeChannelId);
  const activeChannel = channels.find((channel) => channel.id === activeChannelId) ?? null;

  const connectionLabel =
    environmentId === null
      ? "Looking for the T3 server…"
      : phase === "ready"
        ? "Connected"
        : phase === "synchronizing"
          ? "Connecting…"
          : "Disconnected";

  return (
    <div className="flex h-full w-full bg-background text-foreground">
      <ChannelSidebar
        channels={channels}
        selectedChannelId={activeChannelId}
        onSelect={(channelId) => {
          setSelectedChannelId(channelId);
          setSendError(null);
        }}
        onCreate={() => {
          setCreateError(null);
          setDialogOpen(true);
        }}
        connectionLabel={connectionLabel}
      />
      <main className="flex min-w-0 flex-1 flex-col">
        {environmentId === null ? (
          <div className="flex flex-1 flex-col items-center justify-center gap-3 text-muted-foreground text-sm">
            <Spinner className="size-5" />
            <p>Connecting to T3 Code…</p>
            <p className="max-w-sm text-center text-xs">
              If this does not resolve, pair this browser with the server first by opening the T3
              Code pairing link on this host.
            </p>
          </div>
        ) : view === null || activeChannel === null ? (
          <div className="flex flex-1 items-center justify-center text-muted-foreground text-sm">
            {channels.length === 0 ? "Create a channel to get started." : "Loading channel…"}
          </div>
        ) : (
          <>
            <ChannelView view={view} />
            {sendError !== null && (
              <p className="px-4 py-1 text-error-foreground text-xs">{sendError}</p>
            )}
            <Composer
              key={activeChannel.id}
              channelName={activeChannel.name}
              disabled={phase !== "ready"}
              onSend={async (text) => {
                setSendError(null);
                const result = await runSend({
                  environmentId,
                  input: {
                    channelId: activeChannel.id,
                    text,
                  },
                });
                if (result._tag === "Failure") {
                  setSendError(errorText(squashAtomCommandFailure(result)));
                  return false;
                }
                return true;
              }}
            />
          </>
        )}
      </main>
      <NewChannelDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        busy={creating}
        error={createError}
        onCreate={async (name) => {
          if (environmentId === null) return;
          setCreating(true);
          setCreateError(null);
          const result = await runCreate({ environmentId, input: { name } });
          setCreating(false);
          if (result._tag === "Failure") {
            setCreateError(errorText(squashAtomCommandFailure(result)));
            return;
          }
          setSelectedChannelId(result.value.id);
          setDialogOpen(false);
        }}
      />
    </div>
  );
}

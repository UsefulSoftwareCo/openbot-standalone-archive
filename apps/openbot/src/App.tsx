import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type { OpenbotChannelId } from "@t3tools/contracts";
import { Button } from "@t3tools/ui/button";
import { Dialog, DialogPopup, DialogTitle, DialogTrigger } from "@t3tools/ui/dialog";
import { Menu } from "lucide-react";
import { Spinner } from "@t3tools/ui/spinner";
import { useEffect, useState } from "react";

import { ChannelSidebar } from "./components/ChannelSidebar";
import { ChannelView } from "./components/ChannelView";
import { ConversationDetails } from "./components/ConversationDetails";
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
  const [detailsOpen, setDetailsOpen] = useState(true);
  const [mobileDetailsOpen, setMobileDetailsOpen] = useState(false);
  const [channelsOpen, setChannelsOpen] = useState(false);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [sendError, setSendError] = useState<string | null>(null);

  // iOS resizes the visual viewport when the keyboard opens, not the layout viewport.
  useEffect(() => {
    const viewport = window.visualViewport;
    if (viewport === null) return;
    const update = () => {
      if (viewport.scale !== 1) return;
      document.documentElement.style.setProperty("--chat-height", `${viewport.height}px`);
      document.documentElement.style.setProperty("--chat-top", `${viewport.offsetTop}px`);
    };
    update();
    viewport.addEventListener("resize", update);
    viewport.addEventListener("scroll", update);
    return () => {
      viewport.removeEventListener("resize", update);
      viewport.removeEventListener("scroll", update);
      document.documentElement.style.removeProperty("--chat-height");
      document.documentElement.style.removeProperty("--chat-top");
    };
  }, []);

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

  const sidebar = (
    <ChannelSidebar
      channels={channels}
      selectedChannelId={activeChannelId}
      onSelect={(channelId) => {
        setSelectedChannelId(channelId);
        setSendError(null);
        setChannelsOpen(false);
      }}
      onCreate={() => {
        setCreateError(null);
        setChannelsOpen(false);
        setDialogOpen(true);
      }}
      connectionLabel={connectionLabel}
    />
  );

  return (
    <div className="openbot-shell flex w-full bg-background text-foreground">
      <div className="hidden h-full shrink-0 md:block">{sidebar}</div>
      <main className="flex min-h-0 min-w-0 flex-1 flex-col">
        <Dialog open={channelsOpen} onOpenChange={setChannelsOpen}>
          <header className="flex shrink-0 items-center gap-2 border-b border-border bg-background px-2 pt-[env(safe-area-inset-top)] md:hidden">
            <DialogTrigger
              render={<Button variant="ghost" size="icon" className="size-11 shrink-0" />}
              aria-label="Open channels"
            >
              <Menu className="size-5" />
            </DialogTrigger>
            <div className="min-w-0 flex-1 py-2.5">
              <h1 className="truncate text-base font-semibold">
                <button
                  onClick={() => setMobileDetailsOpen(true)}
                  aria-label="View conversation details"
                >
                  {activeChannel?.name ?? "OpenBot"}
                </button>
              </h1>
              <p className="text-xs text-muted-foreground">
                {connectionLabel === "Connected" ? "OpenBot" : connectionLabel}
              </p>
            </div>
          </header>
          <DialogPopup className="h-[70dvh] max-h-[85dvh] overflow-hidden p-0 [&_aside]:w-full [&_aside]:border-0 [&_aside]:pb-[env(safe-area-inset-bottom)]">
            <DialogTitle className="sr-only">Channels</DialogTitle>
            {sidebar}
          </DialogPopup>
        </Dialog>
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
            <ChannelView
              view={view}
              environmentId={environmentId}
              onShowDetails={() => {
                if (window.matchMedia("(min-width: 1024px)").matches)
                  setDetailsOpen((open) => !open);
                else setMobileDetailsOpen(true);
              }}
            />
            {sendError !== null && (
              <p className="px-4 py-1 text-error-foreground text-xs">{sendError}</p>
            )}
            <Composer
              key={activeChannel.id}
              channelName={activeChannel.name}
              environmentId={environmentId}
              disabled={phase !== "ready"}
              onSend={async (message) => {
                setSendError(null);
                const result = await runSend({
                  environmentId,
                  input: {
                    channelId: activeChannel.id,
                    ...message,
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
      {environmentId !== null && view !== null && (
        <>
          {detailsOpen && (
            <div className="hidden h-full w-80 shrink-0 border-l border-border lg:block">
              <ConversationDetails
                key={view.channel.id}
                environmentId={environmentId}
                view={view}
                onClose={() => setDetailsOpen(false)}
              />
            </div>
          )}
          <Dialog open={mobileDetailsOpen} onOpenChange={setMobileDetailsOpen}>
            <DialogPopup className="h-[85dvh] overflow-hidden p-0" bottomStickOnMobile>
              <DialogTitle className="sr-only">Conversation details</DialogTitle>
              <ConversationDetails
                key={view.channel.id}
                environmentId={environmentId}
                view={view}
                onClose={() => setMobileDetailsOpen(false)}
              />
            </DialogPopup>
          </Dialog>
        </>
      )}
      {environmentId !== null && dialogOpen && (
        <NewChannelDialog
          environmentId={environmentId}
          open={dialogOpen}
          onOpenChange={setDialogOpen}
          busy={creating}
          error={createError}
          onCreate={async (input) => {
            if (environmentId === null) return;
            setCreating(true);
            setCreateError(null);
            const result = await runCreate({ environmentId, input });
            setCreating(false);
            if (result._tag === "Failure") {
              setCreateError(errorText(squashAtomCommandFailure(result)));
              return;
            }
            setSelectedChannelId(result.value.id);
            setDialogOpen(false);
          }}
        />
      )}
    </div>
  );
}

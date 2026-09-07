import type { EnvironmentId, OpenbotChannelId, OpenbotProjectId } from "@t3tools/contracts";
import { Button } from "@t3tools/ui/button";
import { Dialog, DialogPopup, DialogTitle } from "@t3tools/ui/dialog";
import { Spinner } from "@t3tools/ui/spinner";
import { lazy, Suspense, useEffect, useMemo, useState } from "react";

import { ChannelView } from "./components/ChannelView";
import { ChatHeader } from "./components/ChatHeader";
import { Composer } from "./components/Composer";
import { ConversationDetails } from "./components/ConversationDetails";
import { KnowledgeEditorPage } from "./components/KnowledgeEditorPage";
import { NewChatDialog } from "./components/NewChatDialog";
import { NewProjectDialog } from "./components/NewProjectDialog";
import { PendingRequests } from "./components/PendingRequests";
import { ProjectSettingsPage } from "./components/ProjectSettingsPage";
import { Sidebar } from "./components/Sidebar";
import {
  createChannel,
  createProject,
  sendChannelMessage,
  updateProject,
  useAtomCommand,
  useChannelView,
  useChannels,
  useConnectionPhase,
  usePrimaryEnvironmentId,
  useProjects,
} from "./state/channels";
import { commandErrorText } from "./state/errors";
import type { OpenbotPage } from "./state/route";

const ProjectIconPicker = lazy(() => import("./components/ProjectIconPicker"));

const SELECTED_CHANNEL_KEY = "openbot:selected-channel";

function readSelectedChannel(): OpenbotChannelId | null {
  const value = window.localStorage.getItem(SELECTED_CHANNEL_KEY);
  return value === null || value === "" ? null : (value as OpenbotChannelId);
}

export function App() {
  const environmentId = usePrimaryEnvironmentId();
  const phase = useConnectionPhase(environmentId);
  const channels = useChannels(environmentId);
  const projects = useProjects(environmentId);

  const [selectedChannelId, setSelectedChannelId] = useState<OpenbotChannelId | null>(
    readSelectedChannel,
  );
  const [page, setPage] = useState<OpenbotPage | null>(null);
  const [search, setSearch] = useState("");
  const [detailsOpen, setDetailsOpen] = useState(true);
  const [mobileDetailsOpen, setMobileDetailsOpen] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [chatDialogOpen, setChatDialogOpen] = useState(false);
  const [projectDialogOpen, setProjectDialogOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const [createChatError, setCreateChatError] = useState<string | null>(null);
  const [createProjectError, setCreateProjectError] = useState<string | null>(null);
  const [sendError, setSendError] = useState<string | null>(null);
  const [iconProjectId, setIconProjectId] = useState<OpenbotProjectId | null>(null);
  const [iconBusy, setIconBusy] = useState(false);
  const [iconError, setIconError] = useState<string | null>(null);

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

  const runCreateChannel = useAtomCommand(createChannel, { reportFailure: false });
  const runCreateProject = useAtomCommand(createProject, { reportFailure: false });
  const runUpdateProject = useAtomCommand(updateProject, { reportFailure: false });
  const runSend = useAtomCommand(sendChannelMessage, { reportFailure: false });

  // Fall back to the first chat when the stored selection no longer exists.
  const activeChannelId =
    selectedChannelId !== null && channels.some((channel) => channel.id === selectedChannelId)
      ? selectedChannelId
      : (channels[0]?.id ?? null);
  useEffect(() => {
    if (activeChannelId !== null) {
      window.localStorage.setItem(SELECTED_CHANNEL_KEY, activeChannelId);
    }
  }, [activeChannelId]);

  const view = useChannelView(environmentId, page === null ? activeChannelId : null);
  const activeChannel = channels.find((channel) => channel.id === activeChannelId) ?? null;
  const activeProject = useMemo(
    () =>
      activeChannel === null
        ? null
        : (projects.find((project) => project.id === activeChannel.openbotProjectId) ?? null),
    [activeChannel, projects],
  );
  const parentChannel =
    activeChannel?.parentChannelId === undefined || activeChannel.parentChannelId === null
      ? null
      : (channels.find((channel) => channel.id === activeChannel.parentChannelId) ?? null);
  const iconProject = projects.find((project) => project.id === iconProjectId) ?? null;
  const settingsProject =
    page?.type === "project-settings"
      ? (projects.find((project) => project.id === page.projectId) ?? null)
      : null;

  const openChannel = (channelId: OpenbotChannelId) => {
    setSelectedChannelId(channelId);
    setPage(null);
    setSendError(null);
    setSidebarOpen(false);
  };

  const connectionLabel =
    environmentId === null
      ? "Looking for the T3 server…"
      : phase === "ready"
        ? "Connected"
        : phase === "synchronizing"
          ? "Connecting…"
          : "Disconnected";

  const sidebar = (
    <Sidebar
      projects={projects}
      channels={channels}
      activeChannelId={page === null ? activeChannelId : null}
      search={search}
      onSearchChange={setSearch}
      onSelectChannel={openChannel}
      onOpenProjectIcon={(projectId) => {
        setIconError(null);
        setIconProjectId(projectId);
      }}
      onOpenProjectSettings={(projectId) => {
        setPage({ type: "project-settings", projectId, tab: "knowledge" });
        setSidebarOpen(false);
      }}
      onNewProject={() => {
        setCreateProjectError(null);
        setSidebarOpen(false);
        setProjectDialogOpen(true);
      }}
      onNewChat={() => {
        setCreateChatError(null);
        setSidebarOpen(false);
        setChatDialogOpen(true);
      }}
      connectionLabel={connectionLabel}
    />
  );

  const sendMessage = async (
    environment: EnvironmentId,
    input: Parameters<typeof runSend>[0]["input"],
  ) => {
    setSendError(null);
    const result = await runSend({ environmentId: environment, input });
    if (result._tag === "Failure") {
      setSendError(commandErrorText(result));
      return false;
    }
    return true;
  };

  return (
    <div className="openbot-shell flex w-full bg-background text-foreground">
      <div className="hidden h-full shrink-0 md:block">{sidebar}</div>
      <Dialog open={sidebarOpen} onOpenChange={setSidebarOpen}>
        <DialogPopup className="h-[70dvh] max-h-[85dvh] overflow-hidden p-0 [&_aside]:w-full [&_aside]:border-0 [&_aside]:pb-[env(safe-area-inset-bottom)]">
          <DialogTitle className="sr-only">Projects and chats</DialogTitle>
          {sidebar}
        </DialogPopup>
      </Dialog>
      <main className="flex min-h-0 min-w-0 flex-1 flex-col">
        {environmentId === null ? (
          <div className="flex flex-1 flex-col items-center justify-center gap-3 text-muted-foreground text-sm">
            <Spinner className="size-5" />
            <p>Connecting to T3 Code…</p>
            <p className="max-w-sm text-center text-xs">
              If this does not resolve, pair this browser with the server first by opening the T3
              Code pairing link on this host.
            </p>
          </div>
        ) : page?.type === "project-settings" ? (
          settingsProject === null ? (
            <div className="flex flex-1 items-center justify-center text-muted-foreground text-sm">
              This project no longer exists.
            </div>
          ) : (
            <ProjectSettingsPage
              key={settingsProject.id}
              environmentId={environmentId}
              project={settingsProject}
              tab={page.tab}
              onTabChange={(tab) => setPage({ ...page, tab })}
              onBack={() => openChannel(settingsProject.mainChannelId)}
              onOpenKnowledge={(knowledgeId) =>
                setPage({ type: "knowledge", knowledgeId, projectId: settingsProject.id })
              }
              onNewKnowledge={() =>
                setPage({ type: "knowledge", knowledgeId: null, projectId: settingsProject.id })
              }
            />
          )
        ) : page?.type === "knowledge" ? (
          <KnowledgeEditorPage
            key={page.knowledgeId ?? "new"}
            environmentId={environmentId}
            knowledgeId={page.knowledgeId}
            projectId={page.projectId}
            onClose={() => {
              if (page.projectId === null) setPage(null);
              else
                setPage({ type: "project-settings", projectId: page.projectId, tab: "knowledge" });
            }}
          />
        ) : channels.length === 0 ? (
          <div className="flex flex-1 flex-col items-center justify-center gap-3 px-6 text-center text-muted-foreground text-sm">
            <p>Nothing here yet.</p>
            <p className="max-w-sm text-xs">
              Create a project for ongoing work, or a chat for a one-off. In a chat you can also ask
              OpenBot to “use the onboard skill and onboard me”.
            </p>
            <div className="flex gap-2">
              <Button onClick={() => setProjectDialogOpen(true)}>New project</Button>
              <Button variant="outline" onClick={() => setChatDialogOpen(true)}>
                New chat
              </Button>
            </div>
          </div>
        ) : view === null || activeChannel === null ? (
          <div className="flex flex-1 items-center justify-center text-muted-foreground text-sm">
            <Spinner className="size-4" />
          </div>
        ) : (
          <>
            <ChatHeader
              environmentId={environmentId}
              view={view}
              project={activeProject}
              parent={parentChannel}
              detailsOpen={detailsOpen}
              onToggleDetails={() => {
                if (window.matchMedia("(min-width: 1024px)").matches)
                  setDetailsOpen((open) => !open);
                else setMobileDetailsOpen(true);
              }}
              onOpenSidebar={() => setSidebarOpen(true)}
              onOpenProjectIcon={(projectId) => {
                setIconError(null);
                setIconProjectId(projectId);
              }}
              onSelectChannel={openChannel}
            />
            <ChannelView
              view={view}
              environmentId={environmentId}
              onContinue={(message) =>
                void sendMessage(environmentId, {
                  channelId: activeChannel.id,
                  text: message.text,
                  attachments: [],
                })
              }
            />
            {sendError !== null && (
              <p className="px-4 py-1 text-error-foreground text-xs">{sendError}</p>
            )}
            <PendingRequests
              environmentId={environmentId}
              view={view}
              onSendMessage={(text) =>
                sendMessage(environmentId, { channelId: activeChannel.id, text })
              }
            />
            <Composer
              key={activeChannel.id}
              channelName={activeChannel.name}
              environmentId={environmentId}
              disabled={phase !== "ready"}
              onSend={(message) =>
                sendMessage(environmentId, { channelId: activeChannel.id, ...message })
              }
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
              <DialogTitle className="sr-only">Computer and routines</DialogTitle>
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
      {environmentId !== null && chatDialogOpen && (
        <NewChatDialog
          environmentId={environmentId}
          open={chatDialogOpen}
          onOpenChange={setChatDialogOpen}
          busy={creating}
          error={createChatError}
          onCreate={async (input) => {
            setCreating(true);
            setCreateChatError(null);
            const result = await runCreateChannel({ environmentId, input });
            setCreating(false);
            if (result._tag === "Failure") {
              setCreateChatError(commandErrorText(result));
              return;
            }
            setChatDialogOpen(false);
            openChannel(result.value.id);
          }}
        />
      )}
      {environmentId !== null && projectDialogOpen && (
        <NewProjectDialog
          open={projectDialogOpen}
          onOpenChange={setProjectDialogOpen}
          busy={creating}
          error={createProjectError}
          onCreate={async (input) => {
            setCreating(true);
            setCreateProjectError(null);
            const result = await runCreateProject({ environmentId, input });
            setCreating(false);
            if (result._tag === "Failure") {
              setCreateProjectError(commandErrorText(result));
              return;
            }
            setProjectDialogOpen(false);
            openChannel(result.value.mainChannelId);
          }}
        />
      )}
      {environmentId !== null && iconProject !== null && (
        <Suspense fallback={null}>
          <ProjectIconPicker
            projectName={iconProject.name}
            value={iconProject.icon}
            busy={iconBusy}
            error={iconError}
            onSelect={async (icon) => {
              setIconBusy(true);
              setIconError(null);
              const result = await runUpdateProject({
                environmentId,
                input: {
                  projectId: iconProject.id,
                  expectedRevision: iconProject.revision,
                  icon,
                },
              });
              setIconBusy(false);
              if (result._tag === "Failure") setIconError(commandErrorText(result));
            }}
            onClose={() => setIconProjectId(null)}
          />
        </Suspense>
      )}
    </div>
  );
}

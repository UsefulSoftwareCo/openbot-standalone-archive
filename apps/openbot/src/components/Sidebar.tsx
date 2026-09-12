import { Link } from "@tanstack/react-router";
import { channelHref, pageHref, projectKnowledgePage } from "../state/route";
import type {
  OpenbotChannel,
  OpenbotChannelId,
  OpenbotProject,
  OpenbotProjectId,
} from "@t3tools/contracts";
import { Button } from "@t3tools/ui/button";
import { cn } from "@t3tools/ui/cn";
import { Input } from "@t3tools/ui/input";
import { ScrollArea } from "@t3tools/ui/scroll-area";
import { Bot, Plus, Settings, Trash2 } from "lucide-react";
import { useMemo } from "react";

import { buildSidebarGroups } from "../state/sidebar";
import { ProjectIcon } from "./ProjectIcon";

const sectionLabelClass =
  "px-2 font-medium text-[11px] text-sidebar-muted-foreground uppercase tracking-wide";
const hintClass = "px-2 py-2 text-sidebar-muted-foreground text-xs leading-relaxed";

function rowClass(selected: boolean): string {
  return cn(
    "flex min-h-11 w-full items-center rounded-md py-2 text-left text-xs md:min-h-0",
    selected
      ? "bg-sidebar-row-selected text-foreground shadow-xs/5"
      : "text-sidebar-foreground/85 hover:bg-sidebar-row-hover hover:text-foreground",
  );
}

/** The threads nested under one parent chat, drawn on a connector line. */
function ThreadList({
  threads,
  activeChannelId,
  onDelete,
}: {
  readonly onDelete: (channel: OpenbotChannel) => void;
  readonly threads: ReadonlyArray<OpenbotChannel>;
  readonly activeChannelId: OpenbotChannelId | null;
}) {
  if (threads.length === 0) return null;
  return (
    <div className="openbot-thread-list">
      {threads.map((thread) => {
        const selected = thread.id === activeChannelId;
        return (
          <div key={thread.id} className="openbot-row">
            <Link
              to={channelHref(thread.id)}
              aria-current={selected ? "page" : undefined}
              className={cn(
                "openbot-thread-row",
                selected
                  ? "bg-sidebar-row-selected text-foreground"
                  : "text-sidebar-muted-foreground hover:text-foreground",
              )}
            >
              <span className="truncate">{thread.name}</span>
            </Link>
            <DeleteChatButton channel={thread} onDelete={onDelete} />
          </div>
        );
      })}
    </div>
  );
}

/**
 * Projects and standalone chats, each with its threads nested underneath. The
 * search box filters both sections; a thread that matches keeps its parent
 * visible so a hit is never hidden.
 */
export function Sidebar({
  projects,
  channels,
  activeChannelId,
  search,
  onSearchChange,
  onOpenProjectIcon,
  onNewProject,
  connectionLabel,
  onDeleteChannel,
}: {
  readonly projects: ReadonlyArray<OpenbotProject>;
  readonly channels: ReadonlyArray<OpenbotChannel>;
  readonly activeChannelId: OpenbotChannelId | null;
  readonly search: string;
  readonly onSearchChange: (search: string) => void;
  readonly onOpenProjectIcon: (projectId: OpenbotProjectId) => void;
  readonly onNewProject: () => void;
  readonly connectionLabel: string;
  readonly onDeleteChannel: (channel: OpenbotChannel) => void;
}) {
  const groups = useMemo(
    () => buildSidebarGroups(projects, channels, search),
    [projects, channels, search],
  );
  const searching = search.trim() !== "";
  return (
    <aside
      data-app-sidebar
      className="flex h-full w-56 shrink-0 flex-col border-r border-sidebar-border bg-sidebar text-sidebar-foreground"
      aria-label="Projects and chats"
    >
      <div className="flex h-12 shrink-0 items-center gap-2 px-4 font-semibold text-sm tracking-tight">
        <Bot className="size-4 text-muted-foreground" />
        OpenBot
      </div>
      <div className="px-3 pb-2">
        <Input
          className="h-7 text-xs"
          aria-label="Find a project or chat"
          placeholder="Find a project or chat…"
          value={search}
          onChange={(event) => onSearchChange(event.target.value)}
        />
      </div>
      <ScrollArea className="min-h-0 flex-1">
        <nav className="flex flex-col px-2 pb-2">
          <div className="mt-3 flex items-center justify-between">
            <span className={sectionLabelClass}>Projects</span>
            <Button
              size="icon"
              className="size-11 md:size-7"
              variant="ghost-muted"
              aria-label="New project"
              onClick={onNewProject}
            >
              <Plus />
            </Button>
          </div>
          {groups.projects.length === 0 ? (
            <p className={hintClass}>
              {searching
                ? "No projects match."
                : "No projects yet. Create one, or ask in a chat: “use the onboard skill and onboard me”."}
            </p>
          ) : (
            groups.projects.map((group) => {
              const selected = group.mainChannel?.id === activeChannelId;
              return (
                <div key={group.project.id} className="mb-1">
                  <div className="openbot-row">
                    <button
                      type="button"
                      className="openbot-row-icon"
                      aria-label={`Change the ${group.project.name} icon`}
                      onClick={() => onOpenProjectIcon(group.project.id)}
                    >
                      <ProjectIcon icon={group.project.icon} size={17} />
                    </button>
                    <Link
                      to={channelHref(group.project.mainChannelId)}
                      aria-current={selected ? "page" : undefined}
                      className={cn(rowClass(selected), "pr-9 pl-10 disabled:opacity-64")}
                    >
                      <span className="truncate">{group.project.name}</span>
                    </Link>
                    <Button
                      variant="ghost"
                      size="icon-xs"
                      className="openbot-row-settings text-muted-foreground"
                      aria-label={`${group.project.name} settings`}
                      render={<Link to={pageHref(projectKnowledgePage(group.project.id))} />}
                    >
                      <Settings />
                    </Button>
                  </div>
                  <ThreadList
                    threads={group.threads}
                    activeChannelId={activeChannelId}
                    onDelete={onDeleteChannel}
                  />
                </div>
              );
            })
          )}
          <div className="mt-5 flex items-center justify-between">
            <span className={sectionLabelClass}>Chats</span>
            <Button
              size="icon"
              className="size-11 md:size-7"
              variant="ghost-muted"
              aria-label="New chat"
              render={<Link to="/chats/new" />}
            >
              <Plus />
            </Button>
          </div>
          {groups.chats.length === 0 ? (
            <p className={hintClass}>
              {searching ? "No chats match." : "No chats yet. Create one to start talking."}
            </p>
          ) : (
            groups.chats.map((group) => {
              const selected = group.channel.id === activeChannelId;
              return (
                <div key={group.channel.id} className="mb-1">
                  <div className="openbot-row">
                    <Link
                      to={channelHref(group.channel.id)}
                      aria-current={selected ? "page" : undefined}
                      className={cn(rowClass(selected), "pr-9 pl-2")}
                    >
                      <span className="truncate">{group.channel.name}</span>
                    </Link>
                    <DeleteChatButton channel={group.channel} onDelete={onDeleteChannel} />
                  </div>
                  <ThreadList
                    threads={group.threads}
                    activeChannelId={activeChannelId}
                    onDelete={onDeleteChannel}
                  />
                </div>
              );
            })
          )}
        </nav>
      </ScrollArea>
      <div className="flex items-center justify-end gap-2 border-t border-sidebar-border px-3 py-2 text-[11px] text-sidebar-muted-foreground">
        <Button
          variant="ghost"
          size="sm"
          className="mr-auto"
          render={<Link to="/settings/general" />}
        >
          <Settings />
          Settings
        </Button>
        <span className="truncate">{connectionLabel}</span>
      </div>
    </aside>
  );
}

/** Deletion is a separate control so the chat remains a normal browser link. */
function DeleteChatButton({
  channel,
  onDelete,
}: {
  readonly channel: OpenbotChannel;
  readonly onDelete: (channel: OpenbotChannel) => void;
}) {
  return (
    <Button
      variant="ghost"
      size="icon-xs"
      className="openbot-row-settings text-muted-foreground hover:text-destructive-foreground"
      aria-label={`Delete ${channel.name}`}
      onClick={() => onDelete(channel)}
    >
      <Trash2 />
    </Button>
  );
}

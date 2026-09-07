import type { OpenbotChannel, OpenbotChannelId, OpenbotProject } from "@t3tools/contracts";

/** A project row and the threads nested under its main chat. */
export interface SidebarProjectGroup {
  readonly project: OpenbotProject;
  /** The project's main chat, or null while the channel list is still catching up. */
  readonly mainChannel: OpenbotChannel | null;
  readonly threads: ReadonlyArray<OpenbotChannel>;
}

/** A standalone chat row and the threads nested under it. */
export interface SidebarChatGroup {
  readonly channel: OpenbotChannel;
  readonly threads: ReadonlyArray<OpenbotChannel>;
}

export interface SidebarGroups {
  readonly projects: ReadonlyArray<SidebarProjectGroup>;
  readonly chats: ReadonlyArray<SidebarChatGroup>;
}

function normalize(value: string): string {
  return value.trim().toLowerCase();
}

/**
 * Groups the flat channel list the server streams into the two sidebar
 * sections. A chat is a project's main chat when a project points at it, a
 * thread when it has a parent, and a standalone chat otherwise; threads always
 * hang off their parent rather than floating at the top level.
 *
 * A search keeps a group when the parent row matches, and otherwise keeps only
 * the threads that match, so a hit is never hidden behind a parent that misses.
 */
export function buildSidebarGroups(
  projects: ReadonlyArray<OpenbotProject>,
  channels: ReadonlyArray<OpenbotChannel>,
  search = "",
): SidebarGroups {
  const query = normalize(search);
  const matches = (name: string) => query === "" || normalize(name).includes(query);

  const childrenByParent = new Map<OpenbotChannelId, Array<OpenbotChannel>>();
  for (const channel of channels) {
    if (channel.parentChannelId === null) continue;
    const siblings = childrenByParent.get(channel.parentChannelId);
    if (siblings === undefined) childrenByParent.set(channel.parentChannelId, [channel]);
    else siblings.push(channel);
  }
  const byId = new Map(channels.map((channel) => [channel.id, channel]));
  const mainChannelIds = new Set(projects.map((project) => project.mainChannelId));

  const threadsOf = (parentId: OpenbotChannelId, parentMatched: boolean) => {
    const all = childrenByParent.get(parentId) ?? [];
    return parentMatched ? all : all.filter((thread) => matches(thread.name));
  };

  const projectGroups: Array<SidebarProjectGroup> = [];
  for (const project of projects) {
    const parentMatched = matches(project.name);
    const threads = threadsOf(project.mainChannelId, parentMatched);
    if (!parentMatched && threads.length === 0) continue;
    projectGroups.push({
      project,
      mainChannel: byId.get(project.mainChannelId) ?? null,
      threads,
    });
  }

  const chatGroups: Array<SidebarChatGroup> = [];
  for (const channel of channels) {
    if (channel.parentChannelId !== null || mainChannelIds.has(channel.id)) continue;
    const parentMatched = matches(channel.name);
    const threads = threadsOf(channel.id, parentMatched);
    if (!parentMatched && threads.length === 0) continue;
    chatGroups.push({ channel, threads });
  }

  return { projects: projectGroups, chats: chatGroups };
}

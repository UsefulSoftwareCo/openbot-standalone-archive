import type { OpenbotChannelId, OpenbotKnowledgeId, OpenbotProjectId } from "@t3tools/contracts";

export type ProjectSettingsTab = "knowledge" | "instructions";

/**
 * The addressable pages in the main area. Conversation identity is shared
 * by standalone chats, project main chats, and child threads.
 */
export type OpenbotRoute =
  | { readonly type: "chat"; readonly channelId: OpenbotChannelId }
  /** The composer-first draft page. Nothing exists until its first message. */
  | { readonly type: "new-chat" }
  /** One chat's screen, full pane: one canvas, one keyboard, one lease. The
      chat is the identity, so the page cannot be opened without one. */
  | { readonly type: "computer"; readonly channelId: OpenbotChannelId }
  | {
      readonly type: "project-settings";
      readonly projectId: OpenbotProjectId;
      readonly tab: ProjectSettingsTab;
    }
  | {
      readonly type: "knowledge";
      /** null starts a new entry. */
      readonly knowledgeId: OpenbotKnowledgeId | null;
      /** Owner project for a new entry, and where Cancel returns to. */
      readonly projectId: OpenbotProjectId | null;
    };

/** Everything the main area can show other than a chat. */
export type OpenbotPage = Exclude<OpenbotRoute, { readonly type: "chat" }>;

export type KnowledgePage = Extract<OpenbotPage, { readonly type: "knowledge" }>;

/** The knowledge tab of one project's settings. */
export function projectKnowledgePage(projectId: OpenbotProjectId): OpenbotPage {
  return { type: "project-settings", projectId, tab: "knowledge" };
}

/**
 * Whether the conversation details rail belongs next to what the main area is
 * showing. The rail is about the selected chat, so a full-pane page owns the
 * width instead — most of all the computer, whose stage is the point.
 */
export function detailsRailApplies(page: OpenbotPage | null): boolean {
  return page === null;
}

/**
 * Where the knowledge editor goes when it closes: back to the project settings
 * it was opened from, or to the chat when it was opened without one. `null`
 * means "show the selected chat again".
 */
export function knowledgeReturnPage(page: KnowledgePage): OpenbotPage | null {
  return page.projectId === null ? null : projectKnowledgePage(page.projectId);
}

/** Every conversation has one canonical address, independent of its title. */
export function channelHref(channelId: OpenbotChannelId): string {
  return `/chats/${encodeURIComponent(channelId)}`;
}

/** Full-page navigation is encoded in the pathname, including editor ownership. */
export function pageHref(page: OpenbotPage | null): string {
  if (page === null) return "/";
  switch (page.type) {
    case "new-chat":
      return "/chats/new";
    case "computer":
      return `${channelHref(page.channelId)}/computer`;
    case "project-settings":
      return `/projects/${encodeURIComponent(page.projectId)}/settings/${page.tab}`;
    case "knowledge": {
      const owner =
        page.projectId === null ? "" : `/projects/${encodeURIComponent(page.projectId)}`;
      return `${owner}/knowledge/${page.knowledgeId === null ? "new" : encodeURIComponent(page.knowledgeId)}`;
    }
  }
}

/** Root and unmatched addresses are explicit states, never a stored selection. */
export type OpenbotScreen =
  | OpenbotRoute
  | { readonly type: "home" }
  | { readonly type: "not-found" };

import type { OpenbotChannelId, OpenbotKnowledgeId, OpenbotProjectId } from "@t3tools/contracts";

export type ProjectSettingsTab = "knowledge" | "instructions";

/**
 * What the main area is showing. OpenBot has no URL router; the selected chat
 * is the only part worth persisting between sessions.
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

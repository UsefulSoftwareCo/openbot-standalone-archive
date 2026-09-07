import type { OpenbotChannelId, OpenbotKnowledgeId, OpenbotProjectId } from "@t3tools/contracts";

export type ProjectSettingsTab = "knowledge" | "instructions";

/**
 * What the main area is showing. OpenBot has no URL router; the selected chat
 * is the only part worth persisting between sessions.
 */
export type OpenbotRoute =
  | { readonly type: "chat"; readonly channelId: OpenbotChannelId }
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

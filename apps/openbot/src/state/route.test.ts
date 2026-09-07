import { OpenbotKnowledgeId, OpenbotProjectId } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";

import { knowledgeReturnPage, projectKnowledgePage } from "./route";

const projectId = OpenbotProjectId.make("openbot-project:groceries");
const knowledgeId = OpenbotKnowledgeId.make("openbot-knowledge:pantry");

describe("knowledgeReturnPage", () => {
  it("returns to the knowledge tab of the project the editor was opened from", () => {
    expect(knowledgeReturnPage({ type: "knowledge", knowledgeId, projectId })).toEqual({
      type: "project-settings",
      projectId,
      tab: "knowledge",
    });
  });

  it("returns to the chat when the editor was opened without a project", () => {
    expect(knowledgeReturnPage({ type: "knowledge", knowledgeId, projectId: null })).toBeNull();
  });

  it("sends a new entry back to the project that will own it", () => {
    expect(knowledgeReturnPage({ type: "knowledge", knowledgeId: null, projectId })).toEqual(
      projectKnowledgePage(projectId),
    );
  });
});

import { createMemoryHistory } from "@tanstack/react-router";
import { describe, expect, it } from "@effect/vitest";
import { OpenbotChannelId, OpenbotKnowledgeId, OpenbotProjectId } from "@t3tools/contracts";
import { createOpenbotRouter } from "./router";
import { channelHref, pageHref, type OpenbotRoute } from "./state/route";

const channelId = OpenbotChannelId.make("chat:parent%2Fchild/one #two");
const projectId = OpenbotProjectId.make("project:one/two");
const knowledgeId = OpenbotKnowledgeId.make("knowledge:one%2Ftwo");
const pages: ReadonlyArray<OpenbotRoute> = [
  { type: "chat", channelId },
  { type: "computer", channelId },
  { type: "project-settings", projectId, tab: "instructions" },
  { type: "knowledge", projectId, knowledgeId },
  { type: "knowledge", projectId, knowledgeId: null },
  { type: "knowledge", projectId: null, knowledgeId },
];

describe("OpenBot URL routes", () => {
  for (const page of pages) {
    it(`resolves a direct ${page.type} link without stored navigation state`, async () => {
      const href = page.type === "chat" ? channelHref(page.channelId) : pageHref(page);
      const router = createOpenbotRouter(createMemoryHistory({ initialEntries: [href] }));
      await router.load();
      expect(router.state.matches.at(-1)?.status).toBe("success");
      expect(router.state.matches.at(-1)?.loaderData).toEqual(page);
    });
  }
  it("rejects unknown project settings tabs", async () => {
    const router = createOpenbotRouter(
      createMemoryHistory({
        initialEntries: [`/projects/${encodeURIComponent(projectId)}/settings/missing`],
      }),
    );
    await router.load();
    expect(router.state.matches.at(-1)?.status).toBe("error");
  });
});

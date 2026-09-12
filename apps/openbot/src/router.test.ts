import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  createRoute,
} from "@tanstack/react-router";
import { describe, expect, it } from "@effect/vitest";
import { vi } from "vite-plus/test";
import { OpenbotChannelId, OpenbotKnowledgeId, OpenbotProjectId } from "@t3tools/contracts";
import { loadChatRoute } from "../../web/src/routes/_openbot.chats.$channelId";
import { loadComputerRoute } from "../../web/src/routes/_openbot.chats.$channelId_.computer";
import { loadProjectSettingsRoute } from "../../web/src/routes/_openbot.projects.$projectId.settings.$tab";
import { loadProjectKnowledgeRoute } from "../../web/src/routes/_openbot.projects.$projectId.knowledge.$knowledgeId";
import { loadKnowledgeRoute } from "../../web/src/routes/_openbot.knowledge.$knowledgeId";

import { channelHref, pageHref, type OpenbotRoute } from "./state/route";

// Exercise the production route loaders and TanStack decoding without mounting
// the UI or starting the authenticated application runtime.
vi.mock("./App", () => ({ App: () => null }));

function createOpenbotRouter(history: ReturnType<typeof createMemoryHistory>) {
  const root = createRootRoute();
  const routeTree = root.addChildren([
    createRoute({ loader: loadChatRoute, path: "/chats/$channelId", getParentRoute: () => root }),
    createRoute({
      loader: loadComputerRoute,
      path: "/chats/$channelId/computer",
      getParentRoute: () => root,
    }),
    createRoute({
      loader: loadProjectSettingsRoute,
      path: "/projects/$projectId/settings/$tab",
      getParentRoute: () => root,
    }),
    createRoute({
      loader: loadProjectKnowledgeRoute,
      path: "/projects/$projectId/knowledge/$knowledgeId",
      getParentRoute: () => root,
    }),
    createRoute({
      loader: loadKnowledgeRoute,
      path: "/knowledge/$knowledgeId",
      getParentRoute: () => root,
    }),
    createRoute({ path: "/chats/new", getParentRoute: () => root }),
  ]);
  return createRouter({ routeTree, history });
}

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

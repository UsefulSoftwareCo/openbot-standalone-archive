import {
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  type RouterHistory,
} from "@tanstack/react-router";
import { OpenbotChannelId, OpenbotKnowledgeId, OpenbotProjectId } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { App } from "./App";
import type { ProjectSettingsTab } from "./state/route";

const channelId = Schema.decodeUnknownSync(OpenbotChannelId);
const projectId = Schema.decodeUnknownSync(OpenbotProjectId);
const knowledgeId = Schema.decodeUnknownSync(OpenbotKnowledgeId);
const settingsTab = Schema.decodeUnknownSync(Schema.Literals(["knowledge", "instructions"]));
const root = createRootRoute({
  component: Outlet,
  notFoundComponent: () => <App route={{ type: "not-found" }} />,
  errorComponent: () => <App route={{ type: "not-found" }} />,
});
const home = createRoute({
  getParentRoute: () => root,
  path: "/",
  component: () => <App route={{ type: "home" }} />,
});
const newChat = createRoute({
  getParentRoute: () => root,
  path: "/chats/new",
  component: () => <App route={{ type: "new-chat" }} />,
});
const chat = createRoute({
  getParentRoute: () => root,
  path: "/chats/$channelId",
  loader: ({ params }) => ({ type: "chat" as const, channelId: channelId(params.channelId) }),
  component: () => <App route={chat.useLoaderData()} />,
});
const computer = createRoute({
  getParentRoute: () => root,
  path: "/chats/$channelId/computer",
  loader: ({ params }) => ({ type: "computer" as const, channelId: channelId(params.channelId) }),
  component: () => <App route={computer.useLoaderData()} />,
});
const settings = createRoute({
  getParentRoute: () => root,
  path: "/projects/$projectId/settings/$tab",
  loader: ({ params }) => ({
    type: "project-settings" as const,
    projectId: projectId(params.projectId),
    tab: settingsTab(params.tab) satisfies ProjectSettingsTab,
  }),
  component: () => <App route={settings.useLoaderData()} />,
});
const projectKnowledge = createRoute({
  getParentRoute: () => root,
  path: "/projects/$projectId/knowledge/$knowledgeId",
  loader: ({ params }) => ({
    type: "knowledge" as const,
    projectId: projectId(params.projectId),
    knowledgeId: params.knowledgeId === "new" ? null : knowledgeId(params.knowledgeId),
  }),
  component: () => <App route={projectKnowledge.useLoaderData()} />,
});
const knowledge = createRoute({
  getParentRoute: () => root,
  path: "/knowledge/$knowledgeId",
  loader: ({ params }) => ({
    type: "knowledge" as const,
    projectId: null,
    knowledgeId: params.knowledgeId === "new" ? null : knowledgeId(params.knowledgeId),
  }),
  component: () => <App route={knowledge.useLoaderData()} />,
});

/** Construct after pairing strips the credential from the current URL. */
export function createOpenbotRouter(history?: RouterHistory) {
  return createRouter({
    ...(history === undefined ? {} : { history }),
    routeTree: root.addChildren([
      home,
      newChat,
      chat,
      computer,
      settings,
      projectKnowledge,
      knowledge,
    ]),
    defaultPreload: false,
  });
}

import {
  DEFAULT_OPENBOT_PROJECT_ICON,
  OpenbotChannelId,
  OpenbotProjectId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OpenbotChannel,
  type OpenbotProject,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";

import { buildSidebarGroups } from "./sidebar";

function channel(
  id: string,
  name: string,
  overrides: Partial<OpenbotChannel> = {},
): OpenbotChannel {
  return {
    id: OpenbotChannelId.make(id),
    name,
    avatar: "",
    description: "",
    revision: 0,
    projectId: ProjectId.make("t3-project"),
    threadId: ThreadId.make(`thread-${id}`),
    modelSelection: { instanceId: ProviderInstanceId.make("claude"), model: "sonnet" },
    parentChannelId: null,
    openbotProjectId: null,
    createdAt: "2026-09-07T00:00:00.000Z",
    updatedAt: "2026-09-07T00:00:00.000Z",
    ...overrides,
  };
}

function project(id: string, name: string, mainChannelId: string): OpenbotProject {
  return {
    id: OpenbotProjectId.make(id),
    name,
    icon: DEFAULT_OPENBOT_PROJECT_ICON,
    instructions: "",
    revision: 0,
    t3ProjectId: ProjectId.make("t3-project"),
    mainChannelId: OpenbotChannelId.make(mainChannelId),
    workspace: { kind: "managed", path: `/tmp/${id}` },
    createdAt: "2026-09-07T00:00:00.000Z",
    updatedAt: "2026-09-07T00:00:00.000Z",
  };
}

const groceries = project("p-groceries", "Groceries", "c-groceries");
const channels = [
  channel("c-groceries", "Groceries", { openbotProjectId: groceries.id }),
  channel("c-recipes", "Weeknight recipes", {
    parentChannelId: OpenbotChannelId.make("c-groceries"),
    openbotProjectId: groceries.id,
  }),
  channel("c-inbox", "Inbox"),
  channel("c-taxes", "Tax questions", { parentChannelId: OpenbotChannelId.make("c-inbox") }),
];

describe("buildSidebarGroups", () => {
  it("nests a project's threads under its main chat and keeps them out of Chats", () => {
    const groups = buildSidebarGroups([groceries], channels);
    expect(groups.projects).toHaveLength(1);
    expect(groups.projects[0]?.mainChannel?.id).toBe("c-groceries");
    expect(groups.projects[0]?.threads.map((thread) => thread.id)).toEqual(["c-recipes"]);
    // The main chat and every thread belong to their parent, never to Chats.
    expect(groups.chats.map((group) => group.channel.id)).toEqual(["c-inbox"]);
    expect(groups.chats[0]?.threads.map((thread) => thread.id)).toEqual(["c-taxes"]);
  });

  it("reports a project whose main chat has not arrived yet", () => {
    const groups = buildSidebarGroups([groceries], [channels[2]!]);
    expect(groups.projects[0]?.mainChannel).toBeNull();
    expect(groups.projects[0]?.threads).toEqual([]);
  });

  it("keeps every thread when the parent matches the search", () => {
    const groups = buildSidebarGroups([groceries], channels, "groc");
    expect(groups.projects[0]?.threads.map((thread) => thread.id)).toEqual(["c-recipes"]);
    expect(groups.chats).toEqual([]);
  });

  it("keeps a matching thread under a parent that does not match", () => {
    const groups = buildSidebarGroups([groceries], channels, "recipes");
    expect(groups.projects).toHaveLength(1);
    expect(groups.projects[0]?.threads.map((thread) => thread.id)).toEqual(["c-recipes"]);
    expect(groups.chats).toEqual([]);
  });

  it("drops groups where neither the parent nor any thread matches", () => {
    expect(buildSidebarGroups([groceries], channels, "nothing here")).toEqual({
      projects: [],
      chats: [],
    });
  });
});

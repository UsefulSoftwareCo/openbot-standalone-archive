import { OpenbotProjectId } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";

import { linkedProjectIds, toggleProjectLink } from "./KnowledgeEditorPage";

const groceries = OpenbotProjectId.make("openbot-project:groceries");
const recipes = OpenbotProjectId.make("openbot-project:recipes");

describe("toggleProjectLink", () => {
  it("adds and removes an ordinary project", () => {
    const added = toggleProjectLink(new Set([groceries]), groceries, recipes);
    expect([...added]).toEqual([groceries, recipes]);
    expect([...toggleProjectLink(added, groceries, recipes)]).toEqual([groceries]);
  });

  it("keeps the owner selected when it is toggled", () => {
    expect([...toggleProjectLink(new Set([groceries]), groceries, groceries)]).toEqual([groceries]);
  });

  it("restores the owner when it is somehow missing", () => {
    expect([...toggleProjectLink(new Set(), groceries, groceries)]).toEqual([groceries]);
  });
});

describe("linkedProjectIds", () => {
  it("always saves the owner alongside what the user picked", () => {
    expect(linkedProjectIds(new Set([recipes]), groceries)).toEqual([recipes, groceries]);
  });

  it("saves only the picked projects when the entry has no owner", () => {
    expect(linkedProjectIds(new Set([recipes]), null)).toEqual([recipes]);
  });
});

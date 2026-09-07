import { describe, expect, it } from "@effect/vitest";

import { commandAttempt } from "./ids";

const draft = { title: "Pantry", body: "Olive oil lives above the sink." };

describe("commandAttempt", () => {
  it("replays the same command id while the payload is unchanged", () => {
    const first = commandAttempt(null, "knowledge-create", draft);
    // A double-click, or a retry after a dropped socket, must not create two records.
    expect(commandAttempt(first, "knowledge-create", { ...draft }).commandId).toBe(first.commandId);
  });

  it("mints a new command id once any field changes", () => {
    const first = commandAttempt(null, "knowledge-create", draft);
    expect(
      commandAttempt(first, "knowledge-create", { ...draft, body: "It is in the cupboard." })
        .commandId,
    ).not.toBe(first.commandId);
    expect(
      commandAttempt(first, "knowledge-create", { ...draft, title: "Pantry notes" }).commandId,
    ).not.toBe(first.commandId);
  });

  it("treats an emptied optional field as a different payload", () => {
    const first = commandAttempt(null, "project-create", { name: "Groceries", attachedPath: "/w" });
    expect(
      commandAttempt(first, "project-create", { name: "Groceries", attachedPath: "" }).commandId,
    ).not.toBe(first.commandId);
  });
});

import { RuntimeRequestId, type OpenbotPendingRequest } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { buildAnswers } from "../state/pendingRequests";

const questions = [
  {
    id: "scope",
    header: "Scope",
    question: "What should the plan target first?",
    options: [
      { label: "Orchestration", description: "Start with orchestration" },
      { value: "ui-first", label: "UI", description: "Start with the UI" },
    ],
  },
  {
    id: "areas",
    header: "Areas",
    question: "Which areas should this cover?",
    options: [
      { label: "Server", description: "Server" },
      { label: "Web", description: "Web" },
    ],
    multiSelect: true,
  },
] as const;

function userInput(
  responseCapability: "live" | "message" | "not_resumable",
): OpenbotPendingRequest {
  return {
    type: "user_input",
    requestId: RuntimeRequestId.make("request-1"),
    createdAt: "2026-09-01T00:00:00.000Z",
    questions,
    responseCapability,
  };
}

const approval: OpenbotPendingRequest = {
  type: "approval",
  requestId: RuntimeRequestId.make("approval-1"),
  requestKind: "command",
  createdAt: "2026-09-01T00:00:00.000Z",
  responseCapability: "live",
};

describe("buildAnswers", () => {
  it("keeps the provider's option value rather than its label", () => {
    expect(
      buildAnswers(userInput("live"), {
        scope: { selectedOptionValues: ["ui-first"] },
        areas: { selectedOptionValues: ["Server", "Web"] },
      }),
    ).toEqual({ scope: "ui-first", areas: ["Server", "Web"] });
  });

  it("waits until every question is answered", () => {
    expect(buildAnswers(userInput("live"), { scope: { selectedOptionValues: ["ui-first"] } })).toBe(
      null,
    );
  });

  it("still answers a request whose provider session ended but accepts a message", () => {
    expect(
      buildAnswers(userInput("message"), {
        scope: { customAnswer: "Neither, start with the docs" },
        areas: { selectedOptionValues: ["Web"] },
      }),
    ).toEqual({ scope: "Neither, start with the docs", areas: ["Web"] });
  });

  it("never answers an expired request", () => {
    expect(
      buildAnswers(userInput("not_resumable"), {
        scope: { selectedOptionValues: ["ui-first"] },
        areas: { selectedOptionValues: ["Web"] },
      }),
    ).toBe(null);
  });

  it("has no answers to build for an approval", () => {
    expect(buildAnswers(approval, {})).toBe(null);
  });
});

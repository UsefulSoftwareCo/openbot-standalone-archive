import { describe, expect, it } from "vite-plus/test";

import { dispatchWakesSnooze, queuedRunsInDeliveryOrder } from "./QueuedRunOrder.ts";

describe("dispatches that outrank a snooze", () => {
  it("wakes for the user and for work already under way, and parks agent traffic", () => {
    const decide = (createdBy: string, creationSource: string) =>
      dispatchWakesSnooze({ createdBy, creationSource } as never);

    // The user's own message, from any client.
    expect(decide("user", "web")).toBe(true);
    expect(decide("user", "mobile")).toBe(true);
    // Server deliveries that continue work the user already started:
    // delegated task completions, restart continuations, subagent results.
    expect(decide("agent", "server")).toBe(true);
    expect(decide("system", "server")).toBe(true);
    // An adapter-buffered provider wake finishing its own turn.
    expect(decide("agent", "provider")).toBe(true);
    // Agent-initiated traffic: OpenBot peer requests and replies, MCP sends
    // into someone else's thread.
    expect(decide("agent", "mcp")).toBe(false);
    expect(decide("agent", "web")).toBe(false);
  });
});

describe("queued run delivery order", () => {
  it("keeps automatic completion delivery ahead of visible queued messages", () => {
    const projection = {
      messages: [
        { id: "message:visible-first" },
        {
          id: "message:automatic",
          delegatedCompletion: {
            generation: 1,
            parentRunId: "run:parent",
            taskIds: ["task:child"],
          },
        },
        { id: "message:visible-second" },
      ],
      runs: [
        {
          id: "run:visible-first",
          ordinal: 2,
          queuePosition: 1,
          status: "queued",
          userMessageId: "message:visible-first",
        },
        {
          id: "run:automatic",
          ordinal: 4,
          queuePosition: 3,
          status: "queued",
          userMessageId: "message:automatic",
        },
        {
          id: "run:visible-second",
          ordinal: 3,
          queuePosition: 2,
          status: "queued",
          userMessageId: "message:visible-second",
        },
      ],
    } as never;

    expect(queuedRunsInDeliveryOrder(projection).map((run) => run.id)).toEqual([
      "run:automatic",
      "run:visible-first",
      "run:visible-second",
    ]);
  });
});

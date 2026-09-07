import type {
  OrchestrationV2Actor,
  OrchestrationV2AppThread,
  OrchestrationV2CreationSource,
  OrchestrationV2Run,
  OrchestrationV2ThreadProjection,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

export function isAutomaticCompletionRun(
  projection: OrchestrationV2ThreadProjection,
  run: OrchestrationV2Run,
): boolean {
  return projection.messages.some(
    (message) =>
      message.id === run.userMessageId &&
      (message.delegatedCompletion !== undefined ||
        (message.createdBy === "system" &&
          message.creationSource === "server" &&
          projection.contextTransfers.some(
            (transfer) => transfer.type === "subagent_result" && transfer.targetRunId === run.id,
          ))),
  );
}

/**
 * Whether a dispatch outranks a snooze. A snooze is the user saying "not now",
 * so only the user's own message clears it, plus the server- and
 * provider-sourced deliveries that continue work already under way: delegated
 * task completions, adapter-buffered provider wakes, subagent results and
 * restart continuations. Everything an agent starts by itself from a client or
 * an MCP tool — OpenBot peer requests and replies, MCP sends into someone
 * else's thread — waits for the thread to wake on the user's terms instead.
 *
 * Both the dispatch command and the stored message carry these two fields, so
 * the same rule decides whether to clear the snooze on arrival and whether a
 * queued run may start later.
 */
export function dispatchWakesSnooze(message: {
  readonly createdBy: OrchestrationV2Actor;
  readonly creationSource: OrchestrationV2CreationSource;
}): boolean {
  return (
    message.createdBy === "user" ||
    message.creationSource === "server" ||
    message.creationSource === "provider"
  );
}

/**
 * A snooze that has not reached its wake time yet. The wake itself is derived,
 * never an event: `snoozedUntil` simply stops counting once it passes (see
 * `effectiveSnoozed` in client-runtime), so both the client and the server read
 * the same stale field against the current clock.
 */
export function threadIsSnoozed(
  thread: Pick<OrchestrationV2AppThread, "snoozedUntil">,
  now: DateTime.Utc,
): boolean {
  return (
    thread.snoozedUntil != null &&
    DateTime.toEpochMillis(thread.snoozedUntil) > DateTime.toEpochMillis(now)
  );
}

export function queuedRunsInDeliveryOrder(
  projection: OrchestrationV2ThreadProjection,
): ReadonlyArray<OrchestrationV2Run> {
  return projection.runs
    .filter((run) => run.status === "queued")
    .toSorted((left, right) => {
      const deliveryPriority =
        Number(isAutomaticCompletionRun(projection, right)) -
        Number(isAutomaticCompletionRun(projection, left));
      return (
        deliveryPriority ||
        (left.queuePosition ?? left.ordinal) - (right.queuePosition ?? right.ordinal) ||
        left.ordinal - right.ordinal
      );
    });
}

import type { OrchestrationV2Run, OrchestrationV2ThreadProjection } from "@t3tools/contracts";

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

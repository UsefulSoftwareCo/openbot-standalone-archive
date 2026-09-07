import { createEnvironmentRpcCommand } from "@t3tools/client-runtime/state/runtime";
import { type OpenbotPendingRequest, WS_METHODS } from "@t3tools/contracts";
import {
  buildPendingUserInputAnswers,
  type PendingUserInputDraftAnswer,
} from "@t3tools/ui/pending-user-input-logic";

import { connectionAtomRuntime } from "../connection/atomRuntime";

/** Routes a decision or answers back to the request the agent is waiting on. */
export const respondToRequest = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "openbot:respond",
  tag: WS_METHODS.openbotChannelRespond,
});

/** Draft answers for one request, keyed by question id. */
export type PendingRequestDrafts = Record<string, PendingUserInputDraftAnswer>;

/**
 * The answers payload for a pending question set, or null when the request
 * cannot be answered at all or a question is still unanswered. Refusing to
 * build a payload is what keeps an expired request from being silently
 * resolved on the user's behalf.
 */
export function buildAnswers(
  request: OpenbotPendingRequest,
  drafts: PendingRequestDrafts,
): Record<string, string | string[]> | null {
  if (request.type !== "user_input") return null;
  if (request.responseCapability === "not_resumable") return null;
  return buildPendingUserInputAnswers(request.questions, drafts);
}

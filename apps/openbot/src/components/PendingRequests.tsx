import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type {
  EnvironmentId,
  OpenbotChannelView,
  OpenbotPendingRequest,
  ProviderApprovalDecision,
  RuntimeRequestId,
} from "@t3tools/contracts";
import { Button } from "@t3tools/ui/button";
import { PendingApprovalActions, PendingApprovalPanel } from "@t3tools/ui/pending-approval";
import { PendingUserInputPanel } from "@t3tools/ui/pending-user-input";
import {
  derivePendingUserInputProgress,
  setPendingUserInputCustomAnswer,
  togglePendingUserInputOptionSelection,
} from "@t3tools/ui/pending-user-input-logic";
import { Textarea } from "@t3tools/ui/textarea";
import { useCallback, useMemo, useState } from "react";

import { useAtomCommand } from "../state/channels";
import {
  buildAnswers,
  type PendingRequestDrafts,
  respondToRequest,
} from "../state/pendingRequests";

type PendingApprovalRequest = Extract<OpenbotPendingRequest, { type: "approval" }>;
type PendingUserInputRequest = Extract<OpenbotPendingRequest, { type: "user_input" }>;

const EXPIRED_NOTICE = "This request expired when the agent session ended.";
const NO_DRAFTS: PendingRequestDrafts = {};

function isApproval(request: OpenbotPendingRequest): request is PendingApprovalRequest {
  return request.type === "approval";
}

function isUserInput(request: OpenbotPendingRequest): request is PendingUserInputRequest {
  return request.type === "user_input";
}

/**
 * The questions and approvals an agent is blocked on, rendered with the same
 * components T3 web uses. Everything shown comes from the server's channel
 * view, so the panel survives navigation and reconnects; only the unsent draft
 * answers live here, keyed by request id so switching chats starts clean.
 */
export function PendingRequests({
  environmentId,
  view,
  onSendMessage,
}: {
  readonly environmentId: EnvironmentId;
  readonly view: OpenbotChannelView;
  /**
   * Sends the free-text answer as an ordinary chat message. Supplied by the
   * composer and used only for a `message` request, whose provider session has
   * ended but which the agent picks up again from the next message. Without it
   * the answer is submitted as a structured response, exactly as T3 web does.
   */
  readonly onSendMessage?: (text: string) => Promise<boolean>;
}) {
  const channelId = view.channel.id;
  const [draftsByRequestId, setDraftsByRequestId] = useState<Record<string, PendingRequestDrafts>>(
    {},
  );
  const [questionIndexByRequestId, setQuestionIndexByRequestId] = useState<Record<string, number>>(
    {},
  );
  const [respondingRequestIds, setRespondingRequestIds] = useState<ReadonlyArray<RuntimeRequestId>>(
    [],
  );
  const [errorByRequestId, setErrorByRequestId] = useState<Record<string, string>>({});
  const respond = useAtomCommand(respondToRequest, { reportFailure: false });

  const approvals = view.pendingRequests.filter(isApproval);
  const approval = approvals[0] ?? null;
  const userInput = view.pendingRequests.find(isUserInput) ?? null;
  const drafts =
    userInput === null ? NO_DRAFTS : (draftsByRequestId[userInput.requestId] ?? NO_DRAFTS);
  const questionIndex =
    userInput === null ? 0 : (questionIndexByRequestId[userInput.requestId] ?? 0);
  const canAnswer = userInput !== null && userInput.responseCapability !== "not_resumable";

  // A request that can no longer be answered renders in the same disabled
  // state as one that is mid-flight.
  const disabledRequestIds = useMemo(
    () =>
      userInput === null || canAnswer
        ? respondingRequestIds
        : [userInput.requestId, ...respondingRequestIds],
    [canAnswer, respondingRequestIds, userInput],
  );

  const finish = useCallback((requestId: RuntimeRequestId, message: string | null) => {
    setRespondingRequestIds((ids) => ids.filter((id) => id !== requestId));
    setErrorByRequestId((current) => {
      if (message === null) {
        if (!(requestId in current)) return current;
        const next = { ...current };
        delete next[requestId];
        return next;
      }
      return { ...current, [requestId]: message };
    });
  }, []);

  const submitDecision = useCallback(
    async (requestId: RuntimeRequestId, decision: ProviderApprovalDecision) => {
      const target = view.pendingRequests.find(
        (request) => isApproval(request) && request.requestId === requestId,
      );
      if (target === undefined || target.responseCapability !== "live") return;
      setRespondingRequestIds((ids) => (ids.includes(requestId) ? ids : [...ids, requestId]));
      const result = await respond({
        environmentId,
        input: { channelId, requestId, decision },
      });
      if (result._tag === "Failure") {
        const failure = squashAtomCommandFailure(result);
        finish(
          requestId,
          failure instanceof Error ? failure.message : "Could not send that decision.",
        );
        return;
      }
      finish(requestId, null);
    },
    [channelId, environmentId, finish, respond, view.pendingRequests],
  );

  const submitAnswers = useCallback(
    async (request: PendingUserInputRequest, pending: PendingRequestDrafts) => {
      const answers = buildAnswers(request, pending);
      if (answers === null) return;
      const requestId = request.requestId;
      setRespondingRequestIds((ids) => (ids.includes(requestId) ? ids : [...ids, requestId]));
      const result = await respond({
        environmentId,
        input: { channelId, requestId, answers },
      });
      if (result._tag === "Failure") {
        const failure = squashAtomCommandFailure(result);
        finish(
          requestId,
          failure instanceof Error ? failure.message : "Could not send your answer.",
        );
        return;
      }
      finish(requestId, null);
    },
    [channelId, environmentId, finish, respond],
  );

  const updateDraft = useCallback(
    (
      request: PendingUserInputRequest,
      questionId: string,
      update: (current: PendingRequestDrafts[string] | undefined) => PendingRequestDrafts[string],
    ) => {
      setDraftsByRequestId((current) => {
        const pending = current[request.requestId] ?? NO_DRAFTS;
        return {
          ...current,
          [request.requestId]: { ...pending, [questionId]: update(pending[questionId]) },
        };
      });
    },
    [],
  );

  const onToggleOption = useCallback(
    (questionId: string, optionValue: string) => {
      if (userInput === null || !canAnswer) return;
      const question = userInput.questions.find((candidate) => candidate.id === questionId);
      if (question === undefined) return;
      updateDraft(userInput, questionId, (current) =>
        togglePendingUserInputOptionSelection(question, current, optionValue),
      );
    },
    [canAnswer, updateDraft, userInput],
  );

  const onAdvance = useCallback(() => {
    if (userInput === null || !canAnswer) return;
    const progress = derivePendingUserInputProgress(userInput.questions, drafts, questionIndex);
    if (progress.isLastQuestion) {
      void submitAnswers(userInput, drafts);
      return;
    }
    setQuestionIndexByRequestId((current) => ({
      ...current,
      [userInput.requestId]: progress.questionIndex + 1,
    }));
  }, [canAnswer, drafts, questionIndex, submitAnswers, userInput]);

  if (approval === null && userInput === null) return null;

  const progress =
    userInput === null
      ? null
      : derivePendingUserInputProgress(userInput.questions, drafts, questionIndex);
  const activeQuestion = progress?.activeQuestion ?? null;
  const allowsCustomAnswer = activeQuestion !== null && activeQuestion.allowCustomAnswer !== false;
  const customAnswer = progress?.customAnswer ?? "";
  const answerAsMessage =
    userInput?.responseCapability === "message" && onSendMessage !== undefined;

  const sendCustomAnswer = () => {
    if (userInput === null || activeQuestion === null || customAnswer.trim().length === 0) return;
    if (answerAsMessage && onSendMessage !== undefined) {
      const requestId = userInput.requestId;
      const text = customAnswer;
      setRespondingRequestIds((ids) => (ids.includes(requestId) ? ids : [...ids, requestId]));
      void onSendMessage(text).then((sent) => {
        finish(requestId, sent ? null : "Could not send your answer.");
      });
      return;
    }
    onAdvance();
  };

  return (
    <div className="mx-auto flex w-full max-w-3xl min-w-0 flex-col gap-1 rounded-2xl border border-border/60 bg-card/60 px-2 py-1.5 [--composer-banner-icon-column:--spacing(6)]">
      <p className="px-1 text-[11px] font-medium text-muted-foreground">Waiting for your answer</p>
      {approval === null ? null : (
        <div className="flex min-w-0 flex-col gap-1">
          <div className="flex min-w-0 items-center gap-2">
            <PendingApprovalPanel approval={approval} pendingCount={approvals.length} />
            <span className="flex flex-none flex-wrap items-center justify-end gap-1">
              <PendingApprovalActions
                requestId={approval.requestId}
                isResponding={respondingRequestIds.includes(approval.requestId)}
                canRespond={approval.responseCapability === "live"}
                options={approval.options}
                onRespondToApproval={submitDecision}
              />
            </span>
          </div>
          {approval.responseCapability === "not_resumable" ? (
            <p className="px-1 text-[11px] text-secondary-label">{EXPIRED_NOTICE}</p>
          ) : null}
          {errorByRequestId[approval.requestId] === undefined ? null : (
            <p className="px-1 text-[11px] text-destructive-foreground">
              {errorByRequestId[approval.requestId]}
            </p>
          )}
        </div>
      )}
      {userInput === null ? null : (
        <div className="flex min-w-0 flex-col gap-1">
          <PendingUserInputPanel
            pendingUserInputs={[userInput]}
            respondingRequestIds={disabledRequestIds}
            answers={drafts}
            questionIndex={questionIndex}
            onToggleOption={onToggleOption}
            onAdvance={onAdvance}
          />
          {canAnswer ? null : (
            <p className="px-1 text-[11px] text-secondary-label">{EXPIRED_NOTICE}</p>
          )}
          {canAnswer && allowsCustomAnswer && activeQuestion !== null ? (
            <div className="flex items-end gap-1 px-1">
              <Textarea
                aria-label="Your own answer"
                className="flex-1"
                disabled={respondingRequestIds.includes(userInput.requestId)}
                onChange={(event) => {
                  const text = event.target.value;
                  updateDraft(userInput, activeQuestion.id, (current) =>
                    setPendingUserInputCustomAnswer(current, text),
                  );
                }}
                onKeyDown={(event) => {
                  if (event.key !== "Enter" || event.shiftKey) return;
                  event.preventDefault();
                  sendCustomAnswer();
                }}
                placeholder="Answer in your own words"
                rows={1}
                size="sm"
                value={customAnswer}
              />
              <Button
                disabled={
                  customAnswer.trim().length === 0 ||
                  respondingRequestIds.includes(userInput.requestId)
                }
                onClick={sendCustomAnswer}
                size="micro"
                variant="ghost-muted"
              >
                Send
              </Button>
            </div>
          ) : null}
          {errorByRequestId[userInput.requestId] === undefined ? null : (
            <p className="px-1 text-[11px] text-destructive-foreground">
              {errorByRequestId[userInput.requestId]}
            </p>
          )}
        </div>
      )}
    </div>
  );
}

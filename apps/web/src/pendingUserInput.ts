/**
 * Draft-answer logic for structured provider questions. It lives in
 * `@t3tools/ui` so every client (T3 web, OpenBot) resolves and validates the
 * same answers; this module keeps the historic web import path.
 */
export {
  buildPendingUserInputAnswers,
  countAnsweredPendingUserInputQuestions,
  derivePendingUserInputProgress,
  findFirstUnansweredPendingUserInputQuestionIndex,
  resolvePendingUserInputAnswer,
  setPendingUserInputCustomAnswer,
  togglePendingUserInputOptionSelection,
} from "@t3tools/ui/pending-user-input-logic";
export type {
  PendingUserInputDraftAnswer,
  PendingUserInputProgress,
  PendingUserInputQuestion,
} from "@t3tools/ui/pending-user-input-logic";

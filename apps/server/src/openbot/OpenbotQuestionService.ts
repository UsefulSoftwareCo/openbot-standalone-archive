import {
  CommandId,
  OpenbotQuestionError,
  OPENBOT_QUESTION_MAX_OPTIONS,
  OPENBOT_QUESTION_MAX_QUESTIONS,
  RuntimeRequestId,
  type OpenbotMcpAskQuestion,
  type OpenbotMcpAskQuestionResult,
  type OrchestrationV2Run,
  type OrchestrationV2UserInputQuestion,
  type RunId,
  type ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import {
  isActiveRun,
  ThreadManagementService,
} from "../orchestration-v2/ThreadManagementService.ts";

/**
 * Structured questions for OpenBot agents, independent of the provider.
 *
 * Claude's `AskUserQuestion` can be denied by user settings and Codex's
 * `request_user_input` is plan-mode only, so an OpenBot agent cannot rely on a
 * native question tool. `ask` records the same artifacts a provider adapter
 * records for a *message-mode* question — a pending `user_input` runtime
 * request whose `responseCapability` is `{ type: "message" }` — through the
 * `runtime-request.create` command, and returns immediately.
 *
 * The message-mode contract, which the agent must be told about in the tool
 * description: nothing blocks. The agent ends its turn after asking. When the
 * person answers, `runtime-request.respond` resolves the request and turns the
 * answers into an ordinary user message, which wakes the thread through the
 * normal queue; the resumed agent reads the answer in its next turn. Because
 * the request lives in the projection, it survives navigation, reconnect, and
 * the end of the asking run: an unanswered question stays answerable later
 * rather than expiring with the turn. Only thread deletion or an explicit
 * cancellation retires it.
 */
export interface OpenbotQuestionServiceShape {
  readonly ask: (input: {
    readonly threadId: ThreadId;
    readonly questions: ReadonlyArray<OpenbotMcpAskQuestion>;
    readonly clientRequestId: string;
  }) => Effect.Effect<OpenbotMcpAskQuestionResult, OpenbotQuestionError>;
}

export class OpenbotQuestionService extends Context.Service<
  OpenbotQuestionService,
  OpenbotQuestionServiceShape
>()("t3/openbot/OpenbotQuestionService") {}

/**
 * The question is keyed by the run it was asked from, so the same
 * `clientRequestId` in a later turn is a new question rather than a silent
 * no-op, while a retry inside one turn returns the request already recorded.
 */
export function openbotQuestionRequestId(input: {
  readonly runId: RunId;
  readonly clientRequestId: string;
}): RuntimeRequestId {
  return RuntimeRequestId.make(
    `runtime-request:openbot:question:${encodeURIComponent(input.runId)}:${encodeURIComponent(
      input.clientRequestId,
    )}`,
  );
}

/** The run the decider will attach to: the newest one still able to resume. */
function askableRun(runs: ReadonlyArray<OrchestrationV2Run>): OrchestrationV2Run | undefined {
  return runs.filter(isActiveRun).toSorted((left, right) => right.ordinal - left.ordinal)[0];
}

/**
 * Options carry a non-empty description in the projection, so an option
 * without one repeats its label; the question UI hides a description equal to
 * its label, which is also how the Codex adapter fills this field.
 */
function toProjectionQuestions(
  questions: ReadonlyArray<OpenbotMcpAskQuestion>,
): ReadonlyArray<OrchestrationV2UserInputQuestion> {
  return questions.map((question, index) => ({
    id: question.id ?? String(index + 1),
    header: question.header,
    question: question.question,
    options: question.options.map((option) => ({
      label: option.label,
      description:
        option.description === undefined || option.description.trim().length === 0
          ? option.label
          : option.description,
    })),
    ...(question.multiSelect === undefined ? {} : { multiSelect: question.multiSelect }),
    ...(question.allowCustomAnswer === undefined
      ? {}
      : { allowCustomAnswer: question.allowCustomAnswer }),
  }));
}

const make = Effect.gen(function* () {
  const threads = yield* ThreadManagementService;

  const ask: OpenbotQuestionServiceShape["ask"] = Effect.fn("OpenbotQuestionService.ask")(
    function* (input) {
      if (input.questions.length === 0 || input.questions.length > OPENBOT_QUESTION_MAX_QUESTIONS) {
        return yield* new OpenbotQuestionError({
          code: "invalid",
          message: `Ask between 1 and ${OPENBOT_QUESTION_MAX_QUESTIONS} questions in one call.`,
        });
      }
      if (
        input.questions.some(
          (question) =>
            question.options.length === 0 || question.options.length > OPENBOT_QUESTION_MAX_OPTIONS,
        )
      ) {
        return yield* new OpenbotQuestionError({
          code: "invalid",
          message: `Give each question between 1 and ${OPENBOT_QUESTION_MAX_OPTIONS} options.`,
        });
      }
      const projection = yield* threads.getThreadProjection(input.threadId).pipe(
        Effect.mapError(
          (cause) =>
            new OpenbotQuestionError({
              code: "operation_failed",
              message: `Unable to load this chat's thread: ${cause.message}`,
            }),
        ),
      );
      const run = askableRun(projection.runs);
      if (run === undefined) {
        return yield* new OpenbotQuestionError({
          code: "no_active_run",
          message: "This thread has no active turn, so there is nothing to ask from right now.",
        });
      }
      const requestId = openbotQuestionRequestId({
        runId: run.id,
        clientRequestId: input.clientRequestId,
      });
      // A retry inside the same turn must not ask twice. The command is also
      // idempotent on its own (its receipt replays), so this is the cheap path
      // rather than the only guard.
      if (projection.runtimeRequests.some((request) => request.id === requestId)) {
        return { requestId, threadId: input.threadId };
      }
      yield* threads
        .dispatch({
          type: "runtime-request.create",
          commandId: CommandId.make(`command:openbot:question:${requestId}`),
          threadId: input.threadId,
          requestId,
          kind: "user_input",
          responseMode: "message",
          questions: toProjectionQuestions(input.questions),
        })
        .pipe(
          Effect.mapError(
            (cause) =>
              new OpenbotQuestionError({
                code: cause._tag === "OrchestratorDispatchError" ? "conflict" : "operation_failed",
                message: `Unable to ask the question: ${cause.message}`,
              }),
          ),
        );
      return { requestId, threadId: input.threadId };
    },
  );

  return OpenbotQuestionService.of({ ask });
});

export const layer: Layer.Layer<OpenbotQuestionService, never, ThreadManagementService> =
  Layer.effect(OpenbotQuestionService, make);

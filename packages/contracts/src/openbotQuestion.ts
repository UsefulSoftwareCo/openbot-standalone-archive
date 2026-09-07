import * as Schema from "effect/Schema";

import { RuntimeRequestId, ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";

/**
 * Structured questions an OpenBot agent asks the person mid-turn.
 *
 * These are recorded as ordinary v2 `user_input` runtime requests in *message
 * response mode*, so they use the same projection, the same pending-request
 * derivation, and the same question UI as a provider's native question tool.
 * The agent never waits: it records the request, ends its turn, and the
 * answer arrives as the next user message.
 */

/** Guardrails so one tool call cannot flood the channel with a survey. */
export const OPENBOT_QUESTION_MAX_QUESTIONS = 5;
export const OPENBOT_QUESTION_MAX_OPTIONS = 8;

export const OpenbotMcpAskQuestionOption = Schema.Struct({
  label: TrimmedNonEmptyString.check(Schema.isMaxLength(120)).annotate({
    description: "Short answer the person can pick, shown as a button.",
  }),
  description: Schema.optional(
    Schema.String.check(Schema.isMaxLength(400)).annotate({
      description: "Optional one-line explanation of what picking this option means.",
    }),
  ),
});
export type OpenbotMcpAskQuestionOption = typeof OpenbotMcpAskQuestionOption.Type;

export const OpenbotMcpAskQuestion = Schema.Struct({
  id: Schema.optional(
    TrimmedNonEmptyString.check(Schema.isMaxLength(64)).annotate({
      description:
        "Stable id for this question. Defaults to its 1-based position, which is enough unless you want to match answers yourself.",
    }),
  ),
  header: TrimmedNonEmptyString.check(Schema.isMaxLength(80)).annotate({
    description: "Two or three words naming what is being decided, shown above the question.",
  }),
  question: TrimmedNonEmptyString.check(Schema.isMaxLength(2_000)).annotate({
    description: "The question itself, in the same voice you use in the channel.",
  }),
  options: Schema.Array(OpenbotMcpAskQuestionOption)
    .check(Schema.isMinLength(1), Schema.isMaxLength(OPENBOT_QUESTION_MAX_OPTIONS))
    .annotate({
      description: `The choices offered, at most ${OPENBOT_QUESTION_MAX_OPTIONS}. Cover the realistic answers; the person can always type their own.`,
    }),
  multiSelect: Schema.optional(
    Schema.Boolean.annotate({
      description: "Set when more than one option can be picked at once. Defaults to false.",
    }),
  ),
  allowCustomAnswer: Schema.optional(
    Schema.Boolean.annotate({
      description:
        "Set to false to hide the free-text field and accept only the listed options. Defaults to true.",
    }),
  ),
});
export type OpenbotMcpAskQuestion = typeof OpenbotMcpAskQuestion.Type;

export const OpenbotMcpAskQuestionInput = Schema.Struct({
  questions: Schema.Array(OpenbotMcpAskQuestion)
    .check(Schema.isMinLength(1), Schema.isMaxLength(OPENBOT_QUESTION_MAX_QUESTIONS))
    .annotate({
      description: `Everything you need decided before you can continue, at most ${OPENBOT_QUESTION_MAX_QUESTIONS} questions. Ask them all in one call rather than one question per turn.`,
    }),
  clientRequestId: TrimmedNonEmptyString.check(Schema.isMaxLength(256)).annotate({
    description:
      "Stable idempotency key. A retry with the same value returns the same requestId instead of asking twice.",
  }),
});
export type OpenbotMcpAskQuestionInput = typeof OpenbotMcpAskQuestionInput.Type;

export const OpenbotMcpAskQuestionResult = Schema.Struct({
  requestId: RuntimeRequestId,
  threadId: ThreadId,
});
export type OpenbotMcpAskQuestionResult = typeof OpenbotMcpAskQuestionResult.Type;

/**
 * `no_active_run` means the caller has no turn to attach the question to,
 * `conflict` means the id is already taken by a different question, and
 * `invalid` covers questions the orchestrator refused to record.
 */
export class OpenbotQuestionError extends Schema.TaggedErrorClass<OpenbotQuestionError>()(
  "OpenbotQuestionError",
  {
    code: Schema.Literals(["no_active_run", "invalid", "conflict", "operation_failed"]),
    message: Schema.String,
  },
) {}

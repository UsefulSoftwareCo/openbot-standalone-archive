import { CommandId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Random from "effect/Random";

/** Random id material. */
function randomToken(): string {
  return Effect.runSync(
    Effect.all([Random.nextInt, Random.nextInt, Random.nextInt, Random.nextInt]),
  ).join("-");
}

/** A command id for one dispatch. Reuse the returned value when retrying. */
export function newCommandId(scope: string): CommandId {
  return CommandId.make(`command:openbot:${scope}:${randomToken()}`);
}

/** One create attempt: the idempotency key and the payload it was sent with. */
export interface CommandAttempt<P> {
  readonly commandId: CommandId;
  readonly payload: P;
}

function samePayload<P extends Record<string, string>>(a: P, b: P): boolean {
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every((key) => a[key] === b[key]);
}

/**
 * The idempotency key for one create. Retrying the same payload replays the
 * same key, so a double-click or a retry after a dropped socket cannot create
 * two records. An edited payload gets a new key: the server refuses to replay
 * a key that already created something different, and without this a form
 * whose first attempt half-succeeded could never be submitted again.
 */
export function commandAttempt<P extends Record<string, string>>(
  previous: CommandAttempt<P> | null,
  scope: string,
  payload: P,
): CommandAttempt<P> {
  return previous !== null && samePayload(previous.payload, payload)
    ? previous
    : { commandId: newCommandId(scope), payload };
}

import { CommandId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Random from "effect/Random";

/**
 * Random id material. Callers keep the value they generated so a retry after a
 * dropped socket replays the same idempotency key instead of duplicating work.
 */
export function randomToken(): string {
  return Effect.runSync(
    Effect.all([Random.nextInt, Random.nextInt, Random.nextInt, Random.nextInt]),
  ).join("-");
}

/** A command id for one dispatch. Reuse the returned value when retrying. */
export function newCommandId(scope: string): CommandId {
  return CommandId.make(`command:openbot:${scope}:${randomToken()}`);
}

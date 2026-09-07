import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";

/** Human-readable text for anything a command can fail with. */
export function errorText(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "object" && error !== null && "message" in error) {
    return String((error as { message: unknown }).message);
  }
  return String(error);
}

/** Text for a failed `useAtomCommand` result. */
export function commandErrorText(result: Parameters<typeof squashAtomCommandFailure>[0]): string {
  return errorText(squashAtomCommandFailure(result));
}

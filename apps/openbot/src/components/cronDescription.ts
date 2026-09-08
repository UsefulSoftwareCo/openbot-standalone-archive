import cronstrue from "cronstrue";

/**
 * Renders a cron expression as English for the routine list and the cron
 * editor preview. Returns undefined for anything we cannot describe, so
 * callers can fall back to the raw expression or an honest placeholder while
 * the user is still typing.
 */
export function describeCron(expression: string): string | undefined {
  const trimmed = expression.trim();
  // cronstrue also speaks 6-field (seconds) cron, but the server only accepts
  // five fields, so describing a sixth would advertise syntax that fails.
  const fields = trimmed.split(/\s+/);
  if (trimmed.length === 0 || fields.length !== 5) return undefined;
  // cronstrue reads a dangling separator ("1-", "9,") as "through undefined"
  // instead of throwing, so each field must be complete tokens.
  if (!fields.every((field) => /^[^,\-/]+([,\-/][^,\-/]+)*$/.test(field))) return undefined;
  try {
    return cronstrue.toString(trimmed, { use24HourTimeFormat: false, verbose: false });
  } catch {
    return undefined;
  }
}

import type { OpenbotChatComputer, OpenbotComputerController } from "@t3tools/contracts";

import type { ComputerStreamConnection, ComputerStreamState } from "./computerStream";

/**
 * How a chat's computer reads to a human.
 *
 * All of it is a pure function of what the server pushes, so the rail card and
 * the expanded page cannot drift into saying different things about the same
 * screen. The rule everywhere is that the text is either actionable or honest
 * about not knowing: the server only calls a chat's computer `ready` once its
 * display exists, and nothing here upgrades that.
 */

const STATE_LABEL: Record<OpenbotChatComputer["state"], string> = {
  idle: "Not started",
  provisioning: "Setting up",
  ready: "Live",
  unavailable: "Unavailable",
};

const DOT_CLASS: Record<OpenbotChatComputer["state"], string> = {
  idle: "bg-muted-foreground",
  provisioning: "bg-muted-foreground",
  ready: "bg-success",
  unavailable: "bg-warning",
};

export interface ChatComputerView {
  readonly statusLabel: string;
  readonly dotClass: string;
  /** The one line to show where the screen would be, when there is no screen. */
  readonly placeholder: string | null;
  /** Whether asking the host for frames is worth doing at all. */
  readonly canStream: boolean;
}

/** "Groceries's screen" is worse than "this chat's screen"; an unnamed chat gets the latter. */
function screenOf(computer: OpenbotChatComputer): string {
  const name = computer.channelName.trim();
  return name.length === 0 ? "this chat's screen" : `${name}'s screen`;
}

/**
 * The card and page header's reading of one chat computer. A display is what
 * makes frames possible, so `canStream` follows the display and not the state
 * word: a `ready` answer without one is still nothing to look at.
 */
export function chatComputerView(input: {
  readonly computer: OpenbotChatComputer | null;
  readonly error: string | null;
}): ChatComputerView {
  const { computer, error } = input;
  if (computer === null) {
    return error === null
      ? {
          statusLabel: "Checking…",
          dotClass: "bg-muted-foreground",
          placeholder: null,
          canStream: false,
        }
      : {
          statusLabel: "Unreachable",
          dotClass: "bg-warning",
          placeholder: error,
          canStream: false,
        };
  }
  const base = { statusLabel: STATE_LABEL[computer.state], dotClass: DOT_CLASS[computer.state] };
  switch (computer.state) {
    case "idle":
    case "provisioning":
      return { ...base, placeholder: `Setting up ${screenOf(computer)}…`, canStream: false };
    case "unavailable":
      return {
        ...base,
        placeholder: computer.detail ?? `${screenOf(computer)} is not available right now.`,
        canStream: false,
      };
    case "ready":
      return computer.display === null
        ? {
            ...base,
            placeholder: computer.detail ?? `Waiting for ${screenOf(computer)}…`,
            canStream: false,
          }
        : { ...base, placeholder: computer.detail, canStream: true };
  }
}

/**
 * Who holds the input lease, said out loud. Agents share this session, so a
 * viewer who is not controlling still has to know something else is typing.
 */
export function controllerBadge(
  controller: OpenbotComputerController | null,
  controlling: boolean,
): string | null {
  if (controlling) return "You're controlling";
  if (controller === null) return null;
  return controller.kind === "agent" ? "Agent input active" : `${controller.label} is controlling`;
}

export type ComputerBannerTone = "info" | "warning";

export interface ComputerBanner {
  readonly text: string;
  readonly tone: ComputerBannerTone;
}

/**
 * What to say over the stage. A terminal answer from the server outranks the
 * socket's own state: "another viewer took over" is the truth even though what
 * the browser noticed was a closed socket.
 */
export function streamBanner(input: {
  readonly connection: ComputerStreamConnection;
  readonly status: ComputerStreamState["status"];
  readonly message: string | null;
  readonly hasFrame: boolean;
}): ComputerBanner | null {
  const { connection, status, message, hasFrame } = input;
  switch (status) {
    case "superseded":
      return { text: message ?? "Another viewer took over this screen.", tone: "warning" };
    case "display-gone":
      return { text: message ?? "This chat's screen is gone.", tone: "warning" };
    case "permission-denied":
      return {
        text: message ?? "The host refused screen capture. Grant Screen Recording and try again.",
        tone: "warning",
      };
    case "error":
      return { text: message ?? "The stream from this screen failed.", tone: "warning" };
    case "idle":
      return { text: message ?? "Waiting for the host to start capturing…", tone: "info" };
    case "closing":
      return { text: message ?? "Closing this stream…", tone: "info" };
    case "capturing":
    case null:
      break;
  }
  if (connection === "reconnecting") {
    return { text: "Reconnecting to this screen…", tone: "warning" };
  }
  if ((connection === "connecting" || connection === "open") && !hasFrame) {
    return { text: "Connecting to this screen…", tone: "info" };
  }
  if (connection === "closed" && !hasFrame) {
    return { text: "This stream is closed.", tone: "info" };
  }
  return null;
}

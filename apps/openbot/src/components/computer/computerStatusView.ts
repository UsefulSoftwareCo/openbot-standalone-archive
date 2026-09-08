import type {
  OpenbotComputerAvailability,
  OpenbotComputerController,
  OpenbotComputerDisplay,
  OpenbotComputerPermissions,
  OpenbotComputerSessionKind,
  OpenbotComputerSetup,
  OpenbotComputerStatus,
} from "@t3tools/contracts";

import type { ComputerStreamConnection, ComputerStreamState } from "./computerStream";

/**
 * How the computer's state reads to a human.
 *
 * All of it is a pure function of the status the server pushes, so the card,
 * the page and the banners cannot drift into saying different things about the
 * same host. The rule everywhere is that the text is either actionable or
 * honest about not knowing: the server only calls a host `ready` once a
 * capture has actually succeeded there, and nothing here upgrades that.
 */

export const PLATFORM_LABELS: Record<OpenbotComputerStatus["host"]["platform"], string> = {
  darwin: "macOS",
  linux: "Linux",
  windows: "Windows",
  unknown: "Unknown platform",
};

/** What kind of desktop this is, in the product's words. */
export function sessionLabel(session: OpenbotComputerSessionKind): string {
  switch (session) {
    case "signed-in-desktop":
      return "Shared desktop";
    case "shared-x11-desktop":
      return "Shared X11 desktop";
    case "managed-x11-session":
      return "Managed X session";
    case "unsupported":
      return "Unsupported";
  }
}

const DOT_CLASS: Record<OpenbotComputerAvailability, string> = {
  ready: "bg-success",
  unknown: "bg-muted-foreground",
  unavailable: "bg-warning",
  unsupported: "bg-muted-foreground",
};

const AVAILABILITY_LABEL: Record<OpenbotComputerAvailability, string> = {
  ready: "Ready",
  unknown: "Not checked",
  unavailable: "Unavailable",
  unsupported: "Unsupported",
};

/** "2 displays". */
export function displayCountLabel(displays: ReadonlyArray<OpenbotComputerDisplay>): string {
  return `${displays.length} display${displays.length === 1 ? "" : "s"}`;
}

/** "2 displays · 5120×2880", or the count alone when no size is known. */
export function displaySummary(displays: ReadonlyArray<OpenbotComputerDisplay>): string {
  if (displays.length === 0) return "No displays";
  const count = displayCountLabel(displays);
  const primary = displays.find((display) => display.main) ?? displays[0];
  if (primary === undefined) return count;
  return `${count} · ${primary.widthPx}×${primary.heightPx}`;
}

/** One display's own line in a picker: "Built-in Retina Display · 3456×2234". */
export function displayOptionLabel(display: OpenbotComputerDisplay): string {
  return `${display.name} · ${display.widthPx}×${display.heightPx}`;
}

/**
 * Which grant is missing, named the way the system settings name it. Only a
 * refusal is reported: "unknown" is not something the user can act on.
 */
export function permissionSummary(permissions: OpenbotComputerPermissions): string | null {
  const missing: Array<string> = [];
  if (permissions.screenCapture === "denied") missing.push("Screen Recording");
  if (permissions.accessibility === "denied") missing.push("Accessibility");
  if (missing.length === 0) return null;
  return `${missing.join(" and ")} not granted`;
}

/** What the host is missing, with the tools named so the fix is obvious. */
export function setupSummary(setup: OpenbotComputerSetup | null): string | null {
  if (setup === null || setup.ready) return null;
  const missing = setup.dependencies
    .filter((dependency) => !dependency.present)
    .map((dependency) => dependency.name);
  if (missing.length > 0) return `Setup needed: install ${missing.join(", ")}`;
  return setup.notes[0] ?? "Setup needed on the host.";
}

export interface ComputerStatusView {
  readonly statusLabel: string;
  readonly dotClass: string;
  /** The single most useful thing to say about why this is not usable, if anything. */
  readonly reason: string | null;
  /** Whether asking the host for frames is worth doing at all. */
  readonly canStream: boolean;
}

/**
 * The card and page header's reading of one status. `canStream` is
 * deliberately optimistic about `unknown` and `unavailable` hosts whose
 * permissions and setup are fine: an attempt is the only evidence either way,
 * and the server reports what it learns from it.
 */
export function computerStatusView(input: {
  readonly status: OpenbotComputerStatus | null;
  readonly statusError: string | null;
}): ComputerStatusView {
  const { status, statusError } = input;
  if (status === null) {
    return statusError === null
      ? {
          statusLabel: "Checking…",
          dotClass: "bg-muted-foreground",
          reason: null,
          canStream: false,
        }
      : {
          statusLabel: "Unreachable",
          dotClass: "bg-warning",
          reason: statusError,
          canStream: false,
        };
  }
  const permissions = permissionSummary(status.permissions);
  const setup = setupSummary(status.setup);
  const reason =
    status.availability === "unsupported"
      ? (status.detail ?? "This host has no desktop T3 can share.")
      : (permissions ?? setup ?? status.detail);
  return {
    statusLabel: AVAILABILITY_LABEL[status.availability],
    dotClass: DOT_CLASS[status.availability],
    reason,
    canStream:
      status.availability !== "unsupported" &&
      status.capabilities.stream &&
      permissions === null &&
      setup === null &&
      status.displays.length > 0,
  };
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
      return { text: message ?? "Another viewer took over this display.", tone: "warning" };
    case "display-gone":
      return { text: message ?? "That display is no longer connected.", tone: "warning" };
    case "permission-denied":
      return {
        text: message ?? "The host refused screen capture. Grant Screen Recording and try again.",
        tone: "warning",
      };
    case "error":
      return { text: message ?? "The host's screen stream failed.", tone: "warning" };
    case "idle":
      return { text: message ?? "Waiting for the host to start capturing…", tone: "info" };
    case "closing":
      return { text: message ?? "Closing this stream…", tone: "info" };
    case "capturing":
    case null:
      break;
  }
  if (connection === "reconnecting") {
    return { text: "Reconnecting to the host's screen…", tone: "warning" };
  }
  if ((connection === "connecting" || connection === "open") && !hasFrame) {
    return { text: "Connecting to the host's screen…", tone: "info" };
  }
  if (connection === "closed" && !hasFrame) {
    return { text: "This stream is closed.", tone: "info" };
  }
  return null;
}

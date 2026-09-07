import type {
  ProviderApprovalDecision,
  ProviderApprovalOption,
  ProviderRequestKind,
  RuntimeRequestId,
} from "@t3tools/contracts";
import { memo } from "react";
import { TriangleAlertIcon } from "lucide-react";

import { Button } from "./button.tsx";
import { cn } from "./cn.ts";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./tooltip.tsx";

/**
 * The approval a provider is waiting on. Clients pass their own pending-request
 * record; only these fields are read, so a thread projection and an OpenBot
 * channel view both fit without conversion.
 */
export interface PendingApprovalSummary {
  readonly requestId: RuntimeRequestId;
  readonly requestKind: ProviderRequestKind;
  /** Unread here; accepted so a client can pass its pending record whole. */
  readonly createdAt?: string | undefined;
  readonly detail?: string | undefined;
  /** App requesting access for mcp-elicitation approvals. */
  readonly appName?: string | undefined;
  /** Approval choices advertised by the provider; defaults apply when absent. */
  readonly options?: ReadonlyArray<ProviderApprovalOption> | undefined;
  readonly responseCapability: "live" | "not_resumable";
}

interface PendingApprovalPanelProps {
  approval: PendingApprovalSummary;
  pendingCount: number;
  className?: string;
}

export const PendingApprovalPanel = memo(function PendingApprovalPanel({
  approval,
  pendingCount,
  className,
}: PendingApprovalPanelProps) {
  const fallbackLabel =
    approval.requestKind === "mcp-elicitation"
      ? "App access approval"
      : approval.requestKind === "command"
        ? "Command approval"
        : approval.requestKind === "file-read"
          ? "File read approval"
          : "File change approval";
  const detailAriaLabel =
    approval.requestKind === "mcp-elicitation"
      ? "App access request"
      : approval.requestKind === "command"
        ? "Command"
        : approval.requestKind === "file-read"
          ? "File to read"
          : "File change";

  return (
    <span
      aria-label={fallbackLabel}
      className={cn("flex min-w-0 flex-1 items-center gap-2", className)}
      role="group"
    >
      {approval.appName ? (
        <span className="max-w-32 shrink truncate text-[11px] font-medium text-foreground">
          {approval.appName}
        </span>
      ) : null}
      <code
        aria-label={detailAriaLabel}
        className="block max-h-20 min-w-0 flex-1 overflow-auto whitespace-pre font-mono text-[11px] text-foreground/85 [scrollbar-width:thin] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/70 [&::-webkit-scrollbar]:h-1.5"
        data-approval-detail="complete"
        tabIndex={0}
      >
        {approval.responseCapability === "not_resumable"
          ? "Provider process is gone — interrupt or restart the run to respond."
          : approval.detail || fallbackLabel}
      </code>
      {pendingCount > 1 ? (
        <span className="shrink-0 text-[10px] font-medium text-muted-foreground tabular-nums">
          1/{pendingCount}
        </span>
      ) : null}
    </span>
  );
});

interface PendingApprovalActionsProps {
  requestId: RuntimeRequestId;
  isResponding: boolean;
  canRespond: boolean;
  options?: ReadonlyArray<ProviderApprovalOption> | undefined;
  onRespondToApproval: (
    requestId: RuntimeRequestId,
    decision: ProviderApprovalDecision,
  ) => Promise<unknown>;
}

const APPROVAL_ACTION_CLASS_NAME = "font-normal";
const DEFAULT_APPROVAL_OPTIONS = [
  { decision: "cancel", label: "Cancel" },
  { decision: "decline", label: "Decline" },
  { decision: "acceptForSession", label: "Always allow this session" },
  { decision: "accept", label: "Approve" },
] satisfies ReadonlyArray<ProviderApprovalOption>;

export const PendingApprovalActions = memo(function PendingApprovalActions({
  requestId,
  isResponding,
  canRespond,
  options = DEFAULT_APPROVAL_OPTIONS,
  onRespondToApproval,
}: PendingApprovalActionsProps) {
  return (
    <>
      {options.map((option) => {
        const button = (
          <Button
            key={option.decision}
            size="micro"
            variant="ghost-muted"
            className={`${APPROVAL_ACTION_CLASS_NAME}${
              option.decision === "decline"
                ? " text-destructive-foreground [:hover,[data-pressed]]:text-destructive-foreground"
                : option.decision === "accept"
                  ? " text-foreground"
                  : option.warning
                    ? " text-warning"
                    : ""
            }`}
            disabled={isResponding || !canRespond}
            aria-description={option.warning}
            onClick={() => void onRespondToApproval(requestId, option.decision)}
          >
            {option.warning ? <TriangleAlertIcon className="size-3 shrink-0" /> : null}
            <span className="max-w-40 truncate">{option.label}</span>
          </Button>
        );
        // A provider caution, such as a prompt injection warning on "allow
        // always", rides along as a tooltip so the row stays one line.
        return option.warning ? (
          <Tooltip key={option.decision}>
            <TooltipTrigger render={button} />
            <TooltipPopup side="top" className="max-w-72 text-xs leading-snug">
              {option.warning}
            </TooltipPopup>
          </Tooltip>
        ) : (
          button
        );
      })}
    </>
  );
});

import { useState, useEffect, type ReactNode } from "react";
import { Check, Clock, MoreHorizontal } from "lucide-react";
import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import { canSnooze, effectiveSnoozed } from "@t3tools/client-runtime/state/thread-settled";
import type { EnvironmentId, OpenbotChannel } from "@t3tools/contracts";
import { Button } from "@t3tools/ui/button";
import { buildThreadActionMenuItems } from "../../../web/src/components/threadActionMenu.logic";
import { SnoozePopoverButton } from "../../../web/src/components/Sidebar";
import { resolveSnoozePresets } from "../../../web/src/components/Sidebar.snooze";
import { useThreadActions } from "../../../web/src/hooks/useThreadActions";
import { useEnvironmentSettings } from "../../../web/src/hooks/useSettings";
import { ensureLocalApi } from "../../../web/src/localApi";
import {
  readEnvironmentSupportsSettlement,
  readEnvironmentSupportsSnooze,
  useThreadShell,
} from "../../../web/src/state/entities";
import { toastManager } from "../../../web/src/components/ui/toast";
import { usePrimaryEnvironmentId } from "../state/channels";
import { commandErrorText } from "../state/errors";
import { useSnoozeActive } from "./ChatHeader";

import {
  hasUnseenCompletion,
  resolveSidebarThreadStatus,
} from "../../../web/src/components/Sidebar.logic";
import { useUiStateStore } from "../../../web/src/uiStateStore";

type Props = {
  readonly isActive: boolean;
  readonly channel: OpenbotChannel;
  readonly onDelete: (channel: OpenbotChannel) => void;
  readonly children: ReactNode;
};

export function ChatSidebarRow(props: Props) {
  const environmentId = usePrimaryEnvironmentId();
  return environmentId === null ? (
    <div className="openbot-row">{props.children}</div>
  ) : (
    <ConnectedChatSidebarRow {...props} environmentId={environmentId} />
  );
}

function ConnectedChatSidebarRow({
  channel,
  isActive,
  onDelete,
  children,
  environmentId,
}: Props & { readonly environmentId: EnvironmentId }) {
  const ref = scopeThreadRef(environmentId, channel.threadId);
  const thread = useThreadShell(ref);
  const threadKey = scopedThreadKey(ref);
  const lastVisitedAt = useUiStateStore((state) => state.threadLastVisitedAtById[threadKey]);
  const markVisited = useUiStateStore((state) => state.markThreadVisited);
  const completedAt = thread?.latestRun?.completedAt;
  useEffect(() => {
    if (isActive) markVisited(threadKey, new Date().toISOString());
  }, [isActive, threadKey, completedAt, markVisited]);
  const status = thread === null ? "ready" : resolveSidebarThreadStatus(thread);
  const unread = !isActive && thread !== null && hasUnseenCompletion({ ...thread, lastVisitedAt });
  const activityLabel =
    status === "approval" || status === "input"
      ? "Needs your attention"
      : status === "working"
        ? "Working"
        : status === "failed"
          ? "Run failed"
          : unread
            ? "Unread result"
            : null;
  const actions = useThreadActions();
  const timestampFormat = useEnvironmentSettings(
    environmentId,
    (settings) => settings.timestampFormat,
  );
  const [busy, setBusy] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [snoozeOpen, setSnoozeOpen] = useState(false);
  const snoozeActive = useSnoozeActive(thread?.snoozedUntil ?? null);
  const snoozed =
    snoozeActive && thread !== null && effectiveSnoozed(thread, { now: new Date().toISOString() });
  const settled = thread?.settledOverride === "settled";

  const runAction = async (action: "settle" | "unsettle" | "unsnooze" | { until: string }) => {
    if (busy) return;
    setBusy(true);
    try {
      const result =
        typeof action === "object"
          ? await actions.snoozeThread(ref, action.until)
          : action === "settle"
            ? await actions.settleThread(ref)
            : action === "unsettle"
              ? await actions.unsettleThread(ref)
              : await actions.unsnoozeThread(ref);
      if (result._tag === "Failure")
        toastManager.add({
          type: "error",
          title: "Could not update chat",
          description: commandErrorText(result),
        });
    } catch (error) {
      toastManager.add({
        type: "error",
        title: "Could not update chat",
        description: error instanceof Error ? error.message : "Try again.",
      });
    } finally {
      setBusy(false);
    }
  };

  const openMenu = async (position: { x: number; y: number }) => {
    if (busy || thread === null) return;
    setMenuOpen(true);
    try {
      const presets = resolveSnoozePresets(new Date(), timestampFormat);
      const items = buildThreadActionMenuItems({
        branch: null,
        isPinned: false,
        isSettled: settled,
        isSnoozed: snoozed,
        canSnoozeNow: canSnooze(thread, { now: new Date().toISOString() }),
        isRegeneratingTitle: false,
        isRunning: thread.runtime?.status === "running",
        supports: {
          settlement: readEnvironmentSupportsSettlement(environmentId),
          snooze: readEnvironmentSupportsSnooze(environmentId),
          pinning: false,
          titleRegeneration: false,
        },
        snoozePresets: presets,
      }).filter((item) => ["settle", "unsettle", "snooze", "unsnooze", "delete"].includes(item.id));
      const choice = await ensureLocalApi().contextMenu.show(items, position);
      if (choice === "delete") {
        onDelete(channel);
        return;
      }
      const preset = presets.find((item) => `snooze:${item.id}` === choice);
      if (preset) await runAction({ until: preset.snoozedUntil });
      else if (choice === "settle" || choice === "unsettle" || choice === "unsnooze")
        await runAction(choice);
    } catch (error) {
      toastManager.add({
        type: "error",
        title: "Could not open chat options",
        description: error instanceof Error ? error.message : "Try again.",
      });
    } finally {
      setBusy(false);
      setMenuOpen(false);
    }
  };

  return (
    <div
      className="openbot-row"
      data-menu-open={menuOpen || snoozeOpen || undefined}
      onKeyDown={(event) => {
        if (event.key === "ContextMenu" || (event.shiftKey && event.key === "F10")) {
          event.preventDefault();
          const box = event.currentTarget.getBoundingClientRect();
          void openMenu({ x: box.right, y: box.bottom });
        }
      }}
      onContextMenu={(event) => {
        event.preventDefault();
        event.stopPropagation();
        void openMenu({ x: event.clientX, y: event.clientY });
      }}
    >
      {children}
      {activityLabel !== null && (
        <span
          role="status"
          aria-label={activityLabel}
          title={activityLabel}
          className="openbot-row-activity pointer-events-none absolute right-3 top-1/2 -translate-y-1/2"
        >
          <span
            className={`block size-1.5 rounded-full ${status === "failed" ? "bg-error-foreground" : status === "approval" || status === "input" ? "bg-amber-500" : "bg-primary"}`}
          />
        </span>
      )}
      <div className="openbot-row-settings flex h-6 items-center rounded-md bg-sidebar">
        {thread !== null &&
          readEnvironmentSupportsSnooze(environmentId) &&
          (snoozed ? (
            <Button
              variant="ghost"
              size="icon-xs"
              aria-label={`Wake ${channel.name}`}
              title="Wake thread"
              disabled={busy}
              onClick={() => void runAction("unsnooze")}
            >
              <Clock />
            </Button>
          ) : !busy && canSnooze(thread, { now: new Date().toISOString() }) ? (
            <SnoozePopoverButton
              open={snoozeOpen}
              onOpenChange={setSnoozeOpen}
              timestampFormat={timestampFormat}
              onSnooze={(preset) => void runAction({ until: preset.snoozedUntil })}
            />
          ) : null)}
        {thread !== null && readEnvironmentSupportsSettlement(environmentId) && (
          <Button
            variant="ghost"
            size="xs"
            className="gap-1 px-1.5 text-muted-foreground"
            aria-label={`${settled ? "Un-settle" : "Settle"} ${channel.name}`}
            title={settled ? "Un-settle thread" : "Settle thread"}
            disabled={busy}
            onClick={() => void runAction(settled ? "unsettle" : "settle")}
          >
            <Check className="size-3.5" />
            {settled ? "Un-settle" : "Settle"}
          </Button>
        )}
        <Button
          variant="ghost"
          size="icon-xs"
          aria-label={`Options for ${channel.name}`}
          title="Thread options"
          disabled={busy}
          onClick={(event) => {
            const box = event.currentTarget.getBoundingClientRect();
            void openMenu({ x: box.right, y: box.bottom });
          }}
        >
          <MoreHorizontal />
        </Button>
      </div>
    </div>
  );
}

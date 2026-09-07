import { Button } from "@t3tools/ui/button";
import { cn } from "@t3tools/ui/cn";
import { ScrollArea } from "@t3tools/ui/scroll-area";
import type { OpenbotChannel, OpenbotChannelId } from "@t3tools/contracts";
import { BotAvatar } from "./BotProfileFields";
import { Plus } from "lucide-react";

export function ChannelSidebar({
  channels,
  selectedChannelId,
  onSelect,
  onCreate,
  connectionLabel,
}: {
  readonly channels: ReadonlyArray<OpenbotChannel>;
  readonly selectedChannelId: OpenbotChannelId | null;
  readonly onSelect: (channelId: OpenbotChannelId) => void;
  readonly onCreate: () => void;
  readonly connectionLabel: string | null;
}) {
  return (
    <aside
      data-app-sidebar
      className="flex h-full w-60 shrink-0 flex-col border-r border-sidebar-border bg-sidebar text-sidebar-foreground"
      aria-label="Channels"
    >
      <div className="flex items-center gap-2 px-3 pt-3 pb-2">
        <span className="grid size-6 place-items-center rounded-md bg-primary font-semibold text-primary-foreground text-xs">
          o
        </span>
        <span className="font-semibold text-sm tracking-tight">OpenBot</span>
      </div>
      <div className="flex items-center justify-between px-3 pt-2 pb-1">
        <span className="font-medium text-[11px] text-sidebar-muted-foreground uppercase tracking-wide">
          Channels
        </span>
        <Button
          size="icon"
          className="size-11 md:size-7"
          variant="ghost-muted"
          aria-label="New bot"
          onClick={onCreate}
        >
          <Plus />
        </Button>
      </div>
      <ScrollArea className="min-h-0 flex-1">
        <nav className="flex flex-col gap-0.5 px-2 pb-2">
          {channels.length === 0 ? (
            <p className="px-2 py-3 text-sidebar-muted-foreground text-xs leading-relaxed">
              No channels yet. Create one to start a conversation.
            </p>
          ) : (
            channels.map((channel) => {
              const selected = channel.id === selectedChannelId;
              return (
                <button
                  key={channel.id}
                  type="button"
                  onClick={() => onSelect(channel.id)}
                  aria-current={selected ? "page" : undefined}
                  className={cn(
                    "flex min-h-11 w-full items-center gap-2 md:min-h-0 md:gap-1.5 rounded-md px-2 py-1.5 text-left text-sm transition-colors",
                    selected
                      ? "bg-sidebar-row-selected text-foreground shadow-xs/5"
                      : "text-sidebar-foreground/85 hover:bg-sidebar-row-hover hover:text-foreground",
                  )}
                >
                  <BotAvatar avatar={channel.avatar} name={channel.name} />
                  <span className="truncate">{channel.name}</span>
                </button>
              );
            })
          )}
        </nav>
      </ScrollArea>
      <div className="border-t border-sidebar-border px-3 py-2 text-[11px] text-sidebar-muted-foreground">
        {connectionLabel ?? "Connecting…"}
      </div>
    </aside>
  );
}

import type { ComponentProps } from "react";
import { cn } from "./cn";

/** Shared user-message surface; each client supplies its text, attachments, and actions. */
export function UserMessageBubble({ className, ...props }: ComponentProps<"div">) {
  return (
    <div className={cn("relative max-w-[80%] rounded-2xl bg-accent p-3", className)} {...props} />
  );
}

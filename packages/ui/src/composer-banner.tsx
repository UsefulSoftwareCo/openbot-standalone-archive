import { mergeProps } from "@base-ui/react/merge-props";
import { useRender } from "@base-ui/react/use-render";
import { ChevronDownIcon } from "lucide-react";
import type { ComponentProps } from "react";

import { buttonVariants } from "./button.tsx";
import { cn } from "./cn.ts";

/**
 * The banner row primitives shared by every client that renders a pending
 * request above its composer. A host supplies the surface around them and the
 * `--composer-banner-icon-column` length the grid is measured against; T3 web
 * sets both from its own richer composer banner.
 */

/** The same row can be a status, a list item, or an entire disclosure button. */
function Row({
  className,
  render,
  layout = "inline",
  ...props
}: useRender.ComponentProps<"div"> & {
  layout?: "inline" | "wrap-actions" | "wrap-actions-narrow";
}) {
  const rowProps = {
    className: cn(
      "group/banner-row grid min-h-(--composer-banner-icon-column) w-full min-w-0 grid-cols-[var(--composer-banner-icon-column)_minmax(0,1fr)_auto] items-center gap-x-1 text-start",
      "not-has-[>[data-slot=composer-banner-actions]]:grid-cols-[var(--composer-banner-icon-column)_minmax(0,1fr)]",
      "[&:is(button)]:cursor-pointer [&:is(button)]:rounded-[0.5rem] [&:is(button)]:focus-visible:outline-2 [&:is(button)]:focus-visible:-outline-offset-2 [&:is(button)]:focus-visible:outline-ring",
      layout === "wrap-actions" &&
        "@max-[400px]:*:data-[slot=composer-banner-content]:min-h-(--composer-banner-icon-column)",
      layout === "wrap-actions-narrow" &&
        "@max-[320px]:*:data-[slot=composer-banner-content]:min-h-(--composer-banner-icon-column)",
      className,
    ),
    "data-composer-banner-row": "true",
    "data-composer-banner-layout": layout,
  };
  return useRender({
    defaultTagName: "div",
    render,
    props: mergeProps<"div">(rowProps, props),
  });
}

function Icon({ className, ...props }: ComponentProps<"span">) {
  return (
    <span
      aria-hidden
      data-slot="composer-banner-icon"
      className={cn(
        "col-start-1 row-start-1 flex w-(--composer-banner-icon-column) min-w-0 flex-none items-center justify-center text-muted-foreground [&>svg]:size-3",
        className,
      )}
      {...props}
    />
  );
}

function Content({ className, ...props }: ComponentProps<"span">) {
  return (
    <span
      data-slot="composer-banner-content"
      className={cn(
        "col-start-2 row-start-1 flex min-w-0 items-center gap-1 *:data-[slot=composer-banner-separator]:mx-0",
        "group-not-has-[>[data-slot=composer-banner-icon]]/banner-row:col-[1/3] group-not-has-[>[data-slot=composer-banner-icon]]/banner-row:ps-2 sm:group-not-has-[>[data-slot=composer-banner-icon]]/banner-row:ps-1.5",
        "group-not-has-[>[data-slot=composer-banner-icon],>[data-slot=composer-banner-actions]]/banner-row:pe-2 sm:group-not-has-[>[data-slot=composer-banner-icon],>[data-slot=composer-banner-actions]]/banner-row:pe-1.5",
        className,
      )}
      {...props}
    />
  );
}

function Actions({ className, ...props }: ComponentProps<"span">) {
  return (
    <span
      data-slot="composer-banner-actions"
      className={cn(
        "col-start-3 row-start-1 flex flex-wrap items-center justify-end gap-1",
        "@max-[400px]:group-data-[composer-banner-layout=wrap-actions]/banner-row:has-[>:nth-child(2)]:col-start-2 @max-[400px]:group-data-[composer-banner-layout=wrap-actions]/banner-row:has-[>:nth-child(2)]:col-end-4 @max-[400px]:group-data-[composer-banner-layout=wrap-actions]/banner-row:has-[>:nth-child(2)]:row-start-2 @max-[400px]:group-data-[composer-banner-layout=wrap-actions]/banner-row:has-[>:nth-child(2)]:-ms-2 @max-[400px]:group-data-[composer-banner-layout=wrap-actions]/banner-row:has-[>:nth-child(2)]:justify-start",
        "@max-[320px]:group-data-[composer-banner-layout=wrap-actions-narrow]/banner-row:has-[>:nth-child(2)]:col-start-2 @max-[320px]:group-data-[composer-banner-layout=wrap-actions-narrow]/banner-row:has-[>:nth-child(2)]:col-end-4 @max-[320px]:group-data-[composer-banner-layout=wrap-actions-narrow]/banner-row:has-[>:nth-child(2)]:row-start-2 @max-[320px]:group-data-[composer-banner-layout=wrap-actions-narrow]/banner-row:has-[>:nth-child(2)]:-ms-2 @max-[320px]:group-data-[composer-banner-layout=wrap-actions-narrow]/banner-row:has-[>:nth-child(2)]:justify-start",
        className,
      )}
      {...props}
    />
  );
}

function Body({ className, ...props }: ComponentProps<"div">) {
  return (
    <div
      className={cn(
        "min-w-0 ps-[calc(var(--composer-banner-icon-column)+(--spacing(1)))]",
        className,
      )}
      {...props}
    />
  );
}

function ToggleIcon({ expanded, className }: { expanded: boolean; className?: string }) {
  return (
    <span
      aria-hidden
      className={cn(
        buttonVariants({ size: "icon-xs", variant: "ghost" }),
        "pointer-events-none",
        className,
      )}
    >
      <ChevronDownIcon className={cn("size-3.5", !expanded && "rotate-180")} />
    </span>
  );
}

export const ComposerBanner = { Row, Icon, Content, Actions, Body, ToggleIcon };

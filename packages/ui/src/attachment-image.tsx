import { useState, type ReactNode } from "react";
import { Dialog, DialogPopup, DialogTitle } from "./dialog";
import { cn } from "./cn";

/** Shared T3 attachment image surface. The caller owns thumbnail size, overlays, and the expanded viewer. */
export function AttachmentImage({
  src,
  name,
  onPreview,
  className,
  variant = "fill",
  children,
}: {
  readonly src: string | null | undefined;
  readonly name: string;
  readonly onPreview?: () => void;
  readonly variant?: "fill" | "draft" | "message";
  readonly children?: ReactNode;
  readonly className?: string;
}) {
  const [failedSrc, setFailedSrc] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const image =
    !src || failedSrc === src ? (
      <span className="flex h-full min-h-12 w-full items-center justify-center px-1 text-center text-[10px] text-muted-foreground">
        {src ? `Preview unavailable: ${name}` : name}
      </span>
    ) : (
      <button
        type="button"
        className={cn("block h-full w-full cursor-zoom-in", className)}
        aria-label={`Preview ${name}`}
        onClick={onPreview ?? (() => setOpen(true))}
      >
        <img
          src={src}
          alt={name}
          className="block size-full object-cover"
          onError={() => setFailedSrc(src)}
        />
      </button>
    );
  return (
    <>
      {variant === "fill" ? (
        image
      ) : (
        <span
          className={
            variant === "draft"
              ? "relative block size-16 shrink-0 overflow-hidden rounded-lg border border-border/80 bg-background"
              : "relative block aspect-[4/3] w-52 max-w-full overflow-hidden rounded-lg border border-border/80 bg-background/70"
          }
        >
          {image}
          {children}
        </span>
      )}
      {onPreview === undefined && (
        <Dialog open={open} onOpenChange={setOpen}>
          <DialogPopup
            className="w-auto max-w-[92vw] overflow-hidden p-3"
            bottomStickOnMobile={false}
          >
            <DialogTitle className="pr-8 text-sm">{name}</DialogTitle>
            {src && (
              <img src={src} alt={name} className="mt-3 max-h-[78dvh] max-w-full object-contain" />
            )}
          </DialogPopup>
        </Dialog>
      )}
    </>
  );
}

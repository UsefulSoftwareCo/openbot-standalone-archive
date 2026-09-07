import { X } from "lucide-react";
import { useEffect, useState } from "react";
import { AttachmentImage } from "@t3tools/ui/attachment-image";

/** Owns and releases the local object URL for one selected file. */
export function DraftAttachment({
  file,
  disabled,
  onRemove,
}: {
  readonly file: File;
  readonly disabled: boolean;
  readonly onRemove: () => void;
}) {
  const [src, setSrc] = useState<string | null>(null);
  useEffect(() => {
    if (!file.type.startsWith("image/")) return;
    const url = URL.createObjectURL(file);
    setSrc(url);
    return () => URL.revokeObjectURL(url);
  }, [file]);
  const remove = (
    <button
      type="button"
      disabled={disabled}
      aria-label={`Remove ${file.name}`}
      onClick={onRemove}
      className={
        file.type.startsWith("image/")
          ? "absolute right-1 top-1 grid size-5 place-items-center rounded bg-background/80 hover:bg-background/90"
          : "grid size-5 place-items-center"
      }
    >
      <X className="size-4" />
    </button>
  );
  return file.type.startsWith("image/") ? (
    <AttachmentImage variant="draft" src={src} name={file.name}>
      {remove}
    </AttachmentImage>
  ) : (
    <span className="inline-flex max-w-full items-center gap-1 rounded-md border border-border px-2 py-1 text-xs">
      <span className="truncate">{file.name}</span>
      {remove}
    </span>
  );
}

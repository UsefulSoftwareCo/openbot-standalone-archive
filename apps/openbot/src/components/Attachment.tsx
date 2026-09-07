import { AttachmentImage } from "@t3tools/ui/attachment-image";
import { useAtomValue } from "@effect/atom-react";
import type { ChatAttachment, EnvironmentId } from "@t3tools/contracts";
import { formatAttachmentSize } from "@t3tools/client-runtime/state/attachments";
import { Download } from "lucide-react";
import { assetEnvironment } from "../state/channels";

/** Displays a stored attachment using renewable, environment-issued asset URLs. */
export function Attachment({
  attachment,
  environmentId,
}: {
  readonly attachment: ChatAttachment;
  readonly environmentId: EnvironmentId;
}) {
  const result = useAtomValue(
    assetEnvironment.createUrl({
      environmentId,
      input: {
        resource: {
          _tag: "attachment",
          attachmentId: attachment.id,
          fileName: attachment.name,
          mimeType: attachment.mimeType,
        },
      },
    }),
  );
  if (result._tag !== "Success")
    return (
      <span className="block text-xs text-muted-foreground">
        {attachment.name} · {result._tag === "Failure" ? "File unavailable" : "Loading…"}
      </span>
    );
  return (
    <span className="my-2 flex max-w-sm flex-col gap-1">
      {attachment.type === "image" && (
        <AttachmentImage variant="message" src={result.value.relativeUrl} name={attachment.name} />
      )}
      <a
        href={result.value.relativeUrl}
        download={attachment.name}
        className="inline-flex items-center gap-2 rounded-md border border-border px-3 py-2 text-sm hover:bg-accent"
      >
        <Download className="size-4 shrink-0" />
        <span className="truncate">{attachment.name}</span>
        <span className="shrink-0 text-xs text-muted-foreground">
          {formatAttachmentSize(attachment.sizeBytes)}
        </span>
      </a>
    </span>
  );
}

import { ComposerSurface } from "@t3tools/ui/composer-surface";
import { DraftAttachment } from "./DraftAttachment";
import {
  AttachmentCreateUploadUrlInput,
  ChatAttachment,
  CommandId,
  MessageId,
  type EnvironmentId,
  PROVIDER_SEND_TURN_MAX_ATTACHMENTS,
  PROVIDER_SEND_TURN_SUPPORTED_IMAGE_MIME_TYPES,
} from "@t3tools/contracts";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { Button } from "@t3tools/ui/button";
import { Textarea } from "@t3tools/ui/textarea";
import { ArrowUp, Paperclip } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import * as Effect from "effect/Effect";
import * as Random from "effect/Random";
import * as Schema from "effect/Schema";
import { createAttachmentUpload, useAtomCommand } from "../state/channels";

/** Keeps the draft and selected files until the server acknowledges the message. */
export function Composer({
  channelName,
  environmentId,
  disabled,
  onSend,
}: {
  readonly channelName: string;
  readonly environmentId: EnvironmentId;
  readonly disabled: boolean;
  readonly onSend: (input: {
    text: string;
    attachments: ReadonlyArray<ChatAttachment>;
    messageId: MessageId;
    commandId: CommandId;
  }) => Promise<boolean>;
}) {
  const [value, setValue] = useState("");
  const [files, setFiles] = useState<ReadonlyArray<File>>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const transfer = useRef<AbortController | null>(null);
  const inFlight = useRef(false);
  const uploaded = useRef(new Map<File, ChatAttachment>());
  const attempt = useRef<{ signature: string; messageId: MessageId; commandId: CommandId } | null>(
    null,
  );
  const mint = useAtomCommand(createAttachmentUpload, { reportFailure: false });
  useEffect(() => () => transfer.current?.abort(), []);
  const addFiles = (incoming: ReadonlyArray<File>) => {
    if (disabled || inFlight.current) return;
    if (files.length + incoming.length > PROVIDER_SEND_TURN_MAX_ATTACHMENTS) {
      setError("Attach up to 8 files per message.");
      return;
    }
    setError(null);
    setFiles((current) => [...current, ...incoming]);
    attempt.current = null;
  };
  const submit = async () => {
    if (inFlight.current || disabled || (value.trim().length === 0 && files.length === 0)) return;
    inFlight.current = true;
    setBusy(true);
    setError(null);
    const controller = new AbortController();
    transfer.current = controller;
    try {
      const attachments: ChatAttachment[] = [];
      for (const file of files) {
        const stored = uploaded.current.get(file);
        if (stored !== undefined) {
          attachments.push(stored);
          continue;
        }
        const imageMime = PROVIDER_SEND_TURN_SUPPORTED_IMAGE_MIME_TYPES.find(
          (mime) => mime === file.type,
        );
        const parsed = Schema.decodeUnknownOption(AttachmentCreateUploadUrlInput)({
          type: imageMime === undefined ? "file" : "image",
          name: file.name,
          mimeType: imageMime ?? (file.type || "application/octet-stream"),
          sizeBytes: file.size,
        });
        if (parsed._tag === "None") {
          setError(`${file.name}: use a nonempty file up to 50 MB, or an image up to 10 MB.`);
          return;
        }
        const result = await mint({ environmentId, input: parsed.value });
        if (controller.signal.aborted) return;
        if (result._tag === "Failure") {
          const failure = squashAtomCommandFailure(result);
          setError(failure instanceof Error ? failure.message : "Could not prepare the upload.");
          return;
        }
        const response = await fetch(result.value.relativeUrl, {
          method: "POST",
          body: file,
          signal: AbortSignal.any([controller.signal, AbortSignal.timeout(120_000)]),
        });
        if (!response.ok) {
          setError(`Could not upload ${file.name}. Try again.`);
          return;
        }
        const attachment = Schema.decodeUnknownSync(ChatAttachment)({
          ...parsed.value,
          id: result.value.attachmentId,
        });
        uploaded.current.set(file, attachment);
        attachments.push(attachment);
      }
      const text = value.trim();
      const signature = JSON.stringify([text, attachments]);
      if (attempt.current?.signature !== signature) {
        const key = Effect.runSync(
          Effect.all([Random.nextInt, Random.nextInt, Random.nextInt, Random.nextInt]),
        ).join("-");
        attempt.current = {
          signature,
          messageId: MessageId.make(`message:openbot:${key}`),
          commandId: CommandId.make(`command:openbot:send:${key}`),
        };
      }
      if (
        await onSend({
          text,
          attachments,
          messageId: attempt.current.messageId,
          commandId: attempt.current.commandId,
        })
      ) {
        setValue("");
        setFiles([]);
        uploaded.current.clear();
        attempt.current = null;
      }
    } catch (cause) {
      if (!controller.signal.aborted)
        setError(
          cause instanceof Error ? cause.message : "Upload failed. Your draft is still here.",
        );
    } finally {
      inFlight.current = false;
      transfer.current = null;
      setBusy(false);
    }
  };
  return (
    <form
      className="shrink-0 px-3 pt-2 pb-[max(0.5rem,env(safe-area-inset-bottom))] sm:px-4 sm:py-3"
      onDragOver={(event) => {
        event.preventDefault();
      }}
      onDrop={(event) => {
        event.preventDefault();
        addFiles(Array.from(event.dataTransfer.files));
      }}
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      <ComposerSurface.Shell>
        <ComposerSurface.Host>
          <ComposerSurface.Main>
            <div className="p-3">
              {files.length > 0 && (
                <div className="mb-2 flex flex-wrap gap-2">
                  {files.map((file, index) => (
                    <DraftAttachment
                      key={`${file.name}:${file.lastModified}:${index}`}
                      file={file}
                      disabled={busy}
                      onRemove={() => {
                        setFiles((items) => items.filter((_, i) => i !== index));
                        uploaded.current.delete(file);
                        attempt.current = null;
                      }}
                    />
                  ))}
                </div>
              )}
              {busy && (
                <p role="status" className="mb-2 text-xs text-muted-foreground">
                  Sending…
                </p>
              )}
              {error !== null && (
                <p role="alert" className="mb-2 text-xs text-error-foreground">
                  {error}
                </p>
              )}
              <div className="flex items-end gap-2">
                <input
                  ref={fileInput}
                  type="file"
                  multiple
                  className="sr-only"
                  tabIndex={-1}
                  aria-label="Choose attachments"
                  onChange={(event) => {
                    addFiles(Array.from(event.target.files ?? []));
                    event.target.value = "";
                  }}
                />
                <Button
                  type="button"
                  size="icon"
                  variant="ghost"
                  aria-label="Attach files"
                  disabled={busy || disabled}
                  onClick={() => fileInput.current?.click()}
                >
                  <Paperclip />
                </Button>
                <Textarea
                  rows={1}
                  aria-label={`Message ${channelName}`}
                  placeholder={`Message ${channelName}`}
                  autoComplete="off"
                  enterKeyHint="enter"
                  value={value}
                  disabled={busy}
                  className="min-w-0 flex-1 [&_textarea]:max-h-[min(10rem,30dvh)] [&_textarea]:min-h-11 [&_textarea]:resize-none [&_textarea]:text-base sm:[&_textarea]:min-h-9 sm:[&_textarea]:text-sm"
                  onPaste={(event) => {
                    if (event.clipboardData.files.length > 0) {
                      event.preventDefault();
                      addFiles(Array.from(event.clipboardData.files));
                    }
                  }}
                  onChange={(event) => setValue(event.target.value)}
                  onKeyDown={(event) => {
                    if (
                      event.key === "Enter" &&
                      !event.shiftKey &&
                      !event.nativeEvent.isComposing &&
                      !window.matchMedia("(pointer: coarse)").matches
                    ) {
                      event.preventDefault();
                      void submit();
                    }
                  }}
                />
                <Button
                  type="submit"
                  size="icon"
                  className="size-11 shrink-0 rounded-xl sm:size-9"
                  aria-label={busy ? "Sending" : "Send"}
                  disabled={busy || disabled || (value.trim().length === 0 && files.length === 0)}
                >
                  <ArrowUp />
                </Button>
              </div>
            </div>
          </ComposerSurface.Main>
        </ComposerSurface.Host>
      </ComposerSurface.Shell>
    </form>
  );
}

import {
  ChatAttachment,
  openbotAttachmentHref,
  type OpenbotMcpPrepareFileResult,
  OpenbotError,
  type ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { ServerConfig } from "../config.ts";
import {
  attachmentFileExtension,
  createAttachmentId,
  resolveAttachmentPath,
} from "../attachmentStore.ts";

/** Copies a regular workspace file into durable attachment storage; rejects escapes and oversized files. */
export const prepareFile = Effect.fn("Openbot.prepareFile")(function* (input: {
  readonly threadId: ThreadId;
  readonly workspaceRoot: string;
  readonly path: string;
}) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const config = yield* ServerConfig;
  return yield* Effect.gen(function* () {
    const root = yield* fs.realPath(input.workspaceRoot);
    const source = yield* fs.realPath(path.resolve(root, input.path));
    const relative = path.relative(root, source);
    if (
      relative === "" ||
      relative === ".." ||
      relative.startsWith(`..${path.sep}`) ||
      path.isAbsolute(relative)
    )
      return yield* new OpenbotError({
        code: "orchestration_error",
        message: "The file must be inside this bot's workspace. Copy it there first.",
      });
    const stat = yield* fs.stat(source);
    if (stat.type !== "File")
      return yield* new OpenbotError({
        code: "orchestration_error",
        message: "Choose a regular file.",
      });
    const name = path.basename(source);
    const imageMimes: Readonly<Record<string, string>> = {
      ".png": "image/png",
      ".jpg": "image/jpeg",
      ".jpeg": "image/jpeg",
      ".gif": "image/gif",
      ".webp": "image/webp",
    };
    const imageMime = imageMimes[path.extname(name).toLowerCase()];
    const attachment = yield* Schema.decodeUnknownEffect(ChatAttachment)({
      type: imageMime === undefined ? "file" : "image",
      id: createAttachmentId(
        input.threadId,
        imageMime === undefined ? attachmentFileExtension(name) : undefined,
      ),
      name,
      mimeType: imageMime ?? "application/octet-stream",
      sizeBytes: Number(stat.size),
    });
    const destination = resolveAttachmentPath({
      attachmentsDir: config.attachmentsDir,
      attachment,
    });
    if (destination === null)
      return yield* new OpenbotError({
        code: "orchestration_error",
        message: "Could not allocate file storage.",
      });
    yield* fs.makeDirectory(config.attachmentsDir, { recursive: true });
    yield* fs.copyFile(source, destination);
    const label = name.replace(/[\\\[\]]/g, "\\$&");
    return {
      attachment,
      markdown: `[${label}](${openbotAttachmentHref(attachment)})`,
    } satisfies OpenbotMcpPrepareFileResult;
  }).pipe(
    Effect.mapError((cause) =>
      Schema.is(OpenbotError)(cause)
        ? cause
        : new OpenbotError({
            code: "orchestration_error",
            message:
              "Could not prepare the file. Check that it exists and is at most 50 MB (10 MB for images).",
            cause,
          }),
    ),
  );
});

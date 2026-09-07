import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { parseOpenbotAttachmentHref, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import { ServerConfig } from "../config.ts";
import { resolveAttachmentPath } from "../attachmentStore.ts";
import { prepareFile } from "./PrepareFile.ts";

const testLayer = ServerConfig.layerTest(process.cwd(), { prefix: "openbot-output-files-" }).pipe(
  Layer.provideMerge(NodeServices.layer),
);
it.layer(testLayer)("Openbot output files", (it) => {
  it.effect(
    "keeps a durable download after the source is changed and rejects workspace escapes",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const config = yield* ServerConfig;
        const workspaceRoot = path.join(config.stateDir, "outputs");
        yield* fs.makeDirectory(workspaceRoot, { recursive: true });
        yield* fs.writeFileString(path.join(workspaceRoot, "report.txt"), "original report");
        const result = yield* prepareFile({
          threadId: ThreadId.make("thread-output-test"),
          workspaceRoot,
          path: "report.txt",
        });
        assert.equal(result.attachment.type, "file");
        const stored = resolveAttachmentPath({
          attachmentsDir: config.attachmentsDir,
          attachment: result.attachment,
        });
        if (stored === null) throw new Error("Expected attachment storage path");
        yield* fs.writeFileString(path.join(workspaceRoot, "report.txt"), "changed report");
        assert.equal(yield* fs.readFileString(stored), "original report");
        const href = result.markdown.slice(result.markdown.indexOf("](") + 2, -1);
        assert.deepEqual(parseOpenbotAttachmentHref(href), result.attachment);
        yield* fs.writeFileString(path.join(config.stateDir, "outside.txt"), "outside");
        const escaped = yield* prepareFile({
          threadId: ThreadId.make("thread-output-test"),
          workspaceRoot,
          path: "../outside.txt",
        }).pipe(Effect.flip);
        assert.match(escaped.message, /inside this bot/);
        yield* fs.symlink(
          path.join(config.stateDir, "outside.txt"),
          path.join(workspaceRoot, "link.txt"),
        );
        const symlink = yield* prepareFile({
          threadId: ThreadId.make("thread-output-test"),
          workspaceRoot,
          path: "link.txt",
        }).pipe(Effect.flip);
        assert.match(symlink.message, /inside this bot/);
      }),
  );
});

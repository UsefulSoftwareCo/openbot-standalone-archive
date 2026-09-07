import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import {
  GENERATED_MODULE_PATH,
  readOpenbotSkillSources,
  renderOpenbotSkillsModule,
} from "../../../scripts/generate-openbot-skills.ts";
import { materializeOpenbotSkills, OPENBOT_SKILLS } from "./index.ts";

const SKILL_ROOTS = [".claude", ".agents"] as const;

it.layer(NodeServices.layer)("OpenBot skills", (it) => {
  it.effect("keeps the generated module in step with the SKILL.md files", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const committed = yield* fileSystem.readFileString(GENERATED_MODULE_PATH);

      assert.strictEqual(
        renderOpenbotSkillsModule(readOpenbotSkillSources()),
        committed,
        "generated.ts no longer matches the SKILL.md files. Run: node apps/server/scripts/generate-openbot-skills.ts",
      );
    }),
  );

  it.effect("writes every shipped skill to the Claude and Codex roots", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const workspace = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-openbot-skills-" });

      yield* materializeOpenbotSkills(workspace);

      assert.isNotEmpty(OPENBOT_SKILLS);
      for (const skill of OPENBOT_SKILLS) {
        // Frontmatter naming the skill is what makes the directory discoverable.
        assert.match(skill.markdown, /^---\nname: /);
        assert.include(skill.markdown, `name: ${skill.name}\n`);
        for (const root of SKILL_ROOTS) {
          const contents = yield* fileSystem.readFileString(
            path.join(workspace, root, "skills", skill.name, "SKILL.md"),
          );
          assert.strictEqual(contents, skill.markdown);
        }
      }
    }),
  );

  it.effect("leaves an already-current skill file untouched", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const workspace = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-openbot-skills-" });
      const [first] = OPENBOT_SKILLS;
      assert.isDefined(first);

      yield* materializeOpenbotSkills(workspace);
      const file = path.join(workspace, ".claude", "skills", first.name, "SKILL.md");
      const before = yield* fileSystem.stat(file);

      yield* materializeOpenbotSkills(workspace);
      const after = yield* fileSystem.stat(file);

      // An OpenBot workspace is a git repository; a no-op rewrite would dirty it.
      assert.deepStrictEqual(after.mtime, before.mtime);
    }),
  );

  it.effect("replaces a stale skill file", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const workspace = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-openbot-skills-" });
      const [first] = OPENBOT_SKILLS;
      assert.isDefined(first);
      const directory = path.join(workspace, ".agents", "skills", first.name);
      yield* fileSystem.makeDirectory(directory, { recursive: true });
      yield* fileSystem.writeFileString(path.join(directory, "SKILL.md"), "stale");

      yield* materializeOpenbotSkills(workspace);

      const contents = yield* fileSystem.readFileString(path.join(directory, "SKILL.md"));
      assert.strictEqual(contents, first.markdown);
    }),
  );
});

/**
 * OpenBot ships two ordinary skills with the server and writes them into every
 * OpenBot workspace so whichever provider runs a chat can discover them.
 *
 * Provider families disagree on the root: Claude Code scans `<cwd>/.claude/skills`
 * and deliberately ignores `.agents/skills`, while Codex, Cursor and Antigravity
 * scan `<cwd>/.agents/skills`. Neither reads the other, so each skill is written
 * to both.
 *
 * The skills stay ordinary `SKILL.md` files beside this module so they read and
 * review like every other skill in the repo, but nothing reads them at runtime:
 * `generated.ts` carries them as string literals, which the published bundle
 * inlines and a source checkout compiles as-is. Edit the Markdown and run
 * `node apps/server/scripts/generate-openbot-skills.ts`.
 *
 * @module openbot/skills
 */
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { OPENBOT_SKILLS } from "./generated.ts";

export interface OpenbotSkill {
  readonly name: string;
  readonly markdown: string;
}

export { OPENBOT_SKILLS } from "./generated.ts";

/** One root per provider family that scans the working directory for skills. */
const SKILL_ROOTS = [".claude", ".agents"] as const;

/**
 * Write the shipped skills into a workspace root. A file whose contents already
 * match is left alone: OpenBot workspaces are git repositories, and rewriting an
 * identical file would dirty the working tree every time a chat starts.
 */
export const materializeOpenbotSkills = Effect.fn("materializeOpenbotSkills")(function* (
  workspaceRoot: string,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  for (const skill of OPENBOT_SKILLS) {
    for (const root of SKILL_ROOTS) {
      const directory = path.join(workspaceRoot, root, "skills", skill.name);
      const file = path.join(directory, "SKILL.md");
      const current = yield* fileSystem
        .readFileString(file)
        .pipe(Effect.orElseSucceed(() => undefined));
      if (current === skill.markdown) continue;
      yield* fileSystem.makeDirectory(directory, { recursive: true });
      yield* fileSystem.writeFileString(file, skill.markdown);
    }
  }
});

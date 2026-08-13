// Generates skills/<name>/SKILL.md from the CLI's own home output, so the skill an agent loads cannot
// describe a command surface this tool no longer has. A stale skill is worse than no skill, because it
// is confidently wrong.
//
//   node scripts/build-skill.js          # write the file
//   node scripts/build-skill.js --check  # exit 1 if the committed file is stale
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { createSkillMarkdown, SKILL_NAME } from "../src/skill.js";

const dir = `../skills/${SKILL_NAME}/`;
const relative = `skills/${SKILL_NAME}/SKILL.md`;
const target = new URL(`${dir}SKILL.md`, import.meta.url);
const expected = createSkillMarkdown();

if (process.argv.includes("--check")) {
  /** @type {string | null} */
  let actual = null;
  try {
    actual = await readFile(target, "utf8");
  } catch {
    // A missing file is a mismatch, handled below.
  }
  if (actual !== expected) {
    console.error(`${relative} is out of date. Run \`node scripts/build-skill.js\` and commit the result.`);
    process.exit(1);
  }
  console.log(`${relative} is up to date.`);
} else {
  await mkdir(new URL(dir, import.meta.url), { recursive: true });
  await writeFile(target, expected);
  console.log(`Wrote ${fileURLToPath(target)}`);
}

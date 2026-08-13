import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { COMMAND_NAMES, RENDER_HINT } from "../src/cli.js";
import { createSkillMarkdown, SKILL_NAME } from "../src/skill.js";

/**
 * What ships.
 *
 * These assert the published shape without running `npm pack`, which would spawn npm and rebuild.
 * The failure they exist to catch is a manifest that promises a path nothing produces: npm skips a
 * missing `files` entry silently, so the first sign is a user reporting that the installed package is
 * incomplete.
 */

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const skillPath = path.join(root, "skills", SKILL_NAME, "SKILL.md");

test("every path the manifest promises to publish exists", async () => {
  const pkg = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
  for (const entry of pkg.files) {
    assert.ok(existsSync(path.join(root, entry)), `package.json lists "${entry}", which does not exist`);
  }
});

test("the published bin is the built bundle, and the build produces it", async () => {
  const pkg = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
  const bin = pkg.bin["pr-review-canvas"];
  assert.equal(bin, "dist/cli.mjs");
  assert.ok(existsSync(path.join(root, bin)), "run `npm run build` — the published entry point is missing");

  // The server re-execs the CLI to spawn itself, and the assets it serves are read relative to the
  // bundle. A publish missing any of these installs a CLI that cannot open a review at all.
  for (const asset of [
    "dist/prc.css",
    "dist/prc-hl.css",
    "dist/client/prc-client.js",
    "dist/client/prc-hl-worker.js",
    // Its own asset rather than part of prc-client.js: mermaid is twenty times the size of everything
    // else the browser loads, and it is fetched only when a diagram actually appears.
    "dist/client/prc-mermaid.js",
  ]) {
    assert.ok(existsSync(path.join(root, asset)), `${asset} is not built`);
  }
});

test("the committed SKILL.md is what the generator produces", async () => {
  // The same assertion `npm run check` makes via scripts/build-skill.js --check, kept here so a plain
  // `node --test` catches it too. A skill that describes a command surface the CLI no longer has is
  // worse than no skill, because an agent will follow it confidently.
  const committed = await readFile(skillPath, "utf8");
  assert.equal(committed, createSkillMarkdown());
});

test("the skill documents every command an agent is meant to run", async () => {
  const skill = await readFile(skillPath, "utf8");
  // `setup` is an install step and `server` is spawned for the agent, but everything else in the
  // loop has to be findable by name in the file the agent actually reads.
  for (const name of COMMAND_NAMES) {
    if (name === "open" || name === "setup") continue;
    assert.ok(skill.includes(`pr-review-canvas ${name}`), `SKILL.md never mentions \`${name}\``);
  }
});

test("the skill states the rule the whole tool exists to enforce", async () => {
  const skill = await readFile(skillPath, "utf8");
  // Not a style check. An agent that reads this file and still drafts the review has defeated the
  // point of the tool, so the prohibition must survive every future edit to the wording.
  assert.match(skill, /human writes the review/i);
  assert.match(skill, /[Nn]ever retry a failed submit/);
  assert.match(skill, /token/);
});

test("the skill tells the agent what the panel does with a reply", async () => {
  const skill = await readFile(skillPath, "utf8");
  // A capability nobody is told about does not exist. The panel rendered mermaid for a while and no
  // agent ever wrote one, because the only place that could have said so said nothing — and the same
  // was nearly true of line references, which are the single most useful thing a reply can contain.
  assert.match(skill, /mermaid/i, "the skill never mentions diagrams");
  assert.match(skill, /path:line/, "the skill never mentions line references");
  // In the tool output too: an agent that reads only what the command printed still finds out.
  assert.match(RENDER_HINT, /mermaid/i);
  assert.match(RENDER_HINT, /path:line/);
});

test("the skill says which requests are not its own", async () => {
  const skill = await readFile(skillPath, "utf8");
  // The canvas inverts who writes the review, so an agent that loads it for a plain "review this PR"
  // leaves the user with a browser tab and no findings. Both gates have to keep saying so: the
  // description an agent matches on, and the body it reads after matching.
  assert.match(skill, /Do NOT use/i);
  assert.match(skill, /"review this PR"/);
  assert.match(skill, /Not this skill/i);
});

test("the README documents the settings.json entry for submit", async () => {
  const readme = await readFile(path.join(root, "README.md"), "utf8");
  // The security hook this replaces does not match `pr-review-canvas submit`, so anyone relying on
  // that hook needs to be told how to get a prompt back. Losing this paragraph silently weakens a
  // gate someone may be depending on.
  assert.match(readme, /Bash\(pr-review-canvas submit:\*\)/);
  assert.match(readme, /gh auth login/);
});

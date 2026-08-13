import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

/**
 * Source-level agreements inside the browser client.
 *
 * There is no DOM in these tests and deliberately no jsdom: the client is one file that talks to a
 * real browser, and a fake one would only pin the parts that are easy to fake. What is checked here
 * instead is the shape that made a real bug possible — a piece of state read by several surfaces,
 * mutated in more than one place, and re-rendered in only some of them.
 */

const clientDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src", "client");
const clientSource = await readFile(path.join(clientDir, "main.js"), "utf8");
const diagramSource = await readFile(path.join(clientDir, "diagrams.js"), "utf8");

/**
 * Top-level function bodies, by name.
 *
 * The client declares everything at the top level, so splitting on `function name(` is exact enough:
 * a nested function would be attributed to its parent, which is the answer this test wants anyway.
 *
 * @returns {Map<string, string>}
 */
function topLevelFunctions() {
  /** @type {Map<string, string>} */
  const out = new Map();
  const heads = [...clientSource.matchAll(/\n(?:async )?function ([A-Za-z0-9_]+)\s*\(/g)];
  heads.forEach((head, index) => {
    const start = head.index ?? 0;
    const end = index + 1 < heads.length ? (heads[index + 1].index ?? clientSource.length) : clientSource.length;
    out.set(head[1], clientSource.slice(start, end));
  });
  return out;
}

test("a draft enters and leaves client state in exactly one place each", () => {
  // The bug this pins: `saveDraft` pushed the new comment into `state.comments`, re-rendered the file
  // and the review bar, and left the drafts index and the file tree drawing the state from before the
  // save. A draft was visible under its line while the index above the tree said "0 drafts".
  //
  // Four surfaces read `state.comments`, so the fix was one entry point and one exit point that
  // re-render all of them. `applyServerState` is the third legitimate writer: it replaces the array
  // wholesale from a server payload and then re-renders everything.
  const allowed = new Set(["putDraft", "dropDraft", "applyServerState"]);
  /** @type {string[]} */
  const writers = [];
  for (const [name, body] of topLevelFunctions()) {
    if (/state\.comments\s*=|upsertById\(state\.comments/.test(body)) writers.push(name);
  }
  assert.ok(writers.length > 0, "no writers of state.comments found — the scan is broken, not the client");
  const strays = writers.filter((name) => !allowed.has(name)).sort();
  assert.deepEqual(strays, [], `these mutate state.comments without going through putDraft/dropDraft: ${strays}`);
});

test("both draft mutators refresh every surface that counts drafts", () => {
  // Each of these renders a different count of the same array, and the whole point of routing
  // mutations through one place is that none of them can be forgotten again.
  for (const name of ["putDraft", "dropDraft"]) {
    const body = topLevelFunctions().get(name);
    assert.ok(body, `${name} is gone — the fix it carries has to move somewhere, not vanish`);
    assert.match(body, /renderDrafts\(\)/, `${name} does not refresh the drafts index`);
    assert.match(body, /renderTree\(\)/, `${name} does not refresh the file tree's per-file counts`);
  }
});

test("an ended session closes every route into writing", () => {
  // `End review` and the agent's `end` both land here. The gate is in `openComposer` rather than at
  // each caller because there are four ways in — the `+` button, `c`, `a`, and promoting an answer —
  // and a session with no agent listening should not be able to open a box that waits for one.
  const composer = topLevelFunctions().get("openComposer");
  assert.ok(composer, "openComposer is gone");
  assert.match(composer, /status === "ended"/, "openComposer no longer refuses an ended session");
  assert.match(clientSource, /addEventListener\("ended"/, "the ended push has no listener");
  const applied = topLevelFunctions().get("applyEnded");
  assert.ok(applied, "applyEnded is gone");
  assert.match(applied, /prcEndedBanner/, "nothing says on screen that the review ended");
});

test("an enlarged diagram is a clone, and the copy does not outlive the dialog", () => {
  // Cloning rather than moving means closing the dialog needs no restoration step, so a message can
  // never be left with a hole where its diagram was. Emptying it on close means a reader who opened six
  // diagrams is not carrying six copies around.
  assert.match(diagramSource, /export function zoomDiagram/, "zoomDiagram is gone");
  assert.match(diagramSource, /cloneNode\(true\)/, "the diagram is moved rather than copied");
  assert.match(diagramSource, /showModal\(\)/);
  assert.match(clientSource, /addEventListener\("close"[\s\S]{0,240}prcDiagramZoom/, "the clone is never released");
});

test("mermaid's output never reaches the page as markup", () => {
  // The source of a diagram can be a pull request comment written by a stranger, so the rule that holds
  // everywhere else in this client holds here too: nothing renders by assignment. Every node in a
  // diagram is created by `sanitizeSvg` against `shared/svg-policy.js`.
  assert.ok(!/innerHTML/.test(diagramSource), "diagrams.js assigns markup somewhere");
  assert.match(diagramSource, /createElementNS/);
  assert.match(diagramSource, /svg-policy\.js/);
});

test("the drafts push from the server has a listener", () => {
  // `server-routes.js` emits `drafts` when it changes a comment on its own — accepting a drift
  // proposal, or a second tab on the same review. It was emitting into nothing for a while, which is
  // the same failure as the one above with a different trigger.
  assert.match(clientSource, /addEventListener\("drafts"/);
});

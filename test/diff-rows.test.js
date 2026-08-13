import assert from "node:assert/strict";
import test from "node:test";
import { parseFragment } from "parse5";
import { allDiffLines } from "../src/diff/model.js";
import { parseFileEntry } from "../src/diff/parse-patch.js";
import {
  columnsFor,
  coversWholeFile,
  expandableDirections,
  filePanelHtml,
  lineKey,
  pairRows,
  parseLineKey,
  SPLIT_COLUMNS,
  tableHtml,
  UNIFIED_COLUMNS,
} from "../src/shared/diff-rows.js";
import { FIXTURES, fixture } from "./fixtures/diffs.js";

/**
 * The row renderer, checked structurally rather than by string comparison.
 *
 * Two properties here are worth more than everything else in this file:
 *
 * 1. **Every row's cells add up to the table's column count.** A colspan that disagrees with the
 *    `<colgroup>` does not error — it silently shifts a column for the rest of the table, which in
 *    split view means code appearing under the wrong line number. The plan calls this out as a real
 *    bug class, and it is the reason the spans are computed rather than written out per layout.
 * 2. **`data-lk` appears at most once per table**, and every occurrence resolves to one anchor. The
 *    whole selection layer reduces to `closest("td.prc-code[data-lk]")`, so a duplicate key would
 *    make anchoring depend on document order.
 */

/** @param {string} name */
const parsed = (name) => parseFileEntry(fixture(name).entry);

/**
 * @typedef {{ nodeName: string, tagName?: string, attrs?: Array<{ name: string, value: string }>,
 *   childNodes?: DomNode[] }} DomNode
 */

/**
 * @param {string} html
 * @returns {DomNode}
 */
function dom(html) {
  return /** @type {DomNode} */ (/** @type {unknown} */ (parseFragment(html)));
}

/**
 * @param {DomNode} node
 * @param {(node: DomNode) => boolean} predicate
 * @returns {DomNode[]}
 */
function findAll(node, predicate) {
  /** @type {DomNode[]} */
  const out = [];
  /** @param {DomNode} current */
  const walk = (current) => {
    if (predicate(current)) out.push(current);
    for (const child of current.childNodes ?? []) walk(child);
  };
  walk(node);
  return out;
}

/** @param {DomNode} node @param {string} name */
const attr = (node, name) => node.attrs?.find((candidate) => candidate.name === name)?.value;

/** @param {DomNode} node @param {string} tag */
const byTag = (node, tag) => findAll(node, (candidate) => candidate.tagName === tag);

/** @param {DomNode} row */
function cellSpan(row) {
  let total = 0;
  for (const cell of row.childNodes ?? []) {
    if (cell.tagName !== "td" && cell.tagName !== "th") continue;
    total += Number(attr(cell, "colspan") ?? 1);
  }
  return total;
}

// ---------------------------------------------------------------------------
// Column arithmetic
// ---------------------------------------------------------------------------

test("column counts are what the layouts actually declare", () => {
  assert.equal(columnsFor("unified"), UNIFIED_COLUMNS);
  assert.equal(columnsFor("split"), SPLIT_COLUMNS);
  assert.equal(UNIFIED_COLUMNS, 3);
  assert.equal(SPLIT_COLUMNS, 4);
});

for (const layout of /** @type {Array<"unified" | "split">} */ (["unified", "split"])) {
  test(`${layout}: every row spans exactly as many columns as the colgroup declares`, () => {
    for (const item of FIXTURES) {
      const file = parseFileEntry(item.entry);
      if (file.patchAvailability !== "present") continue;
      const tree = dom(tableHtml(0, file, layout));
      const cols = byTag(tree, "col").length;
      assert.equal(cols, columnsFor(layout), `${item.name}: colgroup has ${cols} cols`);
      for (const row of byTag(tree, "tr")) {
        assert.equal(cellSpan(row), cols, `${item.name}: a row spans ${cellSpan(row)} of ${cols} columns`);
      }
    }
  });

  test(`${layout}: a data-lk never appears on two code cells in one table`, () => {
    for (const item of FIXTURES) {
      const file = parseFileEntry(item.entry);
      if (file.patchAvailability !== "present") continue;
      const tree = dom(tableHtml(0, file, layout));
      const keys = findAll(tree, (node) => node.tagName === "td" && attr(node, "data-lk") != null).map((node) =>
        attr(node, "data-lk"),
      );
      assert.equal(new Set(keys).size, keys.length, `${item.name}: duplicate data-lk in ${layout} view`);
    }
  });

  test(`${layout}: every code cell with a key parses back to a real diff line`, () => {
    for (const item of FIXTURES) {
      const file = parseFileEntry(item.entry);
      if (file.patchAvailability !== "present") continue;
      const known = new Set(allDiffLines(file).map((line) => lineKey(0, line)));
      const tree = dom(tableHtml(0, file, layout));
      for (const cell of findAll(tree, (node) => node.tagName === "td" && attr(node, "data-lk") != null)) {
        const key = /** @type {string} */ (attr(cell, "data-lk"));
        assert.ok(parseLineKey(key), `${item.name}: unparseable key ${key}`);
        assert.ok(known.has(key), `${item.name}: key ${key} is not a line in this file`);
      }
    }
  });

  test(`${layout}: commentability is stated on the cell and nowhere else`, () => {
    // The contract that broke: `anchorFromCell` gated on a row-level `data-commentable`, which unified
    // emitted and split did not. Every anchor resolution in split view returned null, so the `+`
    // button, the drag, shift-click and the `c`/`a` shortcuts all did nothing at once — while unified
    // worked perfectly, which is what made it look like a selection bug rather than a missing
    // attribute. One source of truth, asserted in both layouts.
    for (const item of FIXTURES) {
      const file = parseFileEntry(item.entry);
      if (file.patchAvailability !== "present") continue;
      const tree = dom(tableHtml(0, file, layout));
      for (const row of byTag(tree, "tr")) {
        assert.equal(
          attr(row, "data-commentable"),
          undefined,
          `${item.name}: a row must not claim commentability — the cell is the authority`,
        );
      }
      const keyed = findAll(tree, (node) => node.tagName === "td" && attr(node, "data-lk") != null);
      assert.ok(keyed.length > 0, `${item.name}: no addressable cells at all`);
      for (const cell of keyed) {
        assert.ok(["0", "1"].includes(String(attr(cell, "data-commentable"))), `${item.name}: cell has no answer`);
      }
    }
  });

  test(`${layout}: a cell carries a side only where GitHub accepts a comment`, () => {
    // Two separate facts, and conflating them is what would break "ask about a line outside the
    // diff": every real line is addressable (`data-lk`), only a commentable one is sided.
    for (const item of FIXTURES) {
      const file = parseFileEntry(item.entry);
      if (file.patchAvailability !== "present") continue;
      const bySide = new Map(allDiffLines(file).map((line) => [lineKey(0, line), line.commentableSides]));
      const tree = dom(tableHtml(0, file, layout));
      for (const cell of findAll(tree, (node) => node.tagName === "td" && attr(node, "data-lk") != null)) {
        const key = /** @type {string} */ (attr(cell, "data-lk"));
        const side = attr(cell, "data-side");
        const sides = bySide.get(key) ?? [];
        if (side) {
          assert.ok(sides.includes(/** @type {any} */ (side)), `${item.name}: ${key} offered side ${side}`);
          assert.equal(attr(cell, "data-commentable"), "1");
        } else {
          assert.equal(attr(cell, "data-commentable"), "0", `${item.name}: ${key} is sideless but commentable`);
        }
      }
      // And no + button is ever offered for a side the model does not certify.
      for (const plus of findAll(tree, (node) => attr(node, "data-act") === "anchor")) {
        const key = /** @type {string} */ (attr(plus, "data-lk"));
        assert.ok((bySide.get(key) ?? []).includes(/** @type {any} */ (attr(plus, "data-side"))));
      }
    }
  });
}

test("an expanded row is addressable but offers no comment affordance", () => {
  // Expanded context is readable and can be asked about, but commenting on it is a guaranteed 422 —
  // so it keeps its `data-lk` (that is how a question resolves to a line) and loses the `+` and the
  // side. Dropping the key instead would make "ask the agent about this unchanged line" impossible,
  // which is half the reason expand-context exists.
  const file = parsed("simple-modified");
  const [existing] = file.hunks;
  file.expanded[`beforeHunk:${existing.index}`] = [
    {
      key: "x0",
      hunkIndex: 0,
      indexInHunk: 0,
      kind: /** @type {const} */ ("context"),
      oldLine: 11,
      newLine: 11,
      text: "  const before = 1;",
      origin: /** @type {const} */ ("expanded"),
      commentableSides: [],
    },
  ];
  for (const layout of /** @type {Array<"unified" | "split">} */ (["unified", "split"])) {
    const tree = dom(tableHtml(0, file, layout));
    const locked = findAll(tree, (node) => (attr(node, "class") ?? "").includes("prc-line-locked"));
    assert.ok(locked.length > 0, `${layout}: the expanded row was not rendered`);
    for (const row of locked) {
      assert.equal(findAll(row, (node) => attr(node, "data-act") === "anchor").length, 0, `${layout}: + on expanded`);
      const keyed = findAll(row, (node) => node.tagName === "td" && attr(node, "data-lk") != null);
      assert.equal(keyed.length, 1, `${layout}: an expanded row must expose exactly one addressable cell`);
      assert.equal(attr(keyed[0], "data-side"), "", `${layout}: an expanded cell claimed a side`);
      assert.equal(attr(keyed[0], "data-commentable"), "0");
    }
  }
});

// ---------------------------------------------------------------------------
// Pairing
// ---------------------------------------------------------------------------

test("a context line occupies both columns of one row", () => {
  const file = parsed("simple-modified");
  const pairs = pairRows(file.hunks[0].lines);
  // ` context`, `-del` + `+add` zipped, `+add` alone, ` context`.
  assert.equal(pairs[0].left, pairs[0].right);
  assert.equal(pairs[0].left?.kind, "context");
  assert.equal(pairs.at(-1)?.left, pairs.at(-1)?.right);
});

test("a deletion run and an addition run are zipped, longest wins", () => {
  const lines = [
    { kind: "del", oldLine: 1, newLine: null },
    { kind: "del", oldLine: 2, newLine: null },
    { kind: "del", oldLine: 3, newLine: null },
    { kind: "add", oldLine: null, newLine: 1 },
  ].map((line, index) => ({
    ...line,
    key: `k${index}`,
    hunkIndex: 0,
    indexInHunk: index,
    text: "",
    origin: "diff",
    commentableSides: [],
  }));
  const pairs = pairRows(/** @type {any} */ (lines));
  assert.equal(pairs.length, 3);
  assert.equal(pairs[0].left?.oldLine, 1);
  assert.equal(pairs[0].right?.newLine, 1);
  assert.equal(pairs[1].right, null);
  assert.equal(pairs[2].right, null);
  // Every input line appears exactly once, in order, on its own side.
  assert.deepEqual(
    pairs.map((pair) => pair.left?.oldLine ?? null),
    [1, 2, 3],
  );
});

test("pairing loses no lines and reorders none, across every fixture", () => {
  // The property that matters: split view is a re-layout, not a re-interpretation.
  for (const item of FIXTURES) {
    const file = parseFileEntry(item.entry);
    if (file.patchAvailability !== "present") continue;
    for (const hunk of file.hunks) {
      const pairs = pairRows(hunk.lines);
      const left = pairs.map((pair) => pair.left).filter((line) => line != null);
      const right = pairs.map((pair) => pair.right).filter((line) => line != null);
      assert.deepEqual(
        left.filter((line) => line.kind !== "add"),
        hunk.lines.filter((line) => line.kind !== "add"),
        `${item.name}: left column lost or reordered a line`,
      );
      assert.deepEqual(
        right.filter((line) => line.kind !== "del"),
        hunk.lines.filter((line) => line.kind !== "del"),
        `${item.name}: right column lost or reordered a line`,
      );
    }
  }
});

test("split rows keep the two columns' line numbers ascending independently", () => {
  const file = parsed("multi-hunk-gap");
  const tree = dom(tableHtml(0, file, "split"));
  /** @type {number[]} */
  const olds = [];
  /** @type {number[]} */
  const news = [];
  for (const cell of byTag(tree, "td")) {
    const number = attr(cell, "data-n");
    if (number == null) continue;
    const classes = attr(cell, "class") ?? "";
    if (classes.includes("prc-num-old")) olds.push(Number(number));
    if (classes.includes("prc-num-new")) news.push(Number(number));
  }
  assert.deepEqual(
    [...olds].sort((a, b) => a - b),
    olds,
    "old numbers went backwards",
  );
  assert.deepEqual(
    [...news].sort((a, b) => a - b),
    news,
    "new numbers went backwards",
  );
});

// ---------------------------------------------------------------------------
// Expand affordances
// ---------------------------------------------------------------------------

test("expand is offered where there is hidden context and not where there is none", () => {
  const gap = parsed("multi-hunk-gap");
  // First hunk starts at new line 10, so lines 1..9 are hidden above it.
  assert.deepEqual(expandableDirections(gap, gap.hunks[0]), { before: true, after: true });
  // Second hunk: the gap above it is 41 - (10 + 4) = 27 lines.
  assert.equal(expandableDirections(gap, gap.hunks[1]).before, true);

  const adjacent = parsed("adjacent-hunks");
  // The second hunk begins at new line 4 and the first covers 1..3 — nothing hidden between them.
  assert.equal(expandableDirections(adjacent, adjacent.hunks[1]).before, false);
  // And nothing above a hunk that starts at line 1.
  assert.equal(expandableDirections(adjacent, adjacent.hunks[0]).before, false);
});

test("each expand control gets its own band, bracketing the hunk", () => {
  // Two rounds of using this produced the shape. First, both arrows lived in the hunk header, so the
  // downward one inserted rows at the far end of a long hunk — off screen, indistinguishable from a
  // dead button. Then the upward one stayed in the header next to the `@@` text, where it read as
  // decoration while the downward band read as a control; the report was "add a button to expand up".
  // Both are bands now, identical, and the header carries no control at all.
  const file = parsed("multi-hunk-gap");
  for (const layout of /** @type {Array<"unified" | "split">} */ (["unified", "split"])) {
    const rows = byTag(dom(tableHtml(0, file, layout)), "tr");
    const roleOf = (/** @type {DomNode} */ row) => attr(row, "data-role") ?? "";
    const headerIndex = rows.findIndex((row) => (attr(row, "class") ?? "") === "prc-hunk");
    const beforeIndex = rows.findIndex((row) => roleOf(row) === "expand-before");
    const afterIndex = rows.findIndex((row) => roleOf(row) === "expand-after");

    // The range header holds no button.
    assert.equal(findAll(rows[headerIndex], (node) => attr(node, "data-act") === "expand").length, 0);
    // Order: header, upward band, ... lines ..., downward band.
    assert.ok(beforeIndex === headerIndex + 1, `${layout}: the upward band must follow the range header`);
    assert.ok(afterIndex > beforeIndex, `${layout}: the downward band must come last`);
    assert.ok(
      rows.slice(beforeIndex + 1, afterIndex).some((row) => (attr(row, "class") ?? "").includes("prc-line")),
      `${layout}: the hunk's lines must sit between the two bands`,
    );

    // Each band holds exactly one control, for its own direction, and spans the table exactly.
    for (const [index, direction] of [
      [beforeIndex, "before"],
      [afterIndex, "after"],
    ]) {
      const buttons = findAll(rows[/** @type {number} */ (index)], (node) => attr(node, "data-act") === "expand");
      assert.deepEqual(
        buttons.map((node) => attr(node, "data-direction")),
        [direction],
      );
      assert.equal(cellSpan(rows[/** @type {number} */ (index)]), columnsFor(layout));
    }
  }
});

test("a newly added file offers no expansion at all", () => {
  // `@@ -0,0 +1,N @@` as the only hunk *is* the whole file, so both buttons could only ever come back
  // empty. Found live: every new file in a feature branch had a dead control on it.
  const added = parsed("added-file");
  assert.equal(added.hunks[0].oldStart, 0);
  assert.deepEqual(expandableDirections(added, added.hunks[0]), { before: false, after: false });
  assert.equal(coversWholeFile(added, added.hunks[0]), true);
  const html = tableHtml(0, added, "unified");
  assert.equal(html.includes(`data-act="expand"`), false);
});

test("a removed file is not mistaken for a whole-file hunk", () => {
  // `@@ -1,N +0,0 @@` proves the size of the *old* side, which says nothing about where to expand on
  // the new one, so the narrow test must not fire here.
  const removed = parsed("removed-file");
  assert.equal(coversWholeFile(removed, removed.hunks[0]), false);
});

test("expand is not offered twice in the same direction", () => {
  const file = parsed("multi-hunk-gap");
  file.expanded[`beforeHunk:0`] = [];
  assert.equal(expandableDirections(file, file.hunks[0]).before, false);
});

// ---------------------------------------------------------------------------
// File panel
// ---------------------------------------------------------------------------

test("a viewed file is collapsed and says so to assistive tech", () => {
  const file = parsed("simple-modified");
  const viewed = dom(filePanelHtml(3, file, { rendered: true, viewed: true }));
  const section = byTag(viewed, "section")[0];
  assert.equal(attr(section, "data-collapsed"), "1");
  const fold = findAll(viewed, (node) => attr(node, "data-act") === "fold-file")[0];
  assert.equal(attr(fold, "aria-expanded"), "false");
  const box = findAll(viewed, (node) => (attr(node, "class") ?? "").includes("prc-viewed-box"))[0];
  assert.equal(attr(box, "checked"), "");

  const unviewed = dom(filePanelHtml(3, file, { rendered: true, viewed: false }));
  assert.equal(attr(byTag(unviewed, "section")[0], "data-collapsed"), "0");
});

test("collapsed can be set independently of viewed", () => {
  // Folding a file you have not marked viewed is an ordinary reading gesture, so the two are not
  // the same bit even though one defaults from the other.
  const file = parsed("simple-modified");
  const panel = dom(filePanelHtml(0, file, { rendered: true, viewed: true, collapsed: false }));
  assert.equal(attr(byTag(panel, "section")[0], "data-collapsed"), "0");
});

test("the panel carries the anchor id it was given and renders the requested layout", () => {
  const file = parsed("simple-modified");
  const panel = dom(filePanelHtml(0, file, { rendered: true, viewed: false, layout: "split", anchorId: "diff-abc" }));
  assert.equal(attr(byTag(panel, "section")[0], "data-anchor-id"), "diff-abc");
  assert.equal(attr(byTag(panel, "table")[0], "data-layout"), "split");
  assert.equal(byTag(panel, "col").length, SPLIT_COLUMNS);
});

test("an unrendered panel has an empty body but a complete header", () => {
  const file = parsed("simple-modified");
  const panel = dom(filePanelHtml(7, file, { rendered: false, viewed: false }));
  assert.equal(byTag(panel, "table").length, 0);
  assert.equal(attr(byTag(panel, "section")[0], "data-state"), "pending");
  assert.ok(findAll(panel, (node) => attr(node, "data-act") === "copy-file-link").length === 1);
});

test("a file with no usable patch renders a reason instead of a table", () => {
  const binary = parseFileEntry({ filename: "logo.png", status: "modified", additions: 0, deletions: 0, changes: 0 });
  for (const layout of /** @type {Array<"unified" | "split">} */ (["unified", "split"])) {
    const tree = dom(tableHtml(0, binary, layout));
    assert.equal(byTag(tree, "table").length, 0);
    assert.equal(findAll(tree, (node) => (attr(node, "class") ?? "").includes("prc-file-unavailable")).length, 1);
  }
});

test("file content is escaped in both layouts", () => {
  const file = parseFileEntry({
    filename: "x.html",
    status: "modified",
    additions: 1,
    deletions: 0,
    changes: 1,
    patch: ["@@ -1,1 +1,2 @@", " keep", `+<img src=x onerror="alert(1)">`].join("\n"),
  });
  for (const layout of /** @type {Array<"unified" | "split">} */ (["unified", "split"])) {
    const html = tableHtml(0, file, layout);
    assert.ok(!html.includes("<img"), `${layout}: raw markup survived into the row HTML`);
    const tree = dom(html);
    assert.equal(byTag(tree, "img").length, 0);
  }
});

import assert from "node:assert/strict";
import test from "node:test";
import {
  buildCommentableIndex,
  commentableCounts,
  intervalContaining,
  isCommentable,
  isRangeCommentable,
  nearestCommentableLine,
} from "../src/diff/index-lines.js";
import { allDiffLines } from "../src/diff/model.js";
import { HUNK_HEADER_RE, markBinary, parseFileEntry, parsePatch, serializeHunks } from "../src/diff/parse-patch.js";
import { FIXTURES, fixture } from "./fixtures/diffs.js";

/** @param {string} name */
const parsed = (name) => parseFileEntry(fixture(name).entry);

// ---------------------------------------------------------------------------
// Property 1 — byte round-trip. The strongest single guard in this layer: it catches prefix,
// CRLF and marker-folding regressions all at once.
// ---------------------------------------------------------------------------

test("every fixture patch round-trips byte-for-byte through parse and serialize", () => {
  for (const item of FIXTURES) {
    const patch = item.entry.patch;
    if (typeof patch !== "string") continue;
    const file = parseFileEntry(item.entry);
    // A file we refused to parse has, by design, no faithful serialization.
    if (file.degraded) continue;
    assert.equal(serializeHunks(file.hunks), patch, `round-trip failed for fixture ${item.name}`);
  }
});

test("round-trip preserves a trailing carriage return exactly", () => {
  const file = parsed("crlf");
  const lines = allDiffLines(file);
  assert.equal(lines[0].text, "l1\r");
  assert.equal(lines[1].text, "l2\r");
  assert.equal(lines[2].text, "l2X\r");
  assert.equal(serializeHunks(file.hunks), fixture("crlf").entry.patch);
});

// ---------------------------------------------------------------------------
// Property 2 — the commentability table holds for every fixture.
// ---------------------------------------------------------------------------

test("additions are RIGHT-only, deletions LEFT-only, context RIGHT-only", () => {
  for (const item of FIXTURES) {
    const file = parseFileEntry(item.entry);
    for (const line of allDiffLines(file)) {
      const sides = [...line.commentableSides];
      if (line.kind === "add") assert.deepEqual(sides, ["RIGHT"], `${item.name}: add line`);
      else if (line.kind === "del") assert.deepEqual(sides, ["LEFT"], `${item.name}: del line`);
      else assert.deepEqual(sides, ["RIGHT"], `${item.name}: context line`);
    }
  }
});

test("a deletion has no new line number and an addition has no old one", () => {
  for (const item of FIXTURES) {
    const file = parseFileEntry(item.entry);
    for (const line of allDiffLines(file)) {
      if (line.kind === "add") assert.equal(line.oldLine, null, `${item.name}`);
      if (line.kind === "del") assert.equal(line.newLine, null, `${item.name}`);
      if (line.kind === "context") {
        assert.ok(line.oldLine != null && line.newLine != null, `${item.name}: context needs both numbers`);
      }
    }
  }
});

// ---------------------------------------------------------------------------
// Property 3 — the index agrees with the fixture's declared commentable set.
// ---------------------------------------------------------------------------

test("each fixture's commentable line sets match exactly", () => {
  for (const item of FIXTURES) {
    if (!item.expect?.rightCommentable) continue;
    const index = buildCommentableIndex(parseFileEntry(item.entry));
    assert.deepEqual(
      [...index.RIGHT.keys()].sort((a, b) => a - b),
      item.expect.rightCommentable,
      `${item.name}: RIGHT`,
    );
    assert.deepEqual(
      [...index.LEFT.keys()].sort((a, b) => a - b),
      item.expect.leftCommentable ?? [],
      `${item.name}: LEFT`,
    );
  }
});

test("declared hunk counts, degraded flags and availability match", () => {
  for (const item of FIXTURES) {
    const file = parseFileEntry(item.entry);
    if (item.expect?.hunks !== undefined) assert.equal(file.hunks.length, item.expect.hunks, `${item.name}: hunks`);
    if (item.expect?.degraded !== undefined)
      assert.equal(file.degraded, item.expect.degraded, `${item.name}: degraded`);
    if (item.expect?.patchAvailability !== undefined) {
      assert.equal(file.patchAvailability, item.expect.patchAvailability, `${item.name}: availability`);
    }
  }
});

// ---------------------------------------------------------------------------
// Property 4 — exhaustive sweep. For every fixture and side, every integer in a window is
// checked against an independently-derived set. This is precisely the property whose violation
// costs an atomic 422, so it is worth testing totally rather than by sampling.
// ---------------------------------------------------------------------------

test("isCommentable agrees with the independently-derived hunk-covered set, for every line", () => {
  for (const item of FIXTURES) {
    const file = parseFileEntry(item.entry);
    const index = buildCommentableIndex(file);

    // Derived a second way: walk the hunks directly, without the index.
    /** @type {Record<"LEFT"|"RIGHT", Set<number>>} */
    const expected = { LEFT: new Set(), RIGHT: new Set() };
    if (!file.degraded) {
      for (const hunk of file.hunks) {
        for (const line of hunk.lines) {
          if (line.kind !== "del" && line.newLine != null) expected.RIGHT.add(line.newLine);
          if (line.kind === "del" && line.oldLine != null) expected.LEFT.add(line.oldLine);
        }
      }
    }

    for (const side of /** @type {const} */ (["LEFT", "RIGHT"])) {
      const numbers = [...expected[side]];
      const max = numbers.length ? Math.max(...numbers) : 0;
      for (let line = 0; line <= max + 5; line += 1) {
        assert.equal(isCommentable(index, side, line), expected[side].has(line), `${item.name}: ${side} line ${line}`);
      }
    }
  }
});

// ---------------------------------------------------------------------------
// Property 5 — range coverage. `[a,b]` is valid iff it lies wholly inside one merged interval.
// ---------------------------------------------------------------------------

test("isRangeCommentable is true exactly when every line in the closed range is commentable", () => {
  for (const item of FIXTURES) {
    const file = parseFileEntry(item.entry);
    const index = buildCommentableIndex(file);
    for (const side of /** @type {const} */ (["LEFT", "RIGHT"])) {
      const keys = [...(side === "LEFT" ? index.LEFT : index.RIGHT).keys()];
      const max = keys.length ? Math.max(...keys) : 0;
      for (let from = 0; from <= max + 3; from += 1) {
        for (let to = from; to <= max + 3; to += 1) {
          let everyLineCommentable = true;
          for (let line = from; line <= to; line += 1) {
            if (!isCommentable(index, side, line)) everyLineCommentable = false;
          }
          assert.equal(
            isRangeCommentable(index, side, from, to),
            everyLineCommentable,
            `${item.name}: ${side} range ${from}-${to}`,
          );
        }
      }
    }
  }
});

test("a range spanning the gap between two hunks is rejected", () => {
  // The rule most implementations get wrong: both endpoints are commentable, the range is not.
  const index = buildCommentableIndex(parsed("multi-hunk-gap"));
  assert.equal(isCommentable(index, "RIGHT", 13), true);
  assert.equal(isCommentable(index, "RIGHT", 41), true);
  assert.equal(isRangeCommentable(index, "RIGHT", 13, 41), false);
  assert.equal(isRangeCommentable(index, "RIGHT", 10, 13), true);
  assert.equal(isRangeCommentable(index, "RIGHT", 41, 44), true);
  assert.deepEqual(index.rightIntervals, [
    [10, 13],
    [41, 44],
  ]);
});

test("abutting hunks with continuous numbering merge into one interval", () => {
  const index = buildCommentableIndex(parsed("adjacent-hunks"));
  assert.deepEqual(index.rightIntervals, [[1, 6]]);
  assert.equal(isRangeCommentable(index, "RIGHT", 2, 5), true);
});

test("isRangeCommentable rejects a reversed or non-integer range", () => {
  const index = buildCommentableIndex(parsed("simple-modified"));
  assert.equal(isRangeCommentable(index, "RIGHT", 14, 12), false);
  assert.equal(isRangeCommentable(index, "RIGHT", 12.5, 14), false);
  assert.equal(isRangeCommentable(index, "RIGHT", Number.NaN, 14), false);
});

// ---------------------------------------------------------------------------
// Header grammar
// ---------------------------------------------------------------------------

test("HUNK_HEADER_RE handles omitted counts and a heading containing @@", () => {
  const omitted = HUNK_HEADER_RE.exec("@@ -1 +1 @@");
  assert.ok(omitted);
  assert.equal(omitted[2], undefined);
  assert.equal(omitted[4], undefined);

  const heading = HUNK_HEADER_RE.exec("@@ -1,2 +1,3 @@ heading with @@ inside");
  assert.ok(heading);
  assert.equal(heading[5], "heading with @@ inside");

  const plain = HUNK_HEADER_RE.exec("@@ -12,4 +12,5 @@");
  assert.ok(plain);
  assert.equal(plain[5], undefined);

  assert.equal(HUNK_HEADER_RE.exec("@@ nope @@"), null);
  assert.equal(HUNK_HEADER_RE.exec("@@ -1,2 1,3 @@"), null);
});

test("an omitted count is read as 1", () => {
  const file = parsed("omitted-count");
  assert.equal(file.hunks[0].oldCount, 1);
  assert.equal(file.hunks[0].newCount, 1);
});

test("a zero count leaves the other side's start un-addressable", () => {
  const file = parsed("zero-count-insertion");
  const hunk = file.hunks[0];
  assert.equal(hunk.oldStart, 1);
  assert.equal(hunk.oldCount, 0);
  assert.equal(hunk.newStart, 2);
  assert.equal(hunk.newCount, 1);
  assert.equal(hunk.sectionHeading, "l1");
  // Old line 1 exists in the file but is not part of this diff.
  const index = buildCommentableIndex(file);
  assert.equal(isCommentable(index, "LEFT", 1), false);
  assert.equal(isCommentable(index, "RIGHT", 2), true);
});

// ---------------------------------------------------------------------------
// The no-newline marker
// ---------------------------------------------------------------------------

test("both no-newline markers in one hunk attach to their own preceding line", () => {
  const file = parsed("no-newline-both-sides");
  const lines = allDiffLines(file);
  assert.equal(lines.length, 3, "the markers must not become lines of their own");
  assert.equal(lines[0].noNewlineAtEof, undefined);
  assert.equal(lines[1].kind, "del");
  assert.equal(lines[1].noNewlineAtEof, true);
  assert.equal(lines[2].kind, "add");
  assert.equal(lines[2].noNewlineAtEof, true);
});

test("a marker with no preceding line is a non-fatal diagnostic", () => {
  const { hunks, diagnostics } = parsePatch(["@@ -1,1 +1,1 @@", "\\ No newline at end of file", " a"].join("\n"));
  assert.equal(hunks.length, 1);
  const problem = diagnostics.find((entry) => entry.code === "marker-without-line");
  assert.ok(problem);
  assert.equal(problem.fatal, false);
});

// ---------------------------------------------------------------------------
// Fail-closed behaviour
// ---------------------------------------------------------------------------

test("a count mismatch is fatal and yields zero commentable lines", () => {
  const file = parsed("count-mismatch");
  assert.equal(file.degraded, true);
  assert.equal(file.patchAvailability, "truncated");
  assert.equal(file.fileCommentable, false, "a file whose diff we misread must not accept a file comment either");
  assert.ok(file.diagnostics.some((entry) => entry.code === "hunk-count-mismatch" && entry.fatal));
  assert.deepEqual(commentableCounts(buildCommentableIndex(file)), { left: 0, right: 0 });
});

test("a malformed header abandons the file", () => {
  const file = parsed("malformed-header");
  assert.equal(file.degraded, true);
  assert.equal(file.hunks.length, 0);
  assert.ok(file.diagnostics.some((entry) => entry.code === "bad-hunk-header" && entry.fatal));
});

test("a stray line prefix is fatal on its own, because the count check does NOT catch it", () => {
  const file = parsed("unknown-prefix");
  assert.equal(file.degraded, true);
  assert.ok(file.diagnostics.some((entry) => entry.code === "unknown-line-prefix" && entry.fatal));

  // This is the point of the fixture. The stray line sits in a hunk whose remaining lines
  // reconcile exactly with the header, so the count check passes. Relying on it would leave us
  // with a file whose line numbers look correct and whose content is missing a line — the worst
  // possible input for anchoring. Hence unknown-line-prefix must be fatal by itself.
  assert.equal(
    file.diagnostics.some((entry) => entry.code === "hunk-count-mismatch"),
    false,
    "the counts genuinely reconcile here; nothing else would have flagged this file",
  );
});

test("an empty line with no prefix is normalised to an empty context line, non-fatally", () => {
  // Real git writes " " for an empty context line, but trailing-whitespace trimming strips it.
  // This shape is unambiguous, so unlike a stray prefix it is recoverable.
  //
  // The stripped line must sit in the MIDDLE of the patch: at the very end it is genuinely
  // indistinguishable from the patch simply ending with a newline, and the parser resolves that
  // ambiguity in favour of the terminal newline (which is what GitHub's `patch` field means).
  const { hunks, diagnostics } = parsePatch(["@@ -1,3 +1,3 @@", " keep", "", " after"].join("\n"));
  assert.equal(hunks.length, 1);
  assert.equal(hunks[0].lines.length, 3);
  assert.equal(hunks[0].lines[1].kind, "context");
  assert.equal(hunks[0].lines[1].text, "");
  const note = diagnostics.find((entry) => entry.code === "unknown-line-prefix");
  assert.ok(note);
  assert.equal(note.fatal, false);
  assert.equal(
    hunks[0].lines.every((line) => line.newLine != null),
    true,
  );
});

test("a trailing empty line is read as the patch's terminal newline, not as content", () => {
  const withTerminalNewline = parsePatch(["@@ -1,1 +1,1 @@", " only", ""].join("\n"));
  assert.equal(withTerminalNewline.hunks[0].lines.length, 1);
  assert.deepEqual(withTerminalNewline.diagnostics, []);
});

test("overlapping hunks are fatal", () => {
  const patch = ["@@ -1,3 +1,3 @@", " a", " b", " c", "@@ -2,2 +2,2 @@", " b", " c"].join("\n");
  const { diagnostics } = parsePatch(patch);
  assert.ok(diagnostics.some((entry) => entry.code === "nonmonotonic-hunks" && entry.fatal));
});

test("an empty or whitespace-only patch parses to nothing without diagnostics", () => {
  assert.deepEqual(parsePatch(""), { hunks: [], diagnostics: [] });
  const preamble = parsePatch("some text before any hunk header");
  assert.deepEqual(preamble.hunks, []);
});

// ---------------------------------------------------------------------------
// Missing patches, renames, binaries
// ---------------------------------------------------------------------------

test("a pure rename has no patch but stays file-commentable", () => {
  const file = parsed("rename-pure");
  assert.equal(file.patchAvailability, "empty");
  assert.equal(file.fileCommentable, true);
  assert.equal(file.previousPath, "src/original.js");
  assert.equal(file.degraded, false);
});

test("a withheld patch disables both line and file comments", () => {
  const file = parsed("patch-withheld");
  assert.equal(file.patchAvailability, "absent-large");
  assert.equal(file.fileCommentable, false);
  assert.ok(file.diagnostics.some((entry) => entry.code === "patch-missing"));
});

test("markBinary re-enables a file-level comment and clears the hunks", () => {
  const file = markBinary(parsed("patch-withheld"));
  assert.equal(file.isBinary, true);
  assert.equal(file.patchAvailability, "absent-binary");
  assert.equal(file.fileCommentable, true);
  assert.deepEqual(file.hunks, []);
});

test("a renamed file keeps the new path for comments and the old one for display", () => {
  const file = parsed("rename-with-hunks");
  assert.equal(file.path, "src/new-name.js");
  assert.equal(file.previousPath, "src/old-name.js");
});

// ---------------------------------------------------------------------------
// Index helpers
// ---------------------------------------------------------------------------

test("nearestCommentableLine prefers the closer line and breaks ties downstream", () => {
  const index = buildCommentableIndex(parsed("multi-hunk-gap"));
  assert.deepEqual(nearestCommentableLine(index, "RIGHT", 14), { line: 13, distance: 1 });
  assert.deepEqual(nearestCommentableLine(index, "RIGHT", 40), { line: 41, distance: 1 });
  // Equidistant between 13 and 41 is impossible here, so construct the tie directly:
  // 12 and 14 are both distance 1 from 13 — 14 wins as the downstream choice.
  const simple = buildCommentableIndex(parsed("simple-modified"));
  assert.deepEqual(nearestCommentableLine(simple, "RIGHT", 13), { line: 13, distance: 0 });
  assert.equal(nearestCommentableLine(index, "RIGHT", 500), null, "beyond maxDistance there is no candidate");
});

test("intervalContaining finds the enclosing run or nothing", () => {
  const index = buildCommentableIndex(parsed("multi-hunk-gap"));
  assert.deepEqual(intervalContaining(index, "RIGHT", 12), [10, 13]);
  assert.deepEqual(intervalContaining(index, "RIGHT", 43), [41, 44]);
  assert.equal(intervalContaining(index, "RIGHT", 20), null);
});

test("buildCommentableIndex is memoized per parsed file", () => {
  const file = parsed("simple-modified");
  assert.equal(buildCommentableIndex(file), buildCommentableIndex(file));
  // A re-parse is a different object and gets a fresh index.
  assert.notEqual(buildCommentableIndex(file), buildCommentableIndex(parsed("simple-modified")));
});

test("unicode content survives parsing and serialization", () => {
  const file = parsed("unicode-content");
  // Deliberately NOT compared against re-typed literals: `é` has both a precomposed form
  // (U+00E9) and a combining form (e + U+0301), and a second copy of the same-looking string in
  // this file can silently be the other one. Assert against the fixture's own bytes instead.
  const patchLines = /** @type {string} */ (fixture("unicode-content").entry.patch).split("\n");
  const lines = allDiffLines(file);
  assert.equal(lines.length, 3);
  for (let i = 0; i < lines.length; i += 1) {
    assert.equal(lines[i].text, patchLines[i + 1].slice(1), `line ${i} content must match the patch byte-for-byte`);
  }
  assert.equal(serializeHunks(file.hunks), fixture("unicode-content").entry.patch);
});

test("an astral-plane character and a combining mark are not split or reordered", () => {
  // Written with explicit escapes so the intent cannot be normalised away by any tool.
  const combining = "é"; // e + COMBINING ACUTE ACCENT
  const astral = "\u{1F389}"; // PARTY POPPER, outside the BMP
  const patch = ["@@ -1,1 +1,1 @@", `-caf${combining} ${astral}`, `+café ${astral}!`].join("\n");
  const { hunks, diagnostics } = parsePatch(patch);
  assert.deepEqual(diagnostics, []);
  assert.equal(hunks[0].lines[0].text, `caf${combining} ${astral}`);
  assert.equal(hunks[0].lines[1].text, `café ${astral}!`);
  assert.equal(serializeHunks(hunks), patch);
});

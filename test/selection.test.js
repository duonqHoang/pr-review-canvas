import assert from "node:assert/strict";
import test from "node:test";
import { buildCommentableIndex, linesForSide } from "../src/diff/index-lines.js";
import { parseFileEntry } from "../src/diff/parse-patch.js";
import { clampRange, describeRange, runsOf, sortedLines } from "../src/shared/selection.js";
import { fixture } from "./fixtures/diffs.js";

/**
 * Range clamping.
 *
 * The rule under test is the one that decides whether a multi-line comment submits or takes the whole
 * review down with an atomic 422: the range must lie wholly inside **one contiguous run** of
 * commentable lines. Checking only the two endpoints is the usual shortcut and it accepts ranges that
 * span a hunk gap, where the intervening line numbers are not in the diff at all.
 *
 * The fixtures are reused from the diff parser so the sets of commentable lines are the real ones,
 * not hand-written numbers that could drift from what the parser actually produces.
 */

/**
 * The commentable line numbers of one side.
 *
 * `.keys()` matters: `linesForSide` returns a Map, and `new Set(map)` would collect entry *pairs*
 * rather than numbers — which makes every clamp return null and every assertion below pass or fail for
 * the wrong reason.
 *
 * @param {string} name
 * @param {"LEFT" | "RIGHT"} side
 * @returns {number[]}
 */
function commentableOf(name, side) {
  const file = parseFileEntry(fixture(name).entry);
  return [...linesForSide(buildCommentableIndex(file), side).keys()];
}

test("a selection inside one run is kept whole", () => {
  // `multi-hunk-gap`: new lines 10..13 and 41..44 are in the diff; 14..40 are not.
  const right = commentableOf("multi-hunk-gap", "RIGHT");
  assert.deepEqual(clampRange(right, 10, 13), { from: 10, to: 13, dropped: 0, trimmed: false });
  assert.deepEqual(clampRange(right, 41, 44), { from: 41, to: 44, dropped: 0, trimmed: false });
});

test("a selection dragged across a hunk gap is trimmed at the gap", () => {
  // THE case. Dragging from line 12 down to line 42 looks contiguous on screen — the rows are
  // adjacent, with only a hunk header between them — and GitHub refuses it.
  const right = commentableOf("multi-hunk-gap", "RIGHT");
  const range = clampRange(right, 12, 42);
  assert.deepEqual(range, { from: 12, to: 13, dropped: 29, trimmed: true });
});

test("the anchor wins, so the result follows the direction of the gesture", () => {
  const right = commentableOf("multi-hunk-gap", "RIGHT");
  // Dragging upward from 42 keeps the second hunk, not the first.
  const upward = clampRange(right, 42, 12);
  assert.deepEqual(upward, { from: 41, to: 42, dropped: 29, trimmed: true });
  // The same two lines, opposite gestures, opposite results — which is what makes it predictable.
  assert.notDeepEqual(upward, clampRange(right, 12, 42));
});

test("adjacent hunks merge into one run, so a range may cross the header", () => {
  // `adjacent-hunks` has two hunks whose new-side numbers are continuous (1..3 then 4..6). A range
  // across that boundary is legal, and refusing it would be a false negative.
  const right = commentableOf("adjacent-hunks", "RIGHT");
  assert.deepEqual(clampRange(right, 2, 5), { from: 2, to: 5, dropped: 0, trimmed: false });
  assert.deepEqual(runsOf(right), [{ from: 1, to: 6 }]);
});

test("a single-line gesture is a single-line range", () => {
  const right = commentableOf("simple-modified", "RIGHT");
  assert.deepEqual(clampRange(right, 12, 12), { from: 12, to: 12, dropped: 0, trimmed: false });
});

test("an anchor outside the diff produces nothing, rather than a nearby guess", () => {
  // Refusing is the point: silently moving the anchor to a line the user did not pick is the
  // mis-anchoring this project avoids everywhere.
  const right = commentableOf("multi-hunk-gap", "RIGHT");
  assert.equal(clampRange(right, 25, 30), null);
  assert.equal(clampRange(right, 999, 999), null);
  assert.equal(clampRange([], 1, 1), null);
});

test("a target outside the diff trims to the run's edge without failing", () => {
  const right = commentableOf("multi-hunk-gap", "RIGHT");
  // Dragging well past the end of everything keeps what was reachable.
  assert.deepEqual(clampRange(right, 43, 900), { from: 43, to: 44, dropped: 856, trimmed: true });
  // And upward past the start of the file.
  assert.deepEqual(clampRange(right, 11, -5), { from: 10, to: 11, dropped: 15, trimmed: true });
});

test("the deletion side clamps on its own numbering", () => {
  // LEFT lines are old-file numbers, an entirely separate axis; mixing the two would trim against the
  // wrong set and produce a range that is valid on neither side.
  const left = commentableOf("simple-modified", "LEFT");
  assert.deepEqual(sortedLines(left), [13]);
  assert.deepEqual(clampRange(left, 13, 13), { from: 13, to: 13, dropped: 0, trimmed: false });
  assert.equal(clampRange(left, 12, 13), null, "old line 12 is context, so it is RIGHT-commentable only");
});

test("runs are the merged intervals the validator reasons about", () => {
  assert.deepEqual(runsOf([1, 2, 3, 7, 8, 20]), [
    { from: 1, to: 3 },
    { from: 7, to: 8 },
    { from: 20, to: 20 },
  ]);
  assert.deepEqual(runsOf([]), []);
  // Unsorted and duplicated input still yields clean intervals.
  assert.deepEqual(runsOf([3, 1, 2, 2]), [{ from: 1, to: 3 }]);
});

test("a clamped range is described in terms the user can act on", () => {
  assert.equal(describeRange({ from: 5, to: 5, dropped: 0, trimmed: false }, "RIGHT"), "line 5");
  assert.equal(describeRange({ from: 5, to: 9, dropped: 0, trimmed: false }, "RIGHT"), "lines 5–9");
  assert.equal(
    describeRange({ from: 5, to: 9, dropped: 0, trimmed: false }, "LEFT"),
    "lines 5–9 on the original file",
    "the side has to be named, or a LEFT range reads as a RIGHT one",
  );
  assert.equal(
    describeRange({ from: 12, to: 13, dropped: 29, trimmed: true }, "RIGHT"),
    "lines 12–13 — trimmed, 29 lines outside the diff",
  );
  // Singular, because "1 lines" is the kind of detail that makes a tool feel unfinished.
  assert.equal(
    describeRange({ from: 1, to: 1, dropped: 1, trimmed: true }, "RIGHT"),
    "line 1 — trimmed, 1 line outside the diff",
  );
});

test("clamping never returns a range the validator would reject, across every fixture", () => {
  // The property that matters: whatever the gesture, the result is inside one run. Swept over every
  // fixture, both sides, and every pair of endpoints in a window around the real lines.
  let checked = 0;
  for (const name of ["simple-modified", "multi-hunk-gap", "adjacent-hunks", "crlf", "added-file"]) {
    const file = parseFileEntry(fixture(name).entry);
    const index = buildCommentableIndex(file);
    for (const side of /** @type {Array<"LEFT" | "RIGHT">} */ (["LEFT", "RIGHT"])) {
      const lines = sortedLines(linesForSide(index, side).keys());
      if (lines.length === 0) continue;
      const runs = runsOf(lines);
      const low = lines[0] - 3;
      const high = /** @type {number} */ (lines.at(-1)) + 3;
      for (let anchor = low; anchor <= high; anchor += 1) {
        for (let target = low; target <= high; target += 1) {
          const range = clampRange(lines, anchor, target);
          if (!range) continue;
          checked += 1;
          const run = runs.find((candidate) => range.from >= candidate.from && range.to <= candidate.to);
          assert.ok(run, `${name}/${side}: ${anchor}→${target} produced ${range.from}-${range.to}, spanning a gap`);
          // And the anchor is always inside what was kept, so the gesture's origin is never abandoned.
          assert.ok(anchor >= range.from && anchor <= range.to, `${name}/${side}: anchor ${anchor} was dropped`);
        }
      }
    }
  }
  // A property test that quietly examines nothing is worse than no test at all: the first version of
  // this file passed while every clamp returned null, because the helper handed it a Map.
  assert.ok(checked > 200, `the sweep only evaluated ${checked} ranges`);
});

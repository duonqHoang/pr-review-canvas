import { SIDE_LEFT, SIDE_RIGHT } from "./model.js";

/**
 * The commentable-line index: the single authority on "will GitHub accept a comment here".
 *
 * The interval representation exists for one specific rule that most implementations get wrong.
 * Within a hunk, the RIGHT-side line numbers run contiguously across context and additions
 * (deletions consume no new-file numbers). But *between* hunks the new-file numbers are absent
 * from the diff, so a multi-line comment whose range spans a hunk gap is rejected with
 * `pull_request_review_thread.line must be part of the diff` — and because the review POST is
 * atomic, that rejects every other comment too. Checking only the two endpoints of a range
 * would happily pass such a range. Interval containment is correct in every case, including
 * the rare one where git emitted two abutting hunks whose numbers happen to be continuous.
 */

/**
 * @typedef {object} CommentableIndex
 * @property {Map<number, import("./model.js").DiffLine>} RIGHT
 * @property {Map<number, import("./model.js").DiffLine>} LEFT
 * @property {Array<[number, number]>} rightIntervals sorted, merged, closed
 * @property {Array<[number, number]>} leftIntervals sorted, merged, closed
 * @property {Map<number, import("./model.js").DiffLine>} expandedRight for better error messages only
 * @property {Map<number, import("./model.js").DiffLine>} expandedLeft
 */

/** @type {WeakMap<import("./model.js").ParsedFile, CommentableIndex>} */
const cache = new WeakMap();

/**
 * @param {number[]} numbers
 * @returns {Array<[number, number]>}
 */
function mergeIntoIntervals(numbers) {
  if (numbers.length === 0) return [];
  const sorted = [...numbers].sort((a, b) => a - b);
  /** @type {Array<[number, number]>} */
  const intervals = [];
  let start = sorted[0];
  let end = sorted[0];
  for (let i = 1; i < sorted.length; i += 1) {
    const value = sorted[i];
    if (value === end) continue; // duplicates cannot happen, but be robust
    if (value === end + 1) {
      end = value;
      continue;
    }
    intervals.push([start, end]);
    start = value;
    end = value;
  }
  intervals.push([start, end]);
  return intervals;
}

/**
 * Build (and memoize) the index for a file. Memoized per `ParsedFile` object identity, so a
 * re-parse after a push naturally produces a fresh index.
 *
 * @param {import("./model.js").ParsedFile} file
 * @returns {CommentableIndex}
 */
export function buildCommentableIndex(file) {
  const cached = cache.get(file);
  if (cached) return cached;

  /** @type {CommentableIndex} */
  const index = {
    RIGHT: new Map(),
    LEFT: new Map(),
    rightIntervals: [],
    leftIntervals: [],
    expandedRight: new Map(),
    expandedLeft: new Map(),
  };

  // A degraded parse certifies nothing: we could not account for the patch byte-for-byte, so
  // every line number in it is a guess.
  if (!file.degraded) {
    for (const hunk of file.hunks) {
      for (const line of hunk.lines) {
        if (line.commentableSides.includes(SIDE_RIGHT) && line.newLine != null) {
          index.RIGHT.set(line.newLine, line);
        }
        if (line.commentableSides.includes(SIDE_LEFT) && line.oldLine != null) {
          index.LEFT.set(line.oldLine, line);
        }
      }
    }
  }

  // Expanded context is tracked separately so a rejection can say *why* — "that line is
  // outside the diff" is much more useful than "that line does not exist".
  for (const lines of Object.values(file.expanded)) {
    for (const line of lines) {
      if (line.newLine != null) index.expandedRight.set(line.newLine, line);
      if (line.oldLine != null) index.expandedLeft.set(line.oldLine, line);
    }
  }

  index.rightIntervals = mergeIntoIntervals([...index.RIGHT.keys()]);
  index.leftIntervals = mergeIntoIntervals([...index.LEFT.keys()]);

  cache.set(file, index);
  return index;
}

/** @param {CommentableIndex} index @param {import("./model.js").Side} side */
export function linesForSide(index, side) {
  return side === SIDE_LEFT ? index.LEFT : index.RIGHT;
}

/** @param {CommentableIndex} index @param {import("./model.js").Side} side */
export function intervalsForSide(index, side) {
  return side === SIDE_LEFT ? index.leftIntervals : index.rightIntervals;
}

/** @param {CommentableIndex} index @param {import("./model.js").Side} side */
export function expandedForSide(index, side) {
  return side === SIDE_LEFT ? index.expandedLeft : index.expandedRight;
}

/**
 * @param {CommentableIndex} index
 * @param {import("./model.js").Side} side
 * @param {number} line
 */
export function isCommentable(index, side, line) {
  return linesForSide(index, side).has(line);
}

/**
 * The closed range `[from, to]` must lie **entirely** within a single merged interval.
 *
 * @param {CommentableIndex} index
 * @param {import("./model.js").Side} side
 * @param {number} from
 * @param {number} to
 */
export function isRangeCommentable(index, side, from, to) {
  if (!Number.isInteger(from) || !Number.isInteger(to) || from > to) return false;
  return intervalsForSide(index, side).some(([start, end]) => from >= start && to <= end);
}

/**
 * The merged interval containing `line`, if any. Used to clamp an invalid range back to
 * something submittable instead of failing the whole batch.
 *
 * @param {CommentableIndex} index
 * @param {import("./model.js").Side} side
 * @param {number} line
 * @returns {[number, number] | null}
 */
export function intervalContaining(index, side, line) {
  return intervalsForSide(index, side).find(([start, end]) => line >= start && line <= end) ?? null;
}

/**
 * Nearest commentable line on a side, by absolute distance. Ties resolve to the larger number
 * (downstream), which reads more naturally when a comment slid off the end of a hunk.
 *
 * @param {CommentableIndex} index
 * @param {import("./model.js").Side} side
 * @param {number} line
 * @param {number} [maxDistance]
 * @returns {{ line: number, distance: number } | null}
 */
export function nearestCommentableLine(index, side, line, maxDistance = 20) {
  /** @type {{ line: number, distance: number } | null} */
  let best = null;
  for (const candidate of linesForSide(index, side).keys()) {
    const distance = Math.abs(candidate - line);
    if (distance > maxDistance) continue;
    if (!best || distance < best.distance || (distance === best.distance && candidate > best.line)) {
      best = { line: candidate, distance };
    }
  }
  return best;
}

/**
 * Total count of commentable lines, per side. Handy for tests and for the UI's "N of M lines
 * can be commented on" affordances.
 *
 * @param {CommentableIndex} index
 */
export function commentableCounts(index) {
  return { left: index.LEFT.size, right: index.RIGHT.size };
}

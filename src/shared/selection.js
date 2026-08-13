/**
 * Turning a gesture into a range GitHub will accept.
 *
 * Pure integer arithmetic over the set of line numbers that are commentable on one side of one file.
 * No DOM, so the interesting rules are testable directly — and they are the rules that decide whether
 * a review submits or dies on an atomic 422.
 *
 * The load-bearing rule is the one most implementations get wrong: a multi-line comment's range must
 * lie **wholly inside one contiguous run** of commentable lines. Within a hunk, new-side numbers run
 * continuously across context and additions (a deletion consumes no new-side number), but **between**
 * two hunks the numbers in the gap are not in the diff at all. So a selection dragged across a hunk
 * boundary looks perfectly reasonable on screen and is rejected by the API.
 *
 * Rather than let that happen, a selection is **trimmed** — never silently accepted, never silently
 * discarded. The user is told what was dropped.
 */

/**
 * @typedef {object} ClampedRange
 * @property {number} from first line of the range
 * @property {number} to last line
 * @property {number} dropped how many lines the gesture covered that had to be given up
 * @property {boolean} trimmed whether anything was given up
 */

/**
 * Clamp a two-point gesture to the contiguous run of commentable lines that contains its **anchor**.
 *
 * The anchor is where the gesture started, and it wins: a drag from inside a hunk out past its end
 * keeps the part inside that hunk, rather than jumping to wherever the pointer landed. That makes the
 * result predictable from the direction of the gesture, which is the only thing the user can feel.
 *
 * @param {Iterable<number>} commentable every line number commentable on this side of this file
 * @param {number} anchorLine where the gesture began
 * @param {number} targetLine where it ended
 * @returns {ClampedRange | null} null when the anchor itself is not commentable
 */
export function clampRange(commentable, anchorLine, targetLine) {
  const available = new Set(commentable);
  if (!available.has(anchorLine)) return null;

  const step = targetLine >= anchorLine ? 1 : -1;
  let reach = anchorLine;
  // Walk one line at a time from the anchor towards the target, stopping at the first number that is
  // not in the diff. Checking only the two endpoints — the common shortcut — would happily accept a
  // range that spans a hunk gap.
  while (reach !== targetLine) {
    const next = reach + step;
    if (!available.has(next)) break;
    reach = next;
  }

  const from = Math.min(anchorLine, reach);
  const to = Math.max(anchorLine, reach);
  const requested = Math.abs(targetLine - anchorLine) + 1;
  const kept = to - from + 1;
  return { from, to, dropped: requested - kept, trimmed: kept < requested };
}

/**
 * The line numbers a side offers, as a sorted array. Useful for describing a selection to the user.
 *
 * @param {Iterable<number>} commentable
 * @returns {number[]}
 */
export function sortedLines(commentable) {
  return [...new Set(commentable)].sort((a, b) => a - b);
}

/**
 * The contiguous runs within a set of line numbers.
 *
 * The same merged intervals the server's validator reasons about, computed here so the client can say
 * *why* a selection was trimmed rather than only that it was.
 *
 * @param {Iterable<number>} commentable
 * @returns {Array<{ from: number, to: number }>}
 */
export function runsOf(commentable) {
  const lines = sortedLines(commentable);
  /** @type {Array<{ from: number, to: number }>} */
  const runs = [];
  for (const line of lines) {
    const last = runs.at(-1);
    if (last && line === last.to + 1) last.to = line;
    else runs.push({ from: line, to: line });
  }
  return runs;
}

/**
 * A short sentence for the user about what a gesture actually produced.
 *
 * Written here rather than in the view so the wording is covered by the same tests as the arithmetic:
 * these messages are the only feedback distinguishing "this is what you selected" from "GitHub would
 * have refused what you selected".
 *
 * @param {ClampedRange} range
 * @param {import("../diff/model.js").Side} side
 * @returns {string}
 */
export function describeRange(range, side) {
  const where = side === "LEFT" ? " on the original file" : "";
  const span = range.from === range.to ? `line ${range.from}` : `lines ${range.from}–${range.to}`;
  if (!range.trimmed) return `${span}${where}`;
  const dropped = range.dropped === 1 ? "1 line" : `${range.dropped} lines`;
  // Naming the reason matters: "outside the diff" is actionable, "invalid selection" is not.
  return `${span}${where} — trimmed, ${dropped} outside the diff`;
}

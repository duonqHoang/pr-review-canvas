import { createHash } from "node:crypto";
import { allDiffLines } from "../diff/model.js";

/**
 * The canonical anchor.
 *
 * Two representations exist in this project and must not be confused:
 *
 * - a **line key** (`fileIndex:kind:old:new`) addresses a row in the DOM. It is mode-independent
 *   so toggling unified/split re-anchors nothing, and it is *never persisted* — `fileIndex` does
 *   not survive a re-fetch.
 * - an **anchor**, defined here, is what gets persisted and what becomes a GitHub review comment.
 *   It is keyed by path, side and line number.
 */

/**
 * @typedef {object} AnchorFingerprint
 * @property {string} rawText verbatim text of the anchored line, truncated at 512 chars
 * @property {true} [truncated]
 * @property {string} textHash sha256:16 of the untruncated text
 * @property {string} beforeHash sha256:16 of the 3 preceding lines, in diff order
 * @property {string} afterHash sha256:16 of the 3 following lines, in diff order
 * @property {string} [blockHash] sha256:16 of every in-range line, for a multi-line anchor
 * @property {number} [blockLines] how many lines `blockHash` covers, in diff order
 * @property {string} hunkHeader
 * @property {string | null} blobSha
 * @property {string} headSha
 */

/**
 * @typedef {object} LineAnchor
 * @property {"line"} kind
 * @property {string} path always the file's CURRENT path, even for a LEFT anchor
 * @property {import("../diff/model.js").Side} side
 * @property {number} line the LAST line of the range
 * @property {number} [startLine] strictly less than `line`
 * @property {import("../diff/model.js").Side} [startSide] always equal to `side`
 * @property {AnchorFingerprint} fingerprint
 * @property {{ side: import("../diff/model.js").Side, lines: number[] }} [droppedRows] rows the
 *   user selected that GitHub cannot express; quoted into the body instead
 * @property {true} [outsideDiff] set only on a *question* anchor whose lines GitHub would refuse a
 *   comment on. Never produced for a draft comment, and the validator rejects it regardless, so it
 *   cannot leak into a submission through the promote path.
 */

/**
 * @typedef {object} TextAnchor
 * @property {"text"} kind
 * @property {string} path
 * @property {import("../diff/model.js").Side} side
 * @property {number} line single line only; sub-line ranges cannot span lines
 * @property {number} startOffset UTF-16 code units into the line's text
 * @property {number} endOffset
 * @property {string} quote
 * @property {string} prefix up to 32 chars before the quote, for re-finding it
 * @property {string} suffix
 * @property {AnchorFingerprint} fingerprint
 */

/**
 * @typedef {object} FileAnchor
 * @property {"file"} kind
 * @property {string} path
 */

/** @typedef {LineAnchor | TextAnchor | FileAnchor} Anchor */

/** @param {string} value */
export function hash16(value) {
  return createHash("sha256").update(value, "utf8").digest("hex").slice(0, 16);
}

const MAX_RAW_TEXT = 512;
const CONTEXT_LINES = 3;

/**
 * Build a fingerprint for a line, optionally covering a range.
 *
 * Context is taken in **diff order** rather than new-file order, so the same code works for a
 * LEFT anchor and for a deletion — neither of which has new-file neighbours.
 *
 * @param {object} input
 * @param {import("../diff/model.js").ParsedFile} input.file
 * @param {import("../diff/model.js").DiffLine} input.endLine
 * @param {import("../diff/model.js").DiffLine} [input.startLine]
 * @param {string} input.headSha
 * @returns {AnchorFingerprint}
 */
export function buildFingerprint({ file, endLine, startLine, headSha }) {
  const flat = allDiffLines(file);
  const index = flat.findIndex((line) => line.key === endLine.key);

  /** @type {AnchorFingerprint} */
  const fingerprint = {
    rawText: endLine.text.length > MAX_RAW_TEXT ? endLine.text.slice(0, MAX_RAW_TEXT) : endLine.text,
    textHash: hash16(endLine.text),
    ...neighbourHashes(flat, index),
    hunkHeader: file.hunks[endLine.hunkIndex]?.header ?? "",
    blobSha: file.blobSha,
    headSha,
  };
  if (endLine.text.length > MAX_RAW_TEXT) fingerprint.truncated = true;
  if (startLine && startLine.key !== endLine.key) {
    const from = flat.findIndex((line) => line.key === startLine.key);
    fingerprint.blockHash = blockHashOf(flat, from, index);
    // The count is stored because drift's window scan needs it: `blockHash` covers lines in *diff*
    // order, so it cannot be recovered from `line - startLine` (deletions sit inside the range
    // without consuming a new-side number). Without it the scan would have to try every window
    // length, which is quadratic in file size.
    fingerprint.blockLines = index - from + 1;
  }
  return fingerprint;
}

/**
 * The before/after context hashes for a position in a file's flat diff-line list.
 *
 * Exported so `drift.js` can hash a *candidate* line's neighbours exactly the way the anchor's own
 * hashes were produced. Two independent implementations of this would make every drift comparison
 * quietly unreliable, and no test on either side alone would catch the divergence.
 *
 * @param {import("../diff/model.js").DiffLine[]} flat
 * @param {number} index
 * @returns {{ beforeHash: string, afterHash: string }}
 */
export function neighbourHashes(flat, index) {
  const before = flat
    .slice(Math.max(0, index - CONTEXT_LINES), Math.max(0, index))
    .map((line) => line.text)
    .join("\n");
  const after = flat
    .slice(index + 1, index + 1 + CONTEXT_LINES)
    .map((line) => line.text)
    .join("\n");
  return { beforeHash: hash16(before), afterHash: hash16(after) };
}

/**
 * @param {import("../diff/model.js").DiffLine[]} flat
 * @param {number} from inclusive
 * @param {number} to inclusive
 */
export function blockHashOf(flat, from, to) {
  return hash16(
    flat
      .slice(from, to + 1)
      .map((line) => line.text)
      .join("\n"),
  );
}

/**
 * @typedef {object} SelectedRow
 * @property {import("../diff/model.js").LineKind} kind
 * @property {number | null} oldLine
 * @property {number | null} newLine
 * @property {import("../diff/model.js").LineOrigin} origin
 * @property {string} key
 */

/**
 * Turn a set of selected rows into a single expressible anchor.
 *
 * The interesting case is a selection that crosses sides — the user dragged across deletions and
 * additions. GitHub cannot express that at all (`start_side` and `side` must match), so it is
 * collapsed onto RIGHT and the dropped deletions are recorded so the UI can quote them into the
 * comment body. RIGHT is the right choice because the reviewer's intent in a mixed selection is
 * almost always "the resulting code", and RIGHT is the only side a ```suggestion can apply to.
 *
 * @param {SelectedRow[]} rows
 * @param {import("../diff/model.js").ParsedFile} file
 * @param {string} headSha
 * @returns {{ anchor: LineAnchor, notice?: string } | { error: "empty-selection" | "only-expanded-lines" }}
 */
export function normalizeSelection(rows, file, headSha) {
  const usable = rows.filter((row) => row.origin === "diff");
  if (rows.length === 0) return { error: "empty-selection" };
  if (usable.length === 0) return { error: "only-expanded-lines" };

  /** @type {number[]} */
  const rightNumbers = [];
  /** @type {number[]} */
  const leftNumbers = [];
  for (const row of usable) {
    if (row.kind === "del") {
      if (row.oldLine != null) leftNumbers.push(row.oldLine);
    } else if (row.newLine != null) {
      rightNumbers.push(row.newLine);
    }
  }

  /** @type {import("../diff/model.js").Side} */
  let side;
  /** @type {number[]} */
  let numbers;
  /** @type {string | undefined} */
  let notice;
  /** @type {LineAnchor["droppedRows"]} */
  let droppedRows;

  if (rightNumbers.length > 0) {
    side = "RIGHT";
    numbers = rightNumbers;
    if (leftNumbers.length > 0) {
      droppedRows = { side: "LEFT", lines: [...leftNumbers].sort((a, b) => a - b) };
      notice = `${leftNumbers.length} deleted line${leftNumbers.length === 1 ? "" : "s"} cannot be anchored on GitHub; they will be quoted in the comment body.`;
    }
  } else {
    side = "LEFT";
    numbers = leftNumbers;
  }

  const from = Math.min(...numbers);
  const to = Math.max(...numbers);
  const endLine = lineAt(file, side, to);
  const startLine = from === to ? undefined : lineAt(file, side, from);
  if (!endLine) return { error: "only-expanded-lines" };

  /** @type {LineAnchor} */
  const anchor = {
    kind: "line",
    path: file.path,
    side,
    line: to,
    fingerprint: buildFingerprint({ file, endLine, startLine: startLine ?? undefined, headSha }),
  };
  if (from !== to) {
    anchor.startLine = from;
    anchor.startSide = side;
  }
  if (droppedRows) anchor.droppedRows = droppedRows;
  return notice ? { anchor, notice } : { anchor };
}

/**
 * The anchor for a **question**, which — unlike a comment — need not be somewhere GitHub would
 * accept a review comment.
 *
 * That asymmetry is the reason Ask and Comment are separate actions rather than one gesture with a
 * validation error at the end: asking about a context line, or later about an expanded line
 * outside the diff, is genuinely useful, while commenting there is a guaranteed 422.
 *
 * When the selection does contain commentable rows this defers to `normalizeSelection`, so a
 * question and a comment on the same selection anchor identically and "promote to comment" is a
 * no-op on the address. Only when nothing is commentable does it fall back to a bare,
 * `outsideDiff`-flagged anchor.
 *
 * @param {object} input
 * @param {import("../diff/model.js").ParsedFile} input.file
 * @param {import("../diff/model.js").Side} input.side
 * @param {number} input.from
 * @param {number} input.to
 * @param {string} input.headSha
 * @param {SelectedRow[]} input.rows commentable rows the selection covers; may be empty
 * @returns {{ anchor: LineAnchor, notice?: string }}
 */
export function anchorForQuestion({ file, side, from, to, headSha, rows }) {
  if (rows.length > 0) {
    const normalized = normalizeSelection(rows, file, headSha);
    if (!("error" in normalized)) return normalized;
  }

  const low = Math.min(from, to);
  const high = Math.max(from, to);
  const endLine = rawLineAt(file, side, high);
  const startLine = low === high ? undefined : (rawLineAt(file, side, low) ?? undefined);

  /** @type {LineAnchor} */
  const anchor = {
    kind: "line",
    path: file.path,
    side,
    line: high,
    outsideDiff: true,
    fingerprint: endLine
      ? buildFingerprint({ file, endLine, startLine, headSha })
      : {
          rawText: "",
          textHash: "",
          beforeHash: "",
          afterHash: "",
          hunkHeader: "",
          blobSha: file.blobSha,
          headSha,
        },
  };
  if (low !== high) {
    anchor.startLine = low;
    anchor.startSide = side;
  }
  return { anchor };
}

/**
 * Find a line by side and number **ignoring commentability**. `lineAt` deliberately refuses a line
 * GitHub would not accept; this one is for reading, not for addressing a comment.
 *
 * @param {import("../diff/model.js").ParsedFile} file
 * @param {import("../diff/model.js").Side} side
 * @param {number} number
 * @returns {import("../diff/model.js").DiffLine | null}
 */
export function rawLineAt(file, side, number) {
  for (const hunk of file.hunks) {
    for (const line of hunk.lines) {
      if (side === "LEFT" ? line.oldLine === number : line.newLine === number) return line;
    }
  }
  return null;
}

/**
 * @param {import("../diff/model.js").ParsedFile} file
 * @param {import("../diff/model.js").Side} side
 * @param {number} number
 * @returns {import("../diff/model.js").DiffLine | null}
 */
export function lineAt(file, side, number) {
  for (const hunk of file.hunks) {
    for (const line of hunk.lines) {
      if (side === "LEFT" ? line.oldLine === number : line.newLine === number) {
        if (line.commentableSides.includes(side)) return line;
      }
    }
  }
  return null;
}

/**
 * @typedef {object} GitHubReviewComment
 * @property {string} path
 * @property {string} body
 * @property {number} [line]
 * @property {import("../diff/model.js").Side} [side]
 * @property {number} [start_line]
 * @property {import("../diff/model.js").Side} [start_side]
 * @property {"line" | "file"} [subject_type]
 */

/**
 * Convert an anchor plus a body into GitHub's review-comment shape.
 *
 * A `TextAnchor` produces exactly the same payload as the line that contains it: GitHub has no
 * sub-line granularity, so the quoted substring belongs in the body, not the address.
 *
 * @param {Anchor} anchor
 * @param {string} body
 * @returns {GitHubReviewComment}
 */
export function toGitHubComment(anchor, body) {
  if (anchor.kind === "file") {
    // The line keys must be ABSENT, not null — GitHub errors on an explicit null here.
    return { path: anchor.path, body, subject_type: "file" };
  }

  // No `subject_type` on a line comment. It is a documented field of `POST /pulls/{n}/comments`, but
  // the `comments[]` of a review creation is a different type internally, and sending it there is a
  // hard 422 — verified live:
  //
  //   Variable $threads of type [DraftPullRequestReviewThread] was provided invalid value for
  //   0.subjectType (Field is not defined on DraftPullRequestReviewThread)
  //
  // `"line"` is the default anyway, so the field only ever bought a rejection.
  /** @type {GitHubReviewComment} */
  const comment = { path: anchor.path, body, line: anchor.line, side: anchor.side };
  if (anchor.kind === "line" && anchor.startLine !== undefined) {
    comment.start_line = anchor.startLine;
    comment.start_side = anchor.startSide ?? anchor.side;
  }
  return comment;
}

/**
 * Recover an anchor from a review comment GitHub returned. Used to render existing threads.
 *
 * `position` / `original_position` are read for display only: they are diff-text offsets that
 * GitHub itself has marked as closing down, and they cannot be resolved from a file.
 *
 * @param {import("../gh-fetch.js").GhReviewComment} comment
 * @returns {{ anchor: LineAnchor | FileAnchor | null, outdated: boolean }}
 */
export function anchorFromGitHubComment(comment) {
  if (comment.subject_type === "file") {
    return { anchor: { kind: "file", path: comment.path }, outdated: false };
  }
  const line = comment.line ?? null;
  if (line == null) {
    // `line: null` with a non-null `original_line` is GitHub's way of saying the comment's anchor
    // is no longer part of the diff. There is nowhere valid to place it, so callers render it
    // collapsed against `original_line` and `diff_hunk` instead.
    return { anchor: null, outdated: true };
  }
  const side = comment.side ?? "RIGHT";
  /** @type {LineAnchor} */
  const anchor = {
    kind: "line",
    path: comment.path,
    side,
    line,
    fingerprint: {
      rawText: "",
      textHash: "",
      beforeHash: "",
      afterHash: "",
      hunkHeader: comment.diff_hunk?.split("\n")[0] ?? "",
      blobSha: null,
      headSha: comment.commit_id ?? "",
    },
  };
  if (typeof comment.start_line === "number") {
    anchor.startLine = comment.start_line;
    anchor.startSide = comment.start_side ?? side;
  }
  return { anchor, outdated: false };
}

/** A short human label, for pills and log lines. @param {Anchor} anchor */
export function anchorLabel(anchor) {
  if (anchor.kind === "file") return anchor.path;
  const range =
    anchor.kind === "line" && anchor.startLine !== undefined ? `${anchor.startLine}-${anchor.line}` : `${anchor.line}`;
  const sideMark = anchor.side === "LEFT" ? " (original)" : "";
  return `${anchor.path}:${range}${sideMark}`;
}

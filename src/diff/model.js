/**
 * The parsed-diff data model.
 *
 * Everything downstream — rendering, anchoring, submit validation — reads these shapes, so the
 * one property that matters most is stated here: a line's `commentableSides` is the *only*
 * authority on whether GitHub will accept a comment there. The renderer must not offer a
 * comment affordance on a line whose `commentableSides` is empty, and the validator must not
 * certify one either. Getting that wrong costs an atomic 422 that rejects the whole batch.
 */

/** @typedef {"LEFT" | "RIGHT"} Side */

/** @typedef {"modified" | "added" | "removed" | "renamed" | "copied" | "changed" | "unchanged"} FileStatus */

/**
 * Why a file may have no usable hunks. Distinguishing these matters because they imply
 * different UI and different comment capabilities.
 *
 * - `present`      — parsed into at least one hunk
 * - `empty`        — legitimately no patch (pure rename, mode-only change, submodule bump)
 * - `absent-binary`— binary file; GitHub accepts a file-level comment but no line comment
 * - `absent-large` — GitHub omitted the patch; it answers `path diff too large` for comments
 * - `truncated`    — a patch we could not account for byte-for-byte, so it is untrustworthy
 *
 * @typedef {"present" | "empty" | "absent-binary" | "absent-large" | "truncated"} PatchAvailability
 */

/** @typedef {"context" | "add" | "del"} LineKind */

/**
 * `diff` lines came out of the patch and may be commented on. `expanded` lines were fetched
 * separately to show surrounding context; they are readable but are NOT part of the diff, so
 * commenting on them is a guaranteed 422.
 *
 * @typedef {"diff" | "expanded"} LineOrigin
 */

/**
 * @typedef {object} DiffLine
 * @property {string} key stable within a ParsedFile for one parse; `h{hunk}:{index}`
 * @property {number} hunkIndex
 * @property {number} indexInHunk 0-based, in diff order
 * @property {LineKind} kind
 * @property {number | null} oldLine null for `add`
 * @property {number | null} newLine null for `del`
 * @property {string} text content WITHOUT the leading ' '/'+'/'-'; may end in '\r'; never '\n'
 * @property {true} [noNewlineAtEof] a `\ No newline at end of file` marker followed this line
 * @property {LineOrigin} origin
 * @property {readonly Side[]} commentableSides empty for `expanded`
 */

/**
 * @typedef {object} Hunk
 * @property {number} index 0-based within the file
 * @property {string} header the raw `@@ -a,b +c,d @@ section` line
 * @property {number} oldStart
 * @property {number} oldCount
 * @property {number} newStart
 * @property {number} newCount
 * @property {string} sectionHeading everything after the second `@@ `; '' when absent
 * @property {DiffLine[]} lines diff order; markers folded into `noNewlineAtEof`
 */

/**
 * @typedef {"bad-hunk-header" | "hunk-count-mismatch" | "unknown-line-prefix" | "marker-without-line"
 *   | "nonmonotonic-hunks" | "patch-missing" | "path-mismatch-between-sources"} DiagnosticCode
 */

/**
 * @typedef {object} Diagnostic
 * @property {DiagnosticCode} code
 * @property {boolean} fatal a fatal diagnostic marks the file `degraded`
 * @property {number} [hunkIndex]
 * @property {number} [lineIndex]
 * @property {string} detail
 */

/**
 * @typedef {object} ParsedFile
 * @property {string} path GitHub's `filename` — the file's CURRENT path. The only value ever
 *   placed in a review comment's `path`, including for `side: "LEFT"` comments.
 * @property {string | null} previousPath GitHub's `previous_filename`. Display and base-blob
 *   permalinks only; never a comment `path`.
 * @property {FileStatus} status
 * @property {number} additions
 * @property {number} deletions
 * @property {number} changes
 * @property {string | null} blobSha blob SHA at head
 * @property {boolean} isBinary
 * @property {PatchAvailability} patchAvailability
 * @property {string | null} rawPatch
 * @property {Hunk[]} hunks
 * @property {Record<string, DiffLine[]>} expanded keyed `beforeHunk:{i}` / `afterHunk:{i}` / `eof`
 * @property {boolean} fileCommentable whether `subject_type: "file"` is expected to be accepted
 * @property {Diagnostic[]} diagnostics
 * @property {boolean} degraded any fatal diagnostic; the validator certifies nothing in this file
 */

/**
 * @typedef {object} ParsedDiff
 * @property {string} host
 * @property {string} owner
 * @property {string} repo
 * @property {number} prNumber
 * @property {string} headSha goes into the review POST's `commit_id`
 * @property {string} baseSha merge base; used for LEFT-side blob permalinks
 * @property {ParsedFile[]} files
 * @property {Map<string, ParsedFile>} byPath
 * @property {string} fetchedAt
 * @property {"files-api" | "pr-diff" | "merged"} source
 * @property {boolean} fileCountCapped the files endpoint returned its 3000-entry maximum
 */

/** GitHub's files endpoint returns at most this many entries. */
export const GITHUB_FILES_CAP = 3000;

export const SIDE_LEFT = /** @type {Side} */ ("LEFT");
export const SIDE_RIGHT = /** @type {Side} */ ("RIGHT");

/** Frozen so the shared arrays can be handed out without defensive copying. */
const RIGHT_ONLY = /** @type {readonly Side[]} */ (Object.freeze([SIDE_RIGHT]));
const LEFT_ONLY = /** @type {readonly Side[]} */ (Object.freeze([SIDE_LEFT]));
const NONE = /** @type {readonly Side[]} */ (Object.freeze([]));

/**
 * Which side(s) GitHub will accept a comment on for a given line.
 *
 * A context line genuinely exists on both sides, and GitHub does accept `side: "LEFT"` at its
 * old number. We deliberately report RIGHT only: the docs define RIGHT as "additions **and
 * unchanged context lines**", and RIGHT-on-context is the form GitHub's own UI emits, so it is
 * the exhaustively-exercised path. `normalizeAnchor` losslessly rewrites a LEFT-on-context
 * anchor to RIGHT at the same source line, which turns a possible batch-killing false positive
 * into zero risk at no cost in expressiveness.
 *
 * @param {LineKind} kind
 * @param {LineOrigin} origin
 * @returns {readonly Side[]}
 */
export function commentableSidesFor(kind, origin) {
  if (origin === "expanded") return NONE;
  if (kind === "del") return LEFT_ONLY;
  return RIGHT_ONLY; // add and context
}

/** @param {number} hunkIndex @param {number} indexInHunk */
export function lineKeyFor(hunkIndex, indexInHunk) {
  return `h${hunkIndex}:${indexInHunk}`;
}

/**
 * @param {Partial<ParsedFile>} [overrides]
 * @returns {ParsedFile}
 */
export function emptyParsedFile(overrides = {}) {
  return {
    path: "",
    previousPath: null,
    status: "modified",
    additions: 0,
    deletions: 0,
    changes: 0,
    blobSha: null,
    isBinary: false,
    patchAvailability: "empty",
    rawPatch: null,
    hunks: [],
    expanded: {},
    fileCommentable: true,
    diagnostics: [],
    degraded: false,
    ...overrides,
  };
}

/** @param {ParsedFile} file */
export function allDiffLines(file) {
  return file.hunks.flatMap((hunk) => hunk.lines);
}

/** @param {Diagnostic[]} diagnostics */
export function hasFatal(diagnostics) {
  return diagnostics.some((diagnostic) => diagnostic.fatal);
}

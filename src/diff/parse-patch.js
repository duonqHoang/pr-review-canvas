import { commentableSidesFor, emptyParsedFile, hasFatal, lineKeyFor } from "./model.js";

/**
 * Unified-diff hunk parser.
 *
 * Two rules govern everything here:
 *
 * 1. **Split on `\n` only, never `/\r?\n/`.** A trailing `\r` is real file content in a CRLF
 *    repository. Dropping it corrupts ```suggestion payloads (GitHub would silently rewrite the
 *    file's line endings) and corrupts the drift fingerprints.
 * 2. **Fail closed.** If the body cannot be accounted for against the header's counts, the file
 *    is marked `degraded` and yields *zero* commentable lines. Because the review POST is
 *    atomic, one plausible-looking wrong line kills the entire batch — so a handful of false
 *    negatives is a much better trade than any false positive.
 */

/**
 * Matches a hunk header of the form `-a[,b] +c[,d]` between two at-at fences, with an optional
 * trailing section heading.
 *
 * The counts are optional: real git emits a bare `-1 +1` form when the range is exactly one
 * line. The section heading capture is greedy, so a heading that itself contains an at-at fence
 * still parses correctly.
 */
export const HUNK_HEADER_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(?:[ ](.*))?$/;

const NO_NEWLINE_MARKER = "\\ No newline at end of file";

/**
 * @typedef {object} ParsePatchResult
 * @property {import("./model.js").Hunk[]} hunks
 * @property {import("./model.js").Diagnostic[]} diagnostics
 */

/**
 * Parse the `patch` fragment GitHub returns per file. It starts at that file's first at-at
 * header and usually has no trailing newline.
 *
 * @param {string} patch
 * @param {{ trustCounts?: boolean }} [options] `trustCounts: false` skips the reconciliation
 *   check, for inputs whose header counts describe more than the body actually contains. Only
 *   {@link parseDiffHunkWindow} should pass it.
 * @returns {ParsePatchResult}
 */
export function parsePatch(patch, options = {}) {
  const trustCounts = options.trustCounts !== false;
  /** @type {import("./model.js").Hunk[]} */
  const hunks = [];
  /** @type {import("./model.js").Diagnostic[]} */
  const diagnostics = [];

  const text = String(patch ?? "");
  if (!text) return { hunks, diagnostics };

  const rawLines = text.split("\n");
  // A terminal newline produces one trailing "" that is not a diff line.
  if (rawLines.length > 0 && rawLines[rawLines.length - 1] === "") rawLines.pop();

  /** @type {import("./model.js").Hunk | null} */
  let hunk = null;
  let oldCursor = 0;
  let newCursor = 0;
  let contextCount = 0;
  let addCount = 0;
  let delCount = 0;

  const closeHunk = () => {
    if (!hunk) return;
    // The load-bearing check. `context + del` must exactly reconstruct the old range and
    // `context + add` the new one; anything else means we misread the body.
    if (trustCounts && (contextCount + delCount !== hunk.oldCount || contextCount + addCount !== hunk.newCount)) {
      diagnostics.push({
        code: "hunk-count-mismatch",
        fatal: true,
        hunkIndex: hunk.index,
        detail:
          `header declares -${hunk.oldCount} +${hunk.newCount} but the body has ` +
          `${contextCount} context, ${delCount} deletions, ${addCount} additions`,
      });
    }
    hunks.push(hunk);
    hunk = null;
  };

  for (let i = 0; i < rawLines.length; i += 1) {
    const raw = rawLines[i];

    if (raw.startsWith("@@")) {
      closeHunk();
      const match = HUNK_HEADER_RE.exec(raw);
      if (!match) {
        diagnostics.push({
          code: "bad-hunk-header",
          fatal: true,
          lineIndex: i,
          detail: `could not parse hunk header: ${raw.slice(0, 120)}`,
        });
        // Abandon the rest of the file: without a trustworthy header every subsequent line
        // number would be a guess.
        break;
      }
      const oldStart = Number(match[1]);
      const oldCount = match[2] === undefined ? 1 : Number(match[2]);
      const newStart = Number(match[3]);
      const newCount = match[4] === undefined ? 1 : Number(match[4]);

      const previous = hunks[hunks.length - 1];
      if (previous && newStart < previous.newStart + previous.newCount) {
        diagnostics.push({
          code: "nonmonotonic-hunks",
          fatal: true,
          hunkIndex: hunks.length,
          detail: `hunk starting at +${newStart} overlaps the previous hunk ending at +${previous.newStart + previous.newCount - 1}`,
        });
      }

      hunk = {
        index: hunks.length,
        header: raw,
        oldStart,
        oldCount,
        newStart,
        newCount,
        sectionHeading: match[5] ?? "",
        lines: [],
      };
      // A zero count means an empty range on that side, and `start` is then the line *before*
      // the insertion point. Starting the cursor at `start` in that case would hand out a line
      // number that is not in the diff, so only advance from `start` when the range is non-empty.
      oldCursor = oldStart;
      newCursor = newStart;
      contextCount = 0;
      addCount = 0;
      delCount = 0;
      continue;
    }

    if (!hunk) {
      // Text before the first `@@`. The whole-diff parser routes extended headers through here.
      continue;
    }

    if (raw.startsWith("\\")) {
      // `\ No newline at end of file` is not a line of content. It attaches to the line above
      // it, and a single hunk can legitimately carry two of them (one per side).
      const previousLine = hunk.lines[hunk.lines.length - 1];
      if (previousLine) {
        previousLine.noNewlineAtEof = true;
      } else {
        diagnostics.push({
          code: "marker-without-line",
          fatal: false,
          hunkIndex: hunk.index,
          lineIndex: i,
          detail: `${NO_NEWLINE_MARKER} appeared with no preceding line`,
        });
      }
      continue;
    }

    const prefix = raw[0] ?? "";
    /** @type {import("./model.js").LineKind} */
    let kind;
    if (prefix === " ") kind = "context";
    else if (prefix === "+") kind = "add";
    else if (prefix === "-") kind = "del";
    else if (raw === "") {
      // Real git writes an empty context line as a single space, but some producers (and any
      // trailing-whitespace-trimming pipeline) strip it. Read it as an empty context line and
      // record a non-fatal note: unlike a stray prefix, this shape is unambiguous.
      kind = "context";
      diagnostics.push({
        code: "unknown-line-prefix",
        fatal: false,
        hunkIndex: hunk.index,
        lineIndex: i,
        detail: "empty line with no prefix, read as an empty context line",
      });
    } else {
      // Fatal, and not for the reason you might expect. The tempting assumption is that the
      // count check downstream will catch this — it does not. A stray line can sit inside a hunk
      // whose remaining lines still reconcile exactly with the header, so the counts pass while
      // we have silently dropped real content. That yields a file whose line numbers look right
      // and whose text is wrong, which is the worst possible outcome for anchoring. If we cannot
      // classify a line, we do not trust the file.
      diagnostics.push({
        code: "unknown-line-prefix",
        fatal: true,
        hunkIndex: hunk.index,
        lineIndex: i,
        detail: `unexpected line prefix ${JSON.stringify(prefix)}`,
      });
      continue;
    }

    const content = raw === "" ? "" : raw.slice(1);
    const indexInHunk = hunk.lines.length;
    /** @type {import("./model.js").DiffLine} */
    const line = {
      key: lineKeyFor(hunk.index, indexInHunk),
      hunkIndex: hunk.index,
      indexInHunk,
      kind,
      oldLine: kind === "add" ? null : oldCursor,
      newLine: kind === "del" ? null : newCursor,
      text: content,
      origin: "diff",
      commentableSides: commentableSidesFor(kind, "diff"),
    };
    if (kind === "context") {
      contextCount += 1;
      oldCursor += 1;
      newCursor += 1;
    } else if (kind === "add") {
      addCount += 1;
      newCursor += 1;
    } else {
      delCount += 1;
      oldCursor += 1;
    }
    hunk.lines.push(line);
  }

  closeHunk();
  return { hunks, diagnostics };
}

/**
 * Parse a review comment's `diff_hunk`.
 *
 * This is NOT a patch. GitHub sends a trailing *window* of the hunk — typically the four or so
 * lines ending at the commented line — but rewrites the header's start numbers to describe that
 * window while leaving the counts describing the full hunk. So the starts are trustworthy and
 * the counts are not, which is why the reconciliation check has to be switched off here. Doing
 * that anywhere else would forfeit the parser's main safety property.
 *
 * The last body line is the line the comment is anchored to.
 *
 * @param {string} diffHunk
 * @returns {{ hunk: import("./model.js").Hunk | null, anchoredLine: import("./model.js").DiffLine | null }}
 */
export function parseDiffHunkWindow(diffHunk) {
  const { hunks } = parsePatch(diffHunk, { trustCounts: false });
  const hunk = hunks.length > 0 ? hunks[hunks.length - 1] : null;
  const anchoredLine = hunk && hunk.lines.length > 0 ? hunk.lines[hunk.lines.length - 1] : null;
  return { hunk, anchoredLine };
}

/**
 * Re-emit hunks as a patch string. Used by the round-trip property test, which is the single
 * strongest guard in this layer: it catches prefix, CRLF and marker-folding regressions at once.
 *
 * @param {import("./model.js").Hunk[]} hunks
 * @returns {string}
 */
export function serializeHunks(hunks) {
  /** @type {string[]} */
  const out = [];
  for (const hunk of hunks) {
    out.push(hunk.header);
    for (const line of hunk.lines) {
      const prefix = line.kind === "add" ? "+" : line.kind === "del" ? "-" : " ";
      out.push(`${prefix}${line.text}`);
      if (line.noNewlineAtEof) out.push(NO_NEWLINE_MARKER);
    }
  }
  return out.join("\n");
}

/**
 * @typedef {object} GhFileEntry
 * @property {string} filename
 * @property {string} [previous_filename]
 * @property {string} [status]
 * @property {number} [additions]
 * @property {number} [deletions]
 * @property {number} [changes]
 * @property {string} [patch]
 * @property {string} [sha]
 */

/**
 * Build a {@link import("./model.js").ParsedFile} from one entry of
 * `GET /repos/{owner}/{repo}/pulls/{n}/files`.
 *
 * @param {GhFileEntry} entry
 * @returns {import("./model.js").ParsedFile}
 */
export function parseFileEntry(entry) {
  const status = /** @type {import("./model.js").FileStatus} */ (String(entry.status ?? "modified"));
  const additions = Number(entry.additions ?? 0);
  const deletions = Number(entry.deletions ?? 0);
  const changes = Number(entry.changes ?? additions + deletions);
  const patch = typeof entry.patch === "string" ? entry.patch : null;

  const file = emptyParsedFile({
    path: String(entry.filename ?? ""),
    previousPath: entry.previous_filename ? String(entry.previous_filename) : null,
    status,
    additions,
    deletions,
    changes,
    blobSha: entry.sha ? String(entry.sha) : null,
    rawPatch: patch,
  });

  if (patch === null) {
    // No patch. Distinguish "nothing to show" from "GitHub withheld it", because only the
    // latter means line comments are impossible.
    if (changes === 0) {
      file.patchAvailability = "empty";
      file.fileCommentable = true;
    } else {
      // We cannot tell binary from oversized here — the files endpoint omits `patch` for both.
      // Treat it as large-and-withheld, which is the stricter of the two: it disables line
      // comments AND file comments, so a caller that knows better can relax it.
      file.patchAvailability = "absent-large";
      file.fileCommentable = false;
      file.diagnostics.push({
        code: "patch-missing",
        fatal: false,
        detail: `${changes} changed lines but no patch was returned (binary file, or diff too large)`,
      });
    }
    return file;
  }

  const { hunks, diagnostics } = parsePatch(patch);
  file.hunks = hunks;
  file.diagnostics = diagnostics;
  file.degraded = hasFatal(diagnostics);
  file.patchAvailability = file.degraded ? "truncated" : hunks.length > 0 ? "present" : "empty";
  // A degraded parse means we cannot certify any line, and a file-level comment on a file whose
  // diff we misread is just as likely to be wrong, so withhold both.
  file.fileCommentable = !file.degraded;
  return file;
}

/**
 * Mark a file as binary. The files endpoint does not say so directly; callers that learn it
 * from the whole-diff output (`Binary files ... differ`) apply it here.
 *
 * @param {import("./model.js").ParsedFile} file
 * @returns {import("./model.js").ParsedFile}
 */
export function markBinary(file) {
  return {
    ...file,
    isBinary: true,
    patchAvailability: "absent-binary",
    // GitHub does accept a file-level comment on a binary file.
    fileCommentable: !file.degraded,
    hunks: [],
  };
}

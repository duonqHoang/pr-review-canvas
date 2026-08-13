import {
  buildCommentableIndex,
  expandedForSide,
  intervalContaining,
  isCommentable,
  isRangeCommentable,
  linesForSide,
  nearestCommentableLine,
} from "../diff/index-lines.js";
import { toGitHubComment } from "./anchor.js";
import { effectiveBody, validateSuggestion } from "./suggestion.js";

/**
 * Anchor validation — the gate that stands between a drafted comment and an atomic 422.
 *
 * `POST /pulls/{n}/reviews` is all-or-nothing. If one comment's `(path, line, side)` is not part
 * of the diff, GitHub answers 422 with `pull_request_review_thread.line must be part of the diff`
 * and rejects *every* comment in the batch. So this module has to be exactly as strict as GitHub:
 * a false negative blocks one legitimate comment, but a false positive destroys the whole review.
 * When in doubt, refuse.
 */

/**
 * @typedef {"file-not-in-diff" | "file-referenced-by-old-path" | "file-patch-unavailable"
 *   | "file-parse-degraded" | "file-comment-not-supported"
 *   | "line-not-in-diff" | "range-not-fully-in-diff" | "expanded-context-not-commentable"
 *   | "start-line-not-less-than-line" | "side-mismatch-across-range"
 *   | "text-offsets-out-of-range"
 *   | import("./suggestion.js").SuggestionReason} ValidationReason
 */

/**
 * @typedef {"same-line-other-side" | "nearest-in-hunk" | "clamp-to-hunk" | "rewrite-path"
 *   | "drop-start-line" | "swap-range"} RepairKind
 */

/**
 * @typedef {object} NearestValid
 * @property {import("./anchor.js").LineAnchor} anchor
 * @property {number} distance
 * @property {RepairKind} how
 */

/**
 * @typedef {{ ok: true, normalized: import("./anchor.js").Anchor,
 *   payload: import("./anchor.js").GitHubReviewComment, warnings: string[] }
 *   | { ok: false, reason: ValidationReason, message: string, nearestValid?: NearestValid }} ValidationResult
 */

/**
 * @typedef {object} ValidateOptions
 * @property {boolean} [allowLeftOnContext] default false — see the note in model.js
 * @property {number} [maxNearestDistance] default 20
 */

/**
 * @param {import("./anchor.js").Anchor} anchor
 * @param {import("../diff/model.js").ParsedFile | undefined} file
 * @param {string} body
 * @param {import("../diff/model.js").ParsedFile[]} [allFiles] used to detect a stale path
 * @param {ValidateOptions} [options]
 * @returns {ValidationResult}
 */
export function validateAnchor(anchor, file, body, allFiles = [], options = {}) {
  const allowLeftOnContext = options.allowLeftOnContext === true;
  const maxNearestDistance = options.maxNearestDistance ?? 20;

  // 1. The file must be in the diff at its current path.
  if (!file) {
    const renamed = allFiles.find((candidate) => candidate.previousPath === anchor.path);
    if (renamed) {
      return {
        ok: false,
        reason: "file-referenced-by-old-path",
        message: `\`${anchor.path}\` was renamed to \`${renamed.path}\` in this pull request; a comment must use the new path.`,
        ...(anchor.kind === "line"
          ? { nearestValid: { anchor: { ...anchor, path: renamed.path }, distance: 0, how: "rewrite-path" } }
          : {}),
      };
    }
    return {
      ok: false,
      reason: "file-not-in-diff",
      message: `\`${anchor.path}\` is not one of the files changed in this pull request.`,
    };
  }

  // 2. Fail closed on a file we could not account for byte-for-byte.
  if (file.degraded) {
    return {
      ok: false,
      reason: "file-parse-degraded",
      message: `The diff for \`${file.path}\` could not be parsed reliably, so no comment on it can be verified.`,
    };
  }

  // 3. File-level comments bypass every line rule.
  if (anchor.kind === "file") {
    if (!file.fileCommentable) {
      return {
        ok: false,
        reason: "file-comment-not-supported",
        message: `GitHub will not accept a file-level comment on \`${file.path}\`.`,
      };
    }
    return { ok: true, normalized: anchor, payload: toGitHubComment(anchor, body), warnings: [] };
  }

  if (file.patchAvailability !== "present") {
    return {
      ok: false,
      reason: "file-patch-unavailable",
      message:
        file.patchAvailability === "absent-binary"
          ? `\`${file.path}\` is binary, so it has no lines to comment on. Use a file-level comment.`
          : `GitHub did not provide a diff for \`${file.path}\`, so line comments on it are impossible.`,
    };
  }

  const index = buildCommentableIndex(file);
  /** @type {string[]} */
  const warnings = [];
  let working = /** @type {import("./anchor.js").LineAnchor | import("./anchor.js").TextAnchor} */ ({ ...anchor });

  // 4. Normalize a LEFT anchor that actually points at a context line.
  if (!allowLeftOnContext && working.side === "LEFT") {
    const leftLine = linesForSide(index, "LEFT").get(working.line);
    const contextLine = !leftLine ? findContextByOldLine(file, working.line) : null;
    if (contextLine && contextLine.newLine != null) {
      working = { ...working, side: "RIGHT", line: contextLine.newLine };
      if (working.kind === "line" && working.startSide === "LEFT") working.startSide = "RIGHT";
      warnings.push("normalized-left-context-to-right");
    }
  }

  const side = working.side;

  // 5. Multi-line rules, before the single-line check: `line` must be the LAST line.
  if (working.kind === "line" && working.startLine !== undefined) {
    const startSide = working.startSide ?? side;
    if (startSide !== side) {
      return {
        ok: false,
        reason: "side-mismatch-across-range",
        message: "A multi-line comment must start and end on the same side of the diff.",
      };
    }
    if (working.startLine === working.line) {
      // Unambiguous: a one-line range is just a single-line comment.
      const single = { ...working };
      delete single.startLine;
      delete single.startSide;
      warnings.push("dropped-redundant-start-line");
      working = single;
    } else if (working.startLine > working.line) {
      const swapped = { ...working, startLine: working.line, line: working.startLine };
      return {
        ok: false,
        reason: "start-line-not-less-than-line",
        message: `The range is inverted: start line ${working.startLine} is after end line ${working.line}.`,
        nearestValid: { anchor: swapped, distance: 0, how: "swap-range" },
      };
    }
  }

  if (working.kind === "line" && working.startLine !== undefined) {
    if (!isRangeCommentable(index, side, working.startLine, working.line)) {
      const enclosing = intervalContaining(index, side, working.line);
      return {
        ok: false,
        reason: "range-not-fully-in-diff",
        message:
          `Lines ${working.startLine}-${working.line} of \`${file.path}\` are not all part of the diff. ` +
          `GitHub rejects a range that spans a gap between hunks, even when both ends are valid.`,
        ...(enclosing
          ? {
              nearestValid: {
                anchor: { ...working, startLine: Math.max(working.startLine, enclosing[0]) },
                distance: Math.abs(working.startLine - Math.max(working.startLine, enclosing[0])),
                how: "clamp-to-hunk",
              },
            }
          : {}),
      };
    }
  } else if (!isCommentable(index, side, working.line)) {
    // Single line, not in the diff. Work out the most useful thing to say about it.
    const otherSide = side === "LEFT" ? "RIGHT" : "LEFT";
    if (isCommentable(index, otherSide, working.line)) {
      return {
        ok: false,
        reason: "line-not-in-diff",
        message: `Line ${working.line} of \`${file.path}\` is only commentable on the ${otherSide === "LEFT" ? "original" : "new"} side.`,
        nearestValid: {
          anchor: { ...working, kind: "line", side: otherSide },
          distance: 0,
          how: "same-line-other-side",
        },
      };
    }
    if (expandedForSide(index, side).has(working.line)) {
      const nearest = nearestCommentableLine(index, side, working.line, maxNearestDistance);
      return {
        ok: false,
        reason: "expanded-context-not-commentable",
        message: `Line ${working.line} of \`${file.path}\` is context outside the diff. GitHub only accepts comments on lines that are part of the diff.`,
        ...(nearest
          ? {
              nearestValid: {
                anchor: { ...working, kind: "line", line: nearest.line },
                distance: nearest.distance,
                how: "nearest-in-hunk",
              },
            }
          : {}),
      };
    }
    const nearest = nearestCommentableLine(index, side, working.line, maxNearestDistance);
    return {
      ok: false,
      reason: "line-not-in-diff",
      message: `Line ${working.line} of \`${file.path}\` is not part of the diff.`,
      ...(nearest
        ? {
            nearestValid: {
              anchor: { ...working, kind: "line", line: nearest.line },
              distance: nearest.distance,
              how: "nearest-in-hunk",
            },
          }
        : {}),
    };
  }

  // 6. Sub-line offsets. Non-blocking: the payload is line-granular anyway, so a stale quote
  // degrades to a comment on the whole line rather than failing the batch.
  if (working.kind === "text") {
    const line = linesForSide(index, side).get(working.line);
    const text = line?.text ?? "";
    if (text.slice(working.startOffset, working.endOffset) !== working.quote) {
      const refound = refindQuote(text, working);
      if (refound) {
        working = { ...working, startOffset: refound.startOffset, endOffset: refound.endOffset };
        warnings.push("re-found-quote-at-new-offsets");
      } else {
        warnings.push("quote-no-longer-matches-degraded-to-line");
      }
    }
  }

  return { ok: true, normalized: working, payload: toGitHubComment(working, body), warnings };
}

/**
 * @param {import("../diff/model.js").ParsedFile} file
 * @param {number} oldLine
 */
function findContextByOldLine(file, oldLine) {
  for (const hunk of file.hunks) {
    for (const line of hunk.lines) {
      if (line.kind === "context" && line.oldLine === oldLine) return line;
    }
  }
  return null;
}

/**
 * Re-find a quoted substring by its surrounding text, then by itself. Only a unique match counts:
 * silently picking one of several occurrences would point the comment at different code.
 *
 * @param {string} text
 * @param {import("./anchor.js").TextAnchor} anchor
 * @returns {{ startOffset: number, endOffset: number } | null}
 */
export function refindQuote(text, anchor) {
  const withContext = `${anchor.prefix}${anchor.quote}${anchor.suffix}`;
  const contextIndex = text.indexOf(withContext);
  if (contextIndex >= 0 && text.indexOf(withContext, contextIndex + 1) < 0) {
    const start = contextIndex + anchor.prefix.length;
    return { startOffset: start, endOffset: start + anchor.quote.length };
  }
  const bare = text.indexOf(anchor.quote);
  if (bare >= 0 && text.indexOf(anchor.quote, bare + 1) < 0) {
    return { startOffset: bare, endOffset: bare + anchor.quote.length };
  }
  return null;
}

/**
 * @typedef {object} DraftForValidation
 * @property {string} id
 * @property {import("./anchor.js").Anchor} anchor
 * @property {string} body
 * @property {import("./suggestion.js").Suggestion} [suggestion]
 */

/**
 * Validate a whole batch. Returns a payload **only** when nothing is blocking, because the POST
 * is atomic: submitting a batch with one known-bad comment fails all of them.
 *
 * `nearestValid` repairs are never applied automatically. They are surfaced for the human to
 * accept, then revalidated — submitting a comment against code the user never read is a worse
 * outcome than a 422.
 *
 * @param {DraftForValidation[]} drafts
 * @param {import("../snapshot.js").Snapshot} snapshot
 * @param {ValidateOptions} [options]
 */
export function validateBatch(drafts, snapshot, options = {}) {
  /** @type {Record<string, ValidationResult>} */
  const results = {};
  /** @type {string[]} */
  const blocking = [];
  /** @type {import("./anchor.js").GitHubReviewComment[]} */
  const comments = [];

  for (const draft of drafts) {
    const file = snapshot.byPath.get(draft.anchor.path);
    // The rendered body is what GitHub receives, so it is what gets validated and what the digest
    // is taken over. Rendering in one place is the only way the text the human approved and the
    // text that is posted cannot drift apart.
    const result = validateAnchor(draft.anchor, file, effectiveBody(draft), snapshot.files, options);
    if (!result.ok) {
      results[draft.id] = result;
      blocking.push(draft.id);
      continue;
    }

    // The suggestion check runs last, on the *normalized* anchor, because it depends on which side
    // and range validation settled on.
    if (draft.suggestion && file) {
      const check = validateSuggestion(result.normalized, draft.suggestion, file);
      if (!check.ok) {
        results[draft.id] = { ok: false, reason: check.reason, message: check.message };
        blocking.push(draft.id);
        continue;
      }
      result.warnings.push(...check.warnings);
    }

    results[draft.id] = result;
    comments.push(result.payload);
  }

  return {
    ok: blocking.length === 0,
    results,
    blocking,
    ...(blocking.length === 0 ? { payload: { commit_id: snapshot.headSha, comments } } : {}),
  };
}

/**
 * Human-readable one-liner for each failure, for the CLI's error hints.
 *
 * @param {DraftForValidation[]} drafts
 * @param {Record<string, ValidationResult>} results
 * @returns {string[]}
 */
export function describeFailures(drafts, results) {
  /** @type {string[]} */
  const lines = [];
  for (const draft of drafts) {
    const result = results[draft.id];
    if (!result || result.ok) continue;
    const where = draft.anchor.kind === "file" ? draft.anchor.path : `${draft.anchor.path}:${draft.anchor.line}`;
    lines.push(`${where} — ${result.message}`);
  }
  return lines;
}

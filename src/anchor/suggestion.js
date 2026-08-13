import { createHash } from "node:crypto";
import { buildCommentableIndex, linesForSide } from "../diff/index-lines.js";
import { normalizeSelection } from "./anchor.js";

/**
 * ```suggestion blocks.
 *
 * GitHub applies a suggestion by **replacing exactly the line range the comment is anchored to**,
 * on the head branch. Every rule in this module follows from that single fact:
 *
 * 1. RIGHT only. The LEFT side does not exist on the head branch, so there is nothing to replace.
 * 2. The base lines are the RIGHT-commentable lines in `[startLine ?? line, line]`, and their hash
 *    is stored with the draft.
 * 3. **Changing the range changes the anchor.** `setSuggestionRange` recomputes the anchor, the base
 *    lines and the hash together or fails; they are one object, not two.
 * 4. The hash is recomputed before submit. A mismatch blocks, because applying an edit to code the
 *    user never saw is the worst failure this tool could produce — worse than a 422.
 * 5. An empty fence is meaningful: it deletes those lines. That is not the same as a fence
 *    containing one empty line, which replaces them with a blank line.
 * 6. A CRLF file must get CRLF back, or GitHub's "Commit suggestion" reformats the whole file.
 * 7. The fence must be longer than any backtick run inside the replacement.
 * 8. A last line marked `\ No newline at end of file` cannot be expressed: a suggestion always
 *    writes a trailing newline. Flagged rather than silently wrong.
 */

/** @typedef {"LF" | "CRLF"} Eol */

/**
 * @typedef {object} Suggestion
 * @property {string[]} baseLines verbatim text of the replaced lines, `\r` included
 * @property {string} baseHash `sha256:<hex>` of `baseLines.join("\n")`
 * @property {string[]} replacementLines what to put there, **without** any `\r`
 * @property {Eol} eol
 * @property {true} [noNewlineAtEof] the last base line had no trailing newline
 */

/**
 * @typedef {"suggestion-side-not-right" | "suggestion-requires-line-anchor"
 *   | "suggestion-base-not-in-diff" | "suggestion-base-drift"} SuggestionReason
 */

/** A suggestion this large is a rewrite, not a review comment. */
export const MAX_SUGGESTION_LINES = 200;

/**
 * The RIGHT-commentable diff lines covering `[from, to]`, or null if any of them is missing.
 *
 * Deletions are absent by construction — they live on LEFT — which is exactly right: a suggestion
 * replaces the resulting lines, not the removed ones.
 *
 * @param {import("../diff/model.js").ParsedFile} file
 * @param {number} from
 * @param {number} to
 * @returns {import("../diff/model.js").DiffLine[] | null}
 */
export function baseLinesFor(file, from, to) {
  const lines = linesForSide(buildCommentableIndex(file), "RIGHT");
  /** @type {import("../diff/model.js").DiffLine[]} */
  const out = [];
  for (let number = Math.min(from, to); number <= Math.max(from, to); number += 1) {
    const line = lines.get(number);
    if (!line) return null;
    out.push(line);
  }
  return out.length > 0 ? out : null;
}

/** @param {string[]} lines */
export function hashBaseLines(lines) {
  return `sha256:${createHash("sha256").update(lines.join("\n"), "utf8").digest("hex")}`;
}

/**
 * CRLF only when **every** base line ends in `\r`. A mixed-ending range is left as LF, because
 * re-attaching `\r` to lines that did not have it would be a change the user never asked for.
 *
 * @param {string[]} lines
 * @returns {Eol}
 */
export function detectEol(lines) {
  return lines.length > 0 && lines.every((text) => text.endsWith("\r")) ? "CRLF" : "LF";
}

/** @param {string[]} lines */
export function stripCr(lines) {
  return lines.map((text) => (text.endsWith("\r") ? text.slice(0, -1) : text));
}

/** @param {string[]} lines @param {Eol} eol */
export function applyEol(lines, eol) {
  return eol === "CRLF" ? lines.map((text) => (text.endsWith("\r") ? text : `${text}\r`)) : stripCr(lines);
}

/**
 * A fence longer than any backtick run in the content. Three at minimum, because that is the fence
 * GitHub recognises.
 *
 * @param {string} content
 * @returns {string}
 */
export function fenceFor(content) {
  let longest = 0;
  for (const run of String(content ?? "").matchAll(/`+/g)) longest = Math.max(longest, run[0].length);
  return "`".repeat(Math.max(3, longest + 1));
}

/**
 * The body actually posted to GitHub: the user's comment, then the suggestion block.
 *
 * @param {string} comment
 * @param {Suggestion} suggestion
 * @returns {string}
 */
export function renderSuggestionBody(comment, suggestion) {
  const lines = applyEol(suggestion.replacementLines, suggestion.eol);
  const fence = fenceFor(lines.join("\n"));
  // An empty `replacementLines` produces an empty fence, which is GitHub's way of saying "delete
  // these lines". The trailing newline is therefore conditional: adding it unconditionally would
  // turn a deletion into a replacement with one blank line.
  const block = `${fence}suggestion\n${lines.join("\n")}${lines.length > 0 ? "\n" : ""}${fence}`;
  const text = String(comment ?? "").trim();
  return text ? `${text}\n\n${block}` : block;
}

/**
 * The body a draft contributes to the review. Single source of truth, so the digest the human
 * approved and the payload that reaches GitHub can never disagree.
 *
 * @param {{ body: string, suggestion?: Suggestion }} draft
 * @returns {string}
 */
export function effectiveBody(draft) {
  return draft.suggestion ? renderSuggestionBody(draft.body, draft.suggestion) : draft.body;
}

/**
 * Build a suggestion for a range.
 *
 * @param {object} input
 * @param {import("../diff/model.js").ParsedFile} input.file
 * @param {import("../diff/model.js").Side} input.side
 * @param {number} input.line
 * @param {number} [input.startLine]
 * @param {string[]} [input.replacementLines] defaults to the current lines, so the editor opens
 *   showing what is there rather than empty — an empty default would read as "delete this"
 * @returns {{ suggestion: Suggestion, warnings: string[] } | { error: SuggestionReason, message: string }}
 */
export function buildSuggestion({ file, side, line, startLine, replacementLines }) {
  if (side !== "RIGHT") {
    return {
      error: "suggestion-side-not-right",
      message:
        "A suggestion can only be made on the new side of the diff: GitHub applies it to the head branch, " +
        "where the original lines no longer exist.",
    };
  }
  const base = baseLinesFor(file, startLine ?? line, line);
  if (!base) {
    return {
      error: "suggestion-base-not-in-diff",
      message: `Lines ${startLine ?? line}-${line} of \`${file.path}\` are not all part of the diff on the new side, so there is nothing for a suggestion to replace.`,
    };
  }

  const baseTexts = base.map((entry) => entry.text);
  /** @type {Suggestion} */
  const suggestion = {
    baseLines: baseTexts,
    baseHash: hashBaseLines(baseTexts),
    replacementLines: stripCr(replacementLines ?? baseTexts),
    eol: detectEol(baseTexts),
  };
  /** @type {string[]} */
  const warnings = [];
  if (base[base.length - 1].noNewlineAtEof) {
    suggestion.noNewlineAtEof = true;
    warnings.push(
      "The last line has no newline at end of file. A suggestion always writes one, so applying this will add a trailing newline.",
    );
  }
  if (suggestion.replacementLines.length > MAX_SUGGESTION_LINES) {
    warnings.push(`This suggestion replaces ${suggestion.replacementLines.length} lines, which is a lot to review.`);
  }
  return { suggestion, warnings };
}

/**
 * Move a suggestion to a different range, recomputing the anchor with it.
 *
 * Atomic on purpose: an anchor and a base hash that describe different ranges is the state in which
 * a suggestion silently rewrites the wrong lines.
 *
 * @param {object} input
 * @param {import("../diff/model.js").ParsedFile} input.file
 * @param {string} input.headSha
 * @param {number} input.line
 * @param {number} [input.startLine]
 * @param {string[]} [input.replacementLines]
 * @returns {{ anchor: import("./anchor.js").LineAnchor, suggestion: Suggestion, warnings: string[] }
 *   | { error: SuggestionReason, message: string }}
 */
export function setSuggestionRange({ file, headSha, line, startLine, replacementLines }) {
  const built = buildSuggestion({ file, side: "RIGHT", line, startLine, replacementLines });
  if ("error" in built) return built;

  const base = /** @type {import("../diff/model.js").DiffLine[]} */ (baseLinesFor(file, startLine ?? line, line));
  const rows = base.map((entry) => ({
    key: entry.key,
    kind: entry.kind,
    oldLine: entry.oldLine,
    newLine: entry.newLine,
    origin: entry.origin,
  }));
  const normalized = normalizeSelection(rows, file, headSha);
  if ("error" in normalized) {
    return {
      error: "suggestion-base-not-in-diff",
      message: `Lines ${startLine ?? line}-${line} of \`${file.path}\` cannot be anchored for a suggestion.`,
    };
  }
  return { anchor: normalized.anchor, suggestion: built.suggestion, warnings: built.warnings };
}

/**
 * Re-check a stored suggestion against the current diff. Called at draft time and again at submit.
 *
 * @param {import("./anchor.js").Anchor} anchor the **normalized** anchor
 * @param {Suggestion} suggestion
 * @param {import("../diff/model.js").ParsedFile} file
 * @returns {{ ok: true, warnings: string[] } | { ok: false, reason: SuggestionReason, message: string }}
 */
export function validateSuggestion(anchor, suggestion, file) {
  if (anchor.kind !== "line") {
    return {
      ok: false,
      reason: "suggestion-requires-line-anchor",
      message: "A suggestion needs a line anchor; a file-level comment has no lines to replace.",
    };
  }
  if (anchor.side !== "RIGHT" || (anchor.startSide ?? "RIGHT") !== "RIGHT") {
    return {
      ok: false,
      reason: "suggestion-side-not-right",
      message: "A suggestion can only be made on the new side of the diff.",
    };
  }
  const base = baseLinesFor(file, anchor.startLine ?? anchor.line, anchor.line);
  if (!base) {
    return {
      ok: false,
      reason: "suggestion-base-not-in-diff",
      message: `The lines this suggestion would replace are no longer part of the diff of \`${file.path}\`.`,
    };
  }
  const current = hashBaseLines(base.map((entry) => entry.text));
  if (current !== suggestion.baseHash) {
    return {
      ok: false,
      reason: "suggestion-base-drift",
      message:
        `The code this suggestion replaces in \`${file.path}\` has changed since you wrote it. ` +
        `Applying it now would edit lines you have not seen — re-check the range before submitting.`,
    };
  }
  /** @type {string[]} */
  const warnings = [];
  if (base[base.length - 1].noNewlineAtEof) {
    warnings.push("applying this suggestion will add a newline at end of file");
  }
  return { ok: true, warnings };
}

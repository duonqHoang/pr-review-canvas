import { buildCommentableIndex, isRangeCommentable, linesForSide } from "../diff/index-lines.js";
import { allDiffLines } from "../diff/model.js";
import { blockHashOf, buildFingerprint, hash16, neighbourHashes, rawLineAt } from "./anchor.js";
import { refindQuote } from "./validate.js";

/**
 * Re-anchoring after the author pushes.
 *
 * The governing rule, and the reason this module never writes anything: **drift must not move a
 * draft.** It produces a *proposal* that the caller stores beside the untouched anchor, and the
 * user accepts it. Submitting a comment onto code the reviewer has not read is the worst outcome
 * this tool has — worse than a 422, which is merely loud.
 *
 * The second rule is that keeping a line *number* is not evidence. A push that inserts ten lines
 * leaves every number below pointing at unrelated code, so a cascade that starts from "the number
 * still exists" would confidently mis-anchor the entire review. Text is the evidence; the number is
 * only a tie-breaker between equally-good text matches.
 */

/**
 * - `unchanged`     — same path, same number, byte-identical text. Auto-acceptable.
 * - `moved`         — found elsewhere, or under a new path after a rename. Carries a confidence.
 * - `ambiguous`     — several equally plausible homes; the user picks. Never guessed.
 * - `orphaned`      — the anchored text is gone from the diff.
 * - `file-gone`     — the file is no longer in the PR at all (the change was reverted or dropped).
 * - `file-degraded` — the file is back but its patch no longer parses; nothing can be certified.
 *
 * @typedef {"unchanged" | "moved" | "ambiguous" | "orphaned" | "file-gone" | "file-degraded"} DriftStatus
 */

/**
 * @typedef {object} DriftCandidate
 * @property {number} line
 * @property {number} score
 * @property {string} text
 */

/**
 * The three fields of a parsed diff this module reads.
 *
 * Structural rather than nominal so a `Snapshot` — which carries a PR's metadata as well and is
 * what the server actually has in hand — can be passed straight in without a conversion step whose
 * only job would be to satisfy a type.
 *
 * @typedef {object} DiffLike
 * @property {import("../diff/model.js").ParsedFile[]} files
 * @property {Map<string, import("../diff/model.js").ParsedFile>} byPath
 * @property {string} headSha
 */

/**
 * @typedef {object} DriftResult
 * @property {DriftStatus} status
 * @property {number} confidence 1 only for `unchanged` and a pure rename
 * @property {string} how which step of the cascade decided, for the log and the UI
 * @property {import("./anchor.js").Anchor} [proposedAnchor] present for `unchanged` and `moved`
 * @property {DriftCandidate[]} [candidates] at most 3, for `ambiguous`
 * @property {true} [pathRewritten] the file was renamed; the proposal carries the new path
 * @property {string} [detail]
 */

/** How much evidence a scored match needs, and how far it must beat the runner-up. */
const SCORE_ACCEPT = 3;
const SCORE_MARGIN = 1;
const MAX_CANDIDATES = 3;

/** Named so a confidence in stored state can be traced back to the step that produced it. */
export const DRIFT_CONFIDENCE = {
  /** Same place, same bytes. */
  unchanged: 1,
  /** Exactly one line in the file carries this text. */
  uniqueText: 0.9,
  /** A whole range matched by block hash. */
  block: 0.8,
  /** Several text matches, one clearly best on context. */
  scored: 0.75,
  /** Matched only after trimming — a reindent or a formatter run. */
  trimmed: 0.6,
};

/**
 * @param {import("../diff/model.js").DiffLine} line
 * @param {import("../diff/model.js").Side} side
 */
function numberOf(line, side) {
  return side === "LEFT" ? line.oldLine : line.newLine;
}

/**
 * Locate the anchor's file in a fresh diff, following a rename.
 *
 * @param {string} path
 * @param {DiffLike} diff
 * @returns {{ file: import("../diff/model.js").ParsedFile, renamed: boolean } | null}
 */
export function findFileForAnchor(path, diff) {
  const direct = diff.byPath.get(path);
  if (direct) return { file: direct, renamed: false };
  // A rename moves the anchor's path out from under it. `previousPath` is the only link back, and
  // this is the one place it may influence a comment's `path` — by replacing it entirely.
  const renamed = diff.files.find((file) => file.previousPath === path);
  return renamed ? { file: renamed, renamed: true } : null;
}

/**
 * Re-anchor one anchor against a fresh diff.
 *
 * @param {import("./anchor.js").Anchor} anchor
 * @param {DiffLike} diff
 * @returns {DriftResult}
 */
export function reanchor(anchor, diff) {
  const found = findFileForAnchor(anchor.path, diff);
  if (!found) {
    return { status: "file-gone", confidence: 0, how: "file-not-in-diff", detail: anchor.path };
  }
  const { file, renamed } = found;

  if (anchor.kind === "file") {
    // A file anchor has nothing to match; existing is all it needs.
    return renamed
      ? {
          status: "moved",
          confidence: 1,
          how: "renamed-file",
          proposedAnchor: { ...anchor, path: file.path },
          pathRewritten: true,
        }
      : { status: "unchanged", confidence: 1, how: "same-file" };
  }

  if (file.degraded) {
    return {
      status: "file-degraded",
      confidence: 0,
      how: "parse-degraded",
      detail: file.diagnostics.find((diagnostic) => diagnostic.fatal)?.detail ?? "the patch no longer parses",
    };
  }

  const flat = allDiffLines(file);
  const index = buildCommentableIndex(file);
  const side = anchor.side;
  const fingerprint = anchor.fingerprint;
  const endResult = matchEndLine({ anchor, file, flat, index, side });
  if (endResult.kind === "line") return finish({ anchor, file, diff, renamed, ...endResult });

  // Both failure shapes get one more chance from the range's own body. A block that occurs exactly
  // once is stronger evidence than a last line that occurs four times, so this ordering is what
  // lets a range survive a push that duplicated its final line — the case where asking the user to
  // choose between identical-looking candidates would be worst.
  const byBlock = matchByBlockHash({ anchor, flat, index, side });
  if (byBlock) return finish({ anchor, file, diff, renamed, ...byBlock });

  if (endResult.kind === "ambiguous") {
    return { status: "ambiguous", confidence: 0, how: endResult.how, candidates: endResult.candidates };
  }
  return {
    status: "orphaned",
    confidence: 0,
    how: endResult.how,
    detail: fingerprint.hunkHeader || undefined,
  };
}

/**
 * Steps 1–5 of the cascade, on the anchor's **last** line — the one its fingerprint describes.
 *
 * @param {object} input
 * @param {import("./anchor.js").LineAnchor | import("./anchor.js").TextAnchor} input.anchor
 * @param {import("../diff/model.js").ParsedFile} input.file
 * @param {import("../diff/model.js").DiffLine[]} input.flat
 * @param {import("../diff/index-lines.js").CommentableIndex} input.index
 * @param {import("../diff/model.js").Side} input.side
 * @returns {{ kind: "line", line: number, confidence: number, how: string, exact: boolean }
 *   | { kind: "ambiguous", how: string, candidates: DriftCandidate[] }
 *   | { kind: "none", how: string }}
 */
function matchEndLine({ anchor, file, flat, index, side }) {
  const fingerprint = anchor.fingerprint;
  const byNumber = linesForSide(index, side);

  // 1. Still commentable at the same number with the same bytes. `textHash` is the comparison, not
  //    `rawText`, because `rawText` is truncated at 512 chars and would report two different long
  //    lines as equal.
  const atNumber = byNumber.get(anchor.line);
  if (atNumber && hash16(atNumber.text) === fingerprint.textHash) {
    return {
      kind: "line",
      line: anchor.line,
      confidence: DRIFT_CONFIDENCE.unchanged,
      how: "same-line-same-text",
      exact: true,
    };
  }

  // 2. A line with that number but different text is deliberately NOT a match. Falling through here
  //    is the whole point of the cascade.

  // 3–4. Every commentable line on this side whose text hashes the same.
  const exact = [...byNumber.values()].filter((line) => hash16(line.text) === fingerprint.textHash);
  const picked = pick(exact, { anchor, file, flat, side, how: "unique-text" });
  if (picked) return picked;

  // 5. Same again after trimming, which catches a reindent or a formatter pass. Skipped when
  //    `rawText` is truncated: a prefix comparison there would match lines that differ past 512
  //    chars, and a wrong match is worse than no match.
  if (!fingerprint.truncated) {
    const target = fingerprint.rawText.trim();
    const trimmed = target.length > 0 ? [...byNumber.values()].filter((line) => line.text.trim() === target) : [];
    const pickedTrimmed = pick(trimmed, {
      anchor,
      file,
      flat,
      side,
      how: "trimmed-text",
      confidence: DRIFT_CONFIDENCE.trimmed,
    });
    if (pickedTrimmed) return pickedTrimmed;
  }

  return { kind: "none", how: "text-not-found" };
}

/**
 * Turn a list of text matches into a decision: one match wins outright, several go to scoring, and
 * a scoring tie is reported as ambiguous rather than resolved.
 *
 * @param {import("../diff/model.js").DiffLine[]} matches
 * @param {object} input
 * @param {import("./anchor.js").LineAnchor | import("./anchor.js").TextAnchor} input.anchor
 * @param {import("../diff/model.js").ParsedFile} input.file
 * @param {import("../diff/model.js").DiffLine[]} input.flat
 * @param {import("../diff/model.js").Side} input.side
 * @param {string} input.how
 * @param {number} [input.confidence]
 * @returns {{ kind: "line", line: number, confidence: number, how: string, exact: boolean }
 *   | { kind: "ambiguous", how: string, candidates: DriftCandidate[] } | null}
 */
function pick(matches, { anchor, file, flat, side, how, confidence }) {
  if (matches.length === 0) return null;
  if (matches.length === 1) {
    const line = numberOf(matches[0], side);
    if (line == null) return null;
    return {
      kind: "line",
      line,
      confidence: confidence ?? DRIFT_CONFIDENCE.uniqueText,
      how,
      exact: how === "unique-text",
    };
  }

  const scored = matches
    .map((match) => ({
      line: numberOf(match, side) ?? -1,
      score: scoreCandidate(match, { anchor, file, flat, side }),
      text: match.text,
    }))
    .filter((candidate) => candidate.line > 0)
    .sort((a, b) => b.score - a.score);

  const [best, runnerUp] = scored;
  if (best && best.score >= SCORE_ACCEPT && (!runnerUp || best.score - runnerUp.score >= SCORE_MARGIN)) {
    return {
      kind: "line",
      line: best.line,
      confidence: Math.min(confidence ?? DRIFT_CONFIDENCE.scored, DRIFT_CONFIDENCE.scored),
      how: `${how}-scored`,
      exact: how === "unique-text",
    };
  }
  return { kind: "ambiguous", how: `${how}-ambiguous`, candidates: scored.slice(0, MAX_CANDIDATES) };
}

/**
 * How much a candidate line looks like the anchor's original home. Context hashes dominate,
 * the section header is a weak signal, and proximity only ever breaks a tie — it contributes
 * strictly less than 1, so it can never on its own carry a candidate past `SCORE_ACCEPT`.
 *
 * @param {import("../diff/model.js").DiffLine} candidate
 * @param {object} input
 * @param {import("./anchor.js").LineAnchor | import("./anchor.js").TextAnchor} input.anchor
 * @param {import("../diff/model.js").ParsedFile} input.file
 * @param {import("../diff/model.js").DiffLine[]} input.flat
 * @param {import("../diff/model.js").Side} input.side
 */
function scoreCandidate(candidate, { anchor, file, flat, side }) {
  const fingerprint = anchor.fingerprint;
  const flatIndex = flat.findIndex((line) => line.key === candidate.key);
  const { beforeHash, afterHash } = neighbourHashes(flat, flatIndex);
  let score = 0;
  if (beforeHash === fingerprint.beforeHash) score += 2;
  if (afterHash === fingerprint.afterHash) score += 2;
  if ((file.hunks[candidate.hunkIndex]?.header ?? "") === fingerprint.hunkHeader) score += 1;
  const line = numberOf(candidate, side);
  if (line != null) score += 1 / (1 + Math.abs(line - anchor.line) / 50);
  return score;
}

/**
 * Step 6: find the anchor's whole range by hashing every same-length window of the new diff.
 *
 * This is the fallback for a range whose last line changed but whose body survived intact — a
 * common shape when the author edits the line above or below a block that was commented on.
 *
 * @param {object} input
 * @param {import("./anchor.js").LineAnchor | import("./anchor.js").TextAnchor} input.anchor
 * @param {import("../diff/model.js").DiffLine[]} input.flat
 * @param {import("../diff/index-lines.js").CommentableIndex} input.index
 * @param {import("../diff/model.js").Side} input.side
 * @returns {{ kind: "line", line: number, startLine: number, confidence: number, how: string, exact: false } | null}
 */
function matchByBlockHash({ anchor, flat, index, side }) {
  const { blockHash, blockLines } = anchor.fingerprint;
  if (!blockHash || !blockLines || blockLines > flat.length) return null;

  /** @type {Array<{ from: number, to: number }>} */
  const hits = [];
  for (let start = 0; start + blockLines <= flat.length; start += 1) {
    const end = start + blockLines - 1;
    if (blockHashOf(flat, start, end) === blockHash) hits.push({ from: start, to: end });
  }
  if (hits.length !== 1) return null;

  const from = numberOf(flat[hits[0].from], side);
  const to = numberOf(flat[hits[0].to], side);
  // A window whose ends have no number on this side (the range now begins on a deletion, say) is
  // not something GitHub can address, so it is not a proposal.
  if (from == null || to == null || from > to) return null;
  if (!isRangeCommentable(index, side, from, to)) return null;
  return {
    kind: "line",
    line: to,
    startLine: from,
    confidence: DRIFT_CONFIDENCE.block,
    how: "block-hash",
    exact: false,
  };
}

/**
 * Build the proposal from a resolved end line, deriving the range's start and rebuilding the
 * fingerprint against the new diff.
 *
 * Rebuilding the fingerprint is not cosmetic: an accepted proposal that kept the old fingerprint
 * would look drifted again on the very next push, and the user would be asked to re-approve a
 * move they already approved.
 *
 * @param {object} input
 * @param {import("./anchor.js").LineAnchor | import("./anchor.js").TextAnchor} input.anchor
 * @param {import("../diff/model.js").ParsedFile} input.file
 * @param {DiffLike} input.diff
 * @param {boolean} input.renamed
 * @param {number} input.line
 * @param {number} [input.startLine]
 * @param {number} input.confidence
 * @param {string} input.how
 * @param {boolean} input.exact
 * @returns {DriftResult}
 */
function finish({ anchor, file, diff, renamed, line, startLine, confidence, how, exact }) {
  const side = anchor.side;
  const index = buildCommentableIndex(file);
  /** @type {string[]} */
  const notes = [];

  let from = startLine;
  if (from === undefined && anchor.kind === "line" && anchor.startLine !== undefined) {
    // Only the last line carries a fingerprint, so the start is derived by preserving the range's
    // length. `blockHash` is then asked to confirm it; when it cannot, the range is still proposed
    // but the confidence drops, because "same length, same end" is a weaker claim than "same text".
    const derived = line - (anchor.line - anchor.startLine);
    if (derived >= 1 && isRangeCommentable(index, side, derived, line)) {
      from = derived;
      if (!confirmsRange(anchor, file, side, derived, line)) {
        confidence = Math.min(confidence, DRIFT_CONFIDENCE.trimmed);
        notes.push("range-length-preserved-but-body-changed");
      }
    } else {
      confidence = Math.min(confidence, DRIFT_CONFIDENCE.trimmed);
      notes.push("range-collapsed-to-single-line");
    }
  }

  const endLine = rawLineAt(file, side, line);
  if (!endLine) {
    return { status: "orphaned", confidence: 0, how: "resolved-line-vanished" };
  }
  const startDiffLine = from !== undefined && from !== line ? rawLineAt(file, side, from) : null;

  /** @type {import("./anchor.js").Anchor} */
  let proposed;
  if (anchor.kind === "text") {
    const refound = refindQuote(endLine.text, anchor);
    if (refound) {
      proposed = {
        ...anchor,
        path: file.path,
        line,
        startOffset: refound.startOffset,
        endOffset: refound.endOffset,
        fingerprint: buildFingerprint({ file, endLine, headSha: diff.headSha }),
      };
    } else {
      // The quote is gone but the line survived. Degrade openly to a line anchor: the payload was
      // always line-granular, so nothing is lost but the highlight, and the alternative is
      // pointing a quote at text it no longer covers.
      notes.push("quote-lost-degraded-to-line-anchor");
      proposed = {
        kind: "line",
        path: file.path,
        side,
        line,
        fingerprint: buildFingerprint({ file, endLine, headSha: diff.headSha }),
      };
    }
  } else {
    /** @type {import("./anchor.js").LineAnchor} */
    const next = {
      ...anchor,
      path: file.path,
      line,
      fingerprint: buildFingerprint({
        file,
        endLine,
        startLine: startDiffLine ?? undefined,
        headSha: diff.headSha,
      }),
    };
    if (from !== undefined && from !== line) {
      next.startLine = from;
      next.startSide = side;
    } else {
      delete next.startLine;
      delete next.startSide;
    }
    proposed = next;
  }

  const originalStart = anchor.kind === "line" ? (anchor.startLine ?? anchor.line) : anchor.line;
  // `notes.length === 0` is load-bearing, not tidiness. A range whose end line matched exactly but
  // whose *interior* changed lands here with the same numbers, and calling that `unchanged` would
  // make it auto-acceptable — silently re-approving lines the reviewer has not read, which is the
  // one outcome this module exists to prevent.
  const samePlace = exact && notes.length === 0 && line === anchor.line && (from ?? line) === originalStart;
  /** @type {DriftResult} */
  const result = {
    status: samePlace && !renamed ? "unchanged" : "moved",
    confidence: samePlace ? Math.min(confidence, DRIFT_CONFIDENCE.unchanged) : confidence,
    how,
    proposedAnchor: proposed,
  };
  if (renamed) result.pathRewritten = true;
  if (notes.length > 0) result.detail = notes.join("; ");
  return result;
}

/**
 * Whether `blockHash` agrees that the range still holds the same lines.
 *
 * @param {import("./anchor.js").LineAnchor | import("./anchor.js").TextAnchor} anchor
 * @param {import("../diff/model.js").ParsedFile} file
 * @param {import("../diff/model.js").Side} side
 * @param {number} from
 * @param {number} to
 */
function confirmsRange(anchor, file, side, from, to) {
  const { blockHash } = anchor.fingerprint;
  if (!blockHash) return false;
  const flat = allDiffLines(file);
  const startLine = rawLineAt(file, side, from);
  const endLine = rawLineAt(file, side, to);
  if (!startLine || !endLine) return false;
  const start = flat.findIndex((line) => line.key === startLine.key);
  const end = flat.findIndex((line) => line.key === endLine.key);
  if (start < 0 || end < start) return false;
  return blockHashOf(flat, start, end) === blockHash;
}

/**
 * Re-anchor a batch, keyed by the caller's ids.
 *
 * @param {Array<{ id: string, anchor: import("./anchor.js").Anchor }>} items
 * @param {DiffLike} diff
 * @returns {Record<string, DriftResult>}
 */
export function reanchorAll(items, diff) {
  /** @type {Record<string, DriftResult>} */
  const results = {};
  for (const item of items) results[item.id] = reanchor(item.anchor, diff);
  return results;
}

/**
 * Whether a result may be applied without asking.
 *
 * Only two shapes qualify: nothing changed, or the file was renamed under an otherwise identical
 * anchor. Every other `moved` is an *inference* — even at 0.9 — and an inference is exactly what a
 * human has to sign off on. A draft carrying a ```suggestion never auto-accepts at all, because
 * accepting one silently would re-point an edit at lines the user has not seen.
 *
 * @param {DriftResult} result
 * @param {{ hasSuggestion?: boolean }} [context]
 */
export function canAutoAccept(result, context = {}) {
  if (context.hasSuggestion) return result.status === "unchanged";
  if (result.status === "unchanged") return true;
  return result.status === "moved" && result.confidence >= DRIFT_CONFIDENCE.unchanged;
}

/** A one-line human summary, for the banner and the CLI. @param {DriftResult} result */
export function describeDrift(result) {
  switch (result.status) {
    case "unchanged":
      return "still on the same line";
    case "moved":
      return result.pathRewritten
        ? "the file was renamed"
        : `moved (${Math.round(result.confidence * 100)}% confident)`;
    case "ambiguous":
      return `${result.candidates?.length ?? 0} possible lines — needs a choice`;
    case "orphaned":
      return "the anchored code is no longer in the diff";
    case "file-gone":
      return "the file is no longer part of this PR";
    case "file-degraded":
      return "the file's patch can no longer be parsed";
  }
}

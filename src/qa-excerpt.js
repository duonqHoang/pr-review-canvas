import { allDiffLines } from "./diff/model.js";
import { blobLinkFor } from "./shared/permalink.js";

/**
 * The code excerpt attached to a question in the poll payload.
 *
 * This is the analogue of lavish's `dom_snapshot`, and it is **the only unbounded vector into the
 * agent's context** in the whole protocol: everything else the poll returns is a count, an id or a
 * short label. A 200-file review could otherwise put megabytes of diff in front of the model, so
 * the caps below are hard, they are enforced here on the server, and they are never negotiable by
 * the client.
 *
 * The user's own question text is *not* capped the same way — it is addressed to the agent and is
 * the entire point of the round trip — but it is still bounded, because a paste accident should
 * degrade rather than detonate.
 */

/** Context lines kept either side of the selection. */
export const EXCERPT_CONTEXT_LINES = 5;
/** Hard ceiling on rendered rows for one question. */
export const EXCERPT_MAX_LINES = 40;
/** Hard ceiling on the rendered excerpt in bytes. */
export const EXCERPT_MAX_BYTES = 4096;
/** One pathological minified line must not consume the whole byte budget. */
export const MAX_LINE_CHARS = 400;
/**
 * Context lines are clipped harder than selected ones.
 *
 * A prose file — a README, a changelog — has 400-character lines, and ten of those either side is
 * most of the byte budget spent on text nobody asked about. The line under discussion keeps its
 * full width; its neighbours only need to establish where we are.
 */
export const MAX_CONTEXT_LINE_CHARS = 160;
/** The `selected_text` quote is a label, not the payload. */
export const MAX_QUOTE_CHARS = 200;
/** Questions delivered per poll; the rest are re-queued for the next one. */
export const MAX_QUESTIONS_PER_POLL = 5;
/** Bound on the user's question text. Generous — this is the message, not the context. */
export const MAX_QUESTION_CHARS = 8000;

const ELLIPSIS = "…";

/**
 * @typedef {object} Excerpt
 * @property {boolean} resolved false when the anchored lines are not in the parsed diff at all
 * @property {string} code rendered, capped
 * @property {string} quote first selected line, capped
 * @property {number} rows how many rows the excerpt renders
 * @property {boolean} truncated something was dropped or clipped
 */

/**
 * @param {string} value
 * @param {number} max
 */
function clip(value, max) {
  return value.length > max ? `${value.slice(0, max)}${ELLIPSIS}` : value;
}

/**
 * Indices of the anchored lines within the file's flat diff-order line list.
 *
 * Commentability is deliberately **not** consulted: a question may be asked about a line GitHub
 * would refuse a comment on, which is exactly why Ask and Comment are separate actions.
 *
 * A range is not necessarily contiguous in diff order — a RIGHT range spanning a hunk's deletions
 * has those deletion rows interleaved — so the result is a set of indices, not a span.
 *
 * @param {import("./diff/model.js").DiffLine[]} flat
 * @param {import("./diff/model.js").Side} side
 * @param {number} from
 * @param {number} to
 * @returns {number[]}
 */
export function selectedIndices(flat, side, from, to) {
  const low = Math.min(from, to);
  const high = Math.max(from, to);
  /** @type {number[]} */
  const found = [];
  for (let index = 0; index < flat.length; index += 1) {
    const number = side === "LEFT" ? flat[index].oldLine : flat[index].newLine;
    if (number != null && number >= low && number <= high) found.push(index);
  }
  return found;
}

/**
 * Build the excerpt for one anchor.
 *
 * @param {import("./diff/model.js").ParsedFile} file
 * @param {{ side: import("./diff/model.js").Side, line: number, startLine?: number }} anchor
 * @returns {Excerpt}
 */
export function buildExcerpt(file, anchor) {
  const flat = allDiffLines(file);
  const chosen = selectedIndices(flat, anchor.side, anchor.startLine ?? anchor.line, anchor.line);
  if (chosen.length === 0) return { resolved: false, code: "", quote: "", rows: 0, truncated: false };

  const first = chosen[0];
  const last = chosen[chosen.length - 1];
  const selected = new Set(chosen);
  const low = Math.max(0, first - EXCERPT_CONTEXT_LINES);
  const high = Math.min(flat.length - 1, last + EXCERPT_CONTEXT_LINES);

  /** @type {Array<{ line: import("./diff/model.js").DiffLine, selected: boolean }>} */
  const rows = [];
  for (let index = low; index <= high; index += 1) rows.push({ line: flat[index], selected: selected.has(index) });

  let elided = false;
  /**
   * Drop one row, cheapest first: trailing context, then leading context, then — only once
   * everything else is gone — a selected row, which is recorded as an elision so the agent is
   * never shown a silently shortened selection.
   */
  const dropOne = () => {
    if (rows.length === 0) return false;
    if (!rows[rows.length - 1].selected) {
      rows.pop();
      return true;
    }
    if (!rows[0].selected) {
      rows.shift();
      return true;
    }
    if (rows.length > 1) {
      rows.pop();
      elided = true;
      return true;
    }
    return false;
  };

  while (rows.length > EXCERPT_MAX_LINES && dropOne()) {
    // keep dropping
  }

  let clipped = false;
  const render = () => {
    const width = Math.max(...rows.map((row) => String(displayNumber(row.line)).length), 1);
    /** @type {string[]} */
    const out = [];
    for (const row of rows) {
      const text = clip(row.line.text, row.selected ? MAX_LINE_CHARS : MAX_CONTEXT_LINE_CHARS);
      if (text !== row.line.text) clipped = true;
      const marker = row.line.kind === "add" ? "+" : row.line.kind === "del" ? "-" : " ";
      out.push(`${row.selected ? ">" : " "}${marker}${String(displayNumber(row.line)).padStart(width)} | ${text}`);
    }
    if (elided) out.push(`${" ".repeat(width + 2)} | ${ELLIPSIS} selection truncated`);
    return out.join("\n");
  };

  let code = render();
  while (Buffer.byteLength(code, "utf8") > EXCERPT_MAX_BYTES && dropOne()) {
    code = render();
  }
  if (Buffer.byteLength(code, "utf8") > EXCERPT_MAX_BYTES) {
    // One row alone still over budget: cut on a character boundary, never mid-code-point.
    code = Buffer.from(code, "utf8").subarray(0, EXCERPT_MAX_BYTES).toString("utf8").replace(/�+$/, "");
    elided = true;
  }

  const firstSelected = rows.find((row) => row.selected)?.line ?? flat[first];
  return {
    resolved: true,
    code,
    quote: clip(firstSelected.text, MAX_QUOTE_CHARS),
    rows: rows.length,
    truncated: elided || clipped,
  };
}

/** @param {import("./diff/model.js").DiffLine} line */
function displayNumber(line) {
  return line.kind === "del" ? (line.oldLine ?? 0) : (line.newLine ?? line.oldLine ?? 0);
}

/**
 * The poll-payload shape for one question thread.
 *
 * Note what is absent: no draft comment body, no review summary, no other thread. A question is
 * the only user-authored text the agent is asked to read, because it is the only one addressed
 * to it.
 *
 * @param {object} input
 * @param {import("./snapshot.js").Snapshot} input.snapshot
 * @param {import("./session-store.js").QaThread} input.thread
 * @param {"question" | "question_followup"} [input.kind]
 * @returns {Record<string, unknown>}
 */
export function buildQuestionPayload({ snapshot, thread, kind = "question" }) {
  const anchor = thread.anchor;
  const path = anchor.path;
  const file = snapshot.byPath?.get(path) ?? snapshot.files.find((candidate) => candidate.path === path);

  /** @type {Record<string, unknown>} */
  const payload = { id: thread.id, kind, path };
  const asked = [...thread.messages].reverse().find((message) => message.role === "user");
  payload.question = clip(String(asked?.text ?? ""), MAX_QUESTION_CHARS);

  if (anchor.kind === "file" || !file) {
    payload.scope = "file";
    return payload;
  }

  // A TextAnchor is a narrowing of a line anchor, not a parallel address space: it has no range,
  // so it is rendered as the single line that contains it.
  const startLine = anchor.kind === "line" ? anchor.startLine : undefined;

  payload.side = anchor.side;
  payload.lines = startLine != null ? `${startLine}-${anchor.line}` : String(anchor.line);
  payload.permalink = blobLinkFor({
    ref: snapshot.ref,
    headSha: snapshot.headSha,
    baseSha: snapshot.baseSha,
    file,
    side: anchor.side,
    line: anchor.line,
    startLine,
  });

  const excerpt = buildExcerpt(file, { side: anchor.side, line: anchor.line, startLine });
  if (!excerpt.resolved) {
    // The anchor points outside the parsed diff. Say so instead of inventing context: the agent
    // can still answer from the permalink, and pretending we had the code would be worse.
    payload.code_unavailable = "the anchored lines are not part of the parsed diff";
    return payload;
  }
  payload.selected_text = excerpt.quote;
  payload.code = excerpt.code;
  if (excerpt.truncated) payload.code_truncated = true;
  if (thread.messages.filter((message) => message.role === "user").length > 1) {
    payload.follow_up = true;
  }
  return payload;
}

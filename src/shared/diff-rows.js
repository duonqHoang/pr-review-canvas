import { escapeHtml } from "./escape.js";

/**
 * The **single** diff row renderer, shared by the server (for pre-rendered files) and the browser
 * (for lazily-mounted ones).
 *
 * That sharing is the reason the client is bundled rather than served as a raw import-free file.
 * Two renderers drifting apart would be the most likely source of "the comment landed on the
 * wrong line" bugs in this whole project, because the DOM is what the anchor is read from.
 *
 * Pure string functions, no DOM.
 */

/**
 * The line key: `fileIndex:kind:old:new`, e.g. `0:a::16`, `0:d:15:`, `0:c:14:14`.
 *
 * Mode-independent, so toggling unified/split re-anchors nothing. **Never persisted** — the file
 * index does not survive a re-fetch, so only the path/side/line anchor goes to disk.
 *
 * @param {number} fileIndex
 * @param {import("../diff/model.js").DiffLine} line
 */
export function lineKey(fileIndex, line) {
  const kind = line.kind === "add" ? "a" : line.kind === "del" ? "d" : "c";
  return `${fileIndex}:${kind}:${line.oldLine ?? ""}:${line.newLine ?? ""}`;
}

/**
 * @param {string} key
 * @returns {{ fileIndex: number, kind: import("../diff/model.js").LineKind, oldLine: number | null, newLine: number | null } | null}
 */
export function parseLineKey(key) {
  const match = /^(\d+):([acd]):(\d*):(\d*)$/.exec(String(key ?? ""));
  if (!match) return null;
  return {
    fileIndex: Number(match[1]),
    kind: match[2] === "a" ? "add" : match[2] === "d" ? "del" : "context",
    oldLine: match[3] === "" ? null : Number(match[3]),
    newLine: match[4] === "" ? null : Number(match[4]),
  };
}

/** Number of columns in a unified diff table; a thread row's colspan must match. */
export const UNIFIED_COLUMNS = 3;

/** Number of columns in a split diff table: number, code, number, code. */
export const SPLIT_COLUMNS = 4;

/** @typedef {"unified" | "split"} Layout */

/** @param {Layout} layout */
export function columnsFor(layout) {
  return layout === "split" ? SPLIT_COLUMNS : UNIFIED_COLUMNS;
}

/**
 * Pair up a hunk's lines into side-by-side rows.
 *
 * A unified hunk emits a changed block as all of its deletions followed by all of its additions, so
 * pairing means buffering both runs and zipping them when the run ends. A context line ends the run
 * and occupies both columns — it is one source line, shown twice.
 *
 * `left`/`right` are nullable independently: three deletions against one addition gives three rows,
 * two of which have an empty right cell.
 *
 * @param {import("../diff/model.js").DiffLine[]} lines in diff order
 * @returns {Array<{ left: import("../diff/model.js").DiffLine | null, right: import("../diff/model.js").DiffLine | null }>}
 */
export function pairRows(lines) {
  /** @type {Array<{ left: import("../diff/model.js").DiffLine | null, right: import("../diff/model.js").DiffLine | null }>} */
  const pairs = [];
  /** @type {import("../diff/model.js").DiffLine[]} */
  let deletions = [];
  /** @type {import("../diff/model.js").DiffLine[]} */
  let additions = [];

  const flush = () => {
    const count = Math.max(deletions.length, additions.length);
    for (let index = 0; index < count; index += 1) {
      pairs.push({ left: deletions[index] ?? null, right: additions[index] ?? null });
    }
    deletions = [];
    additions = [];
  };

  for (const line of lines) {
    if (line.kind === "del") {
      deletions.push(line);
      continue;
    }
    if (line.kind === "add") {
      additions.push(line);
      continue;
    }
    flush();
    pairs.push({ left: line, right: line });
  }
  flush();
  return pairs;
}

/**
 * Render one unified diff row.
 *
 * Two details are load-bearing:
 *
 * - Line numbers are rendered via `data-n` and a CSS `::before`, with `user-select: none`. That
 *   keeps them out of the clipboard when code is copied across rows, which is the single most
 *   appreciated detail of GitHub's diff and costs one CSS rule.
 * - `td.prc-code[data-lk]` is the one and only anchor-resolution target. Every selection gesture
 *   reduces to `closest("td.prc-code[data-lk]")`.
 *
 * @param {number} fileIndex
 * @param {import("../diff/model.js").DiffLine} line
 * @returns {string}
 */
export function rowHtmlUnified(fileIndex, line) {
  const key = lineKey(fileIndex, line);
  const side = line.commentableSides[0] ?? "";

  const oldCell =
    line.oldLine == null
      ? emptyNumCell()
      : numCell("prc-num-old", line.oldLine, side === "LEFT" ? plusButton(key, "LEFT", line.oldLine) : "");
  const newCell =
    line.newLine == null
      ? emptyNumCell()
      : numCell("prc-num-new", line.newLine, side === "RIGHT" ? plusButton(key, "RIGHT", line.newLine) : "");

  return `${rowOpen(line, key)}${oldCell}${newCell}${codeCell(line, key, side)}</tr>`;
}

/**
 * Render one side-by-side row.
 *
 * The left cell of a **context** row is a mirror, not a second anchor: it shows the original line
 * number but carries no `data-lk` and offers no `+`. That is a deliberate difference from GitHub,
 * which does let you comment from either gutter of a context row and sends `side: "LEFT"` when you
 * use the left one. This project reports context lines as RIGHT-commentable only (see
 * `commentableSidesFor`), so the alternatives here were both worse: offer a `+` in the left gutter
 * that silently files the comment against a *different* line number than the one shown, or send a
 * LEFT-on-context anchor that has not been proven against the API. Showing the number without the
 * affordance is the honest third option, and it keeps the invariant that a `data-lk` appears exactly
 * once per table.
 *
 * @param {number} fileIndex
 * @param {{ left: import("../diff/model.js").DiffLine | null, right: import("../diff/model.js").DiffLine | null }} pair
 * @returns {string}
 */
export function rowHtmlSplit(fileIndex, pair) {
  const { left, right } = pair;
  const mirrored = left != null && left === right;
  const shape = left && right ? (mirrored ? "ctx" : "both") : left ? "del" : "add";

  const leftKey = left ? lineKey(fileIndex, left) : "";
  const rightKey = right ? lineKey(fileIndex, right) : "";

  const leftHalf =
    left == null
      ? `${emptyNumCell()}${blankCodeCell()}`
      : mirrored
        ? `${numCell("prc-num-old", /** @type {number} */ (left.oldLine), "")}${codeCell(left, "", "", { mirror: true })}`
        : `${numCell("prc-num-old", /** @type {number} */ (left.oldLine), left.commentableSides.includes("LEFT") ? plusButton(leftKey, "LEFT", /** @type {number} */ (left.oldLine)) : "")}${codeCell(left, leftKey, sideOf(left, "LEFT"))}`;

  const rightHalf =
    right == null
      ? `${emptyNumCell()}${blankCodeCell()}`
      : `${numCell("prc-num-new", /** @type {number} */ (right.newLine), right.commentableSides.includes("RIGHT") ? plusButton(rightKey, "RIGHT", /** @type {number} */ (right.newLine)) : "")}${codeCell(right, rightKey, sideOf(right, "RIGHT"))}`;

  // The row's own classes describe the *pair*, so a paired change tints both halves correctly; the
  // per-cell kind class is what actually colours each side.
  const locked = (left ?? right)?.origin === "expanded" ? " prc-line-locked" : "";
  return (
    `<tr class="prc-line prc-line-pair prc-pair-${shape}${locked}" data-shape="${shape}">` +
    leftHalf +
    rightHalf +
    `</tr>`
  );
}

/**
 * The side a cell in a given column may be commented on, or `""` for none.
 *
 * A line always gets a `data-lk` — that is how the client identifies it for keyboard navigation and
 * for asking the agent about it — but only a commentable line gets a `data-side`. Expanded context
 * is the case that makes the distinction necessary: it is addressable and askable, and commenting on
 * it is a guaranteed 422.
 *
 * @param {import("../diff/model.js").DiffLine} line
 * @param {import("../diff/model.js").Side} column
 */
function sideOf(line, column) {
  return line.commentableSides.includes(column) ? column : "";
}

/**
 * @param {import("../diff/model.js").DiffLine} line
 * @param {string} key
 */
function rowOpen(line, key) {
  const kindClass = line.kind === "add" ? "prc-line-add" : line.kind === "del" ? "prc-line-del" : "prc-line-ctx";
  const locked = line.origin === "expanded" ? " prc-line-locked" : "";
  // No `data-commentable` here. It lives on the code cell and **only** there: a split row holds two
  // lines with different answers and cannot report one, so a row-level copy exists in one layout and
  // not the other — and anything reading it silently works in unified and fails in split. That is
  // exactly what happened.
  return (
    `<tr class="prc-line ${kindClass}${locked}" data-lk="${escapeHtml(key)}" data-kind="${line.kind}"` +
    `${line.origin === "expanded" ? ' aria-disabled="true"' : ""}>`
  );
}

/** @param {string} className @param {number} number @param {string} inner */
function numCell(className, number, inner) {
  return `<td class="prc-num ${className}" data-n="${number}">${inner}</td>`;
}

function emptyNumCell() {
  return `<td class="prc-num prc-num-empty"></td>`;
}

function blankCodeCell() {
  return `<td class="prc-code prc-code-blank"></td>`;
}

/**
 * The one anchor-resolution target.
 *
 * `data-commentable` lives here and nowhere else. A split row holds two lines with different answers —
 * a deletion paired with an addition is commentable on both sides — so the cell is the only place the
 * fact is unambiguous, and duplicating it onto the row produced an attribute that existed in one
 * layout and not the other.
 *
 * @param {import("../diff/model.js").DiffLine} line
 * @param {string} key `""` for a mirror cell, which is not an anchor target
 * @param {string} side
 * @param {{ mirror?: boolean }} [options]
 */
function codeCell(line, key, side, options = {}) {
  const kindClass = line.kind === "add" ? "prc-code-add" : line.kind === "del" ? "prc-code-del" : "prc-code-ctx";
  const marker = line.kind === "add" ? "+" : line.kind === "del" ? "-" : " ";
  // A screen reader needs to know which side a row is on, and that an expanded row cannot be
  // commented on — neither is conveyed by colour alone.
  const srPrefix =
    line.origin === "expanded"
      ? `<span class="prc-sr">Context line, not part of the diff: </span>`
      : line.kind === "add"
        ? `<span class="prc-sr">Added line ${line.newLine}: </span>`
        : line.kind === "del"
          ? `<span class="prc-sr">Removed line ${line.oldLine}: </span>`
          : "";
  return (
    `<td class="prc-code ${kindClass}"${key ? ` data-lk="${escapeHtml(key)}"` : ""}` +
    ` data-side="${side}" data-commentable="${key && side ? 1 : 0}"` +
    `${options.mirror ? ' data-mirror="1"' : ""}>` +
    srPrefix +
    `<span class="prc-marker" aria-hidden="true">${escapeHtml(marker)}</span>` +
    `<span class="prc-code-inner">${escapeHtml(line.text)}</span>` +
    (line.noNewlineAtEof ? `<span class="prc-noeol" title="No newline at end of file">↵̸</span>` : "") +
    `</td>`
  );
}

/**
 * @param {string} key
 * @param {import("../diff/model.js").Side} side
 * @param {number} line
 */
function plusButton(key, side, line) {
  return (
    `<button class="prc-plus" type="button" tabindex="-1" data-act="anchor"` +
    ` data-lk="${escapeHtml(key)}" data-side="${side}"` +
    ` aria-label="Comment on ${side === "LEFT" ? "original " : ""}line ${line}">+</button>`
  );
}

/**
 * The hunk header row: the `@@` range and nothing else.
 *
 * The two cells must add up to the table's column count in **both** layouts, which is why the span
 * is computed rather than written twice — a mismatch here does not error, it silently pushes a
 * column out of alignment for the whole table.
 *
 * @param {import("../diff/model.js").Hunk} hunk
 * @param {Layout} [layout]
 * @returns {string}
 */
export function hunkHeaderHtml(hunk, layout = "unified") {
  const range = `@@ -${hunk.oldStart},${hunk.oldCount} +${hunk.newStart},${hunk.newCount} @@`;
  const expandSpan = layout === "split" ? 1 : 2;
  const headSpan = columnsFor(layout) - expandSpan;
  // No controls here. Both expand buttons get their own band — see `expandBandHtml`.
  return (
    `<tr class="prc-hunk" data-hunk-index="${hunk.index}">` +
    `<td class="prc-expand" colspan="${expandSpan}"></td>` +
    `<td class="prc-hunk-head" colspan="${headSpan}"><span class="prc-hunk-range">${escapeHtml(range)}</span>` +
    (hunk.sectionHeading ? ` <span class="prc-hunk-ctx">${escapeHtml(hunk.sectionHeading)}</span>` : "") +
    `</td></tr>`
  );
}

/**
 * An expand control on a band of its own, one per direction, bracketing the hunk.
 *
 * Two problems drove this shape, both found by using it:
 *
 * 1. With **both** arrows in the hunk header, clicking the downward one inserted rows at the far end of
 *    the hunk — hundreds of lines below the viewport for a long hunk. Nothing changed on screen, so it
 *    read as a dead button.
 * 2. With the upward arrow still in the header, sharing a row with the `@@` range text, it read as
 *    decoration while the downward one — alone on its own band — read as a control. The asymmetry was
 *    the complaint: "add a button to expand up".
 *
 * So both are bands now, identical to each other, one above the hunk and one below. Revealed rows are
 * inserted on the **inside** of whichever band was clicked — `afterend` above, `beforebegin` below — so
 * the lines always appear immediately next to the button that asked for them, in both directions.
 *
 * @param {import("../diff/model.js").Hunk} hunk
 * @param {"before" | "after"} direction
 * @param {Layout} [layout]
 * @returns {string}
 */
export function expandBandHtml(hunk, direction, layout = "unified") {
  const expandSpan = layout === "split" ? 1 : 2;
  const restSpan = columnsFor(layout) - expandSpan;
  const label = direction === "before" ? "Expand context above" : "Expand context below";
  return (
    `<tr class="prc-hunk prc-hunk-band" data-hunk-index="${hunk.index}" data-role="expand-${direction}">` +
    `<td class="prc-expand" colspan="${expandSpan}">${expandButton(hunk.index, direction, label)}</td>` +
    `<td class="prc-hunk-head" colspan="${restSpan}"></td></tr>`
  );
}

/** @param {number} hunkIndex @param {"before" | "after"} direction @param {string} label */
function expandButton(hunkIndex, direction, label) {
  return (
    `<button class="prc-expand-btn" type="button" data-act="expand"` +
    ` data-hunk-index="${hunkIndex}" data-direction="${direction}" title="${escapeHtml(label)}"` +
    // `▲`/`▼` rather than `⌃`/`⌄`: the modifier-key glyphs render thin and small in most UI fonts, and
    // at gutter size they read as punctuation rather than as a control.
    ` aria-label="${escapeHtml(label)}">${direction === "before" ? "▲" : "▼"}</button>`
  );
}

/**
 * Render a whole file's diff table in the requested layout.
 *
 * Split view is **one table with four columns**, not two synchronised tables. Two tables would mean
 * a scroll-sync bug, a selection that cannot cross sides, and rows drifting out of alignment the
 * moment one side wraps; one table gets row-height pairing free from the table algorithm.
 *
 * @param {number} fileIndex
 * @param {import("../diff/model.js").ParsedFile} file
 * @param {Layout} [layout]
 * @returns {string}
 */
export function tableHtml(fileIndex, file, layout = "unified") {
  if (file.patchAvailability !== "present") {
    return `<div class="prc-file-unavailable">${escapeHtml(unavailableReason(file))}</div>`;
  }
  const split = layout === "split";
  /** @type {string[]} */
  const out = [];
  out.push(
    `<table class="prc-diff prc-diff-${split ? "split" : "unified"}" data-file-index="${fileIndex}" data-layout="${split ? "split" : "unified"}">`,
    `<caption class="prc-sr">Diff for ${escapeHtml(file.path)}: ${file.additions} additions, ${file.deletions} deletions</caption>`,
    split
      ? `<colgroup><col class="prc-col-num"><col><col class="prc-col-num"><col></colgroup>`
      : `<colgroup><col class="prc-col-num"><col class="prc-col-num"><col></colgroup>`,
    `<tbody>`,
  );
  for (const hunk of file.hunks) {
    const expandable = expandableDirections(file, hunk);
    out.push(hunkHeaderHtml(hunk, layout));
    // The upward band sits below the range header and above the hunk's lines, so the rows it reveals
    // land between the two — before the first line of the hunk, which is where they belong.
    if (expandable.before) out.push(expandBandHtml(hunk, "before", layout));
    // Expanded context brackets the hunk it was fetched for. Rendered through the same row builder
    // as everything else, so the only thing that distinguishes it is `origin: "expanded"` — which
    // is what makes it non-commentable, and visibly so.
    const before = file.expanded[`beforeHunk:${hunk.index}`];
    if (before) out.push(...renderLines(fileIndex, before, layout));
    out.push(...renderLines(fileIndex, hunk.lines, layout));
    const after = file.expanded[`afterHunk:${hunk.index}`];
    if (after) out.push(...renderLines(fileIndex, after, layout));
    if (expandable.after) out.push(expandBandHtml(hunk, "after", layout));
  }
  out.push(`</tbody></table>`);
  return out.join("");
}

/**
 * Rows for a list of lines, with no table around them — what the expand-context route returns for
 * the client to splice into a table that is already mounted.
 *
 * Going through the same builder as the initial render is the point: an expanded row inserted by the
 * browser and one rendered by the server have to be byte-identical, or anchoring would depend on how
 * a row got there.
 *
 * @param {number} fileIndex
 * @param {import("../diff/model.js").DiffLine[]} lines
 * @param {Layout} [layout]
 * @returns {string}
 */
export function rowsHtml(fileIndex, lines, layout = "unified") {
  return renderLines(fileIndex, lines, layout).join("");
}

/**
 * @param {number} fileIndex
 * @param {import("../diff/model.js").DiffLine[]} lines
 * @param {Layout} layout
 * @returns {string[]}
 */
function renderLines(fileIndex, lines, layout) {
  if (layout !== "split") return lines.map((line) => rowHtmlUnified(fileIndex, line));
  return pairRows(lines).map((pair) => rowHtmlSplit(fileIndex, pair));
}

/**
 * Whether there is hidden context on either side of a hunk.
 *
 * Above the first hunk there is context whenever it does not start at line 1. Below, the answer
 * usually needs the file's total length, which a diff does not carry — so for the last hunk the
 * button is offered optimistically and may come back with nothing.
 *
 * The one case where the diff *does* prove where the file ends is a newly added file: its single
 * hunk is the entire file by construction. Offering expansion there would render a button that
 * cannot ever do anything, on every new file in the pull request.
 *
 * @param {import("../diff/model.js").ParsedFile} file
 * @param {import("../diff/model.js").Hunk} hunk
 */
export function expandableDirections(file, hunk) {
  if (coversWholeFile(file, hunk)) return { before: false, after: false };
  const alreadyBefore = Boolean(file.expanded[`beforeHunk:${hunk.index}`]);
  const alreadyAfter = Boolean(file.expanded[`afterHunk:${hunk.index}`]);
  const previous = file.hunks[hunk.index - 1];
  const next = file.hunks[hunk.index + 1];
  const gapBefore = previous ? hunk.newStart - (previous.newStart + previous.newCount) : hunk.newStart - 1;
  const gapAfter = next ? next.newStart - (hunk.newStart + hunk.newCount) : Number.POSITIVE_INFINITY;
  return { before: !alreadyBefore && gapBefore > 0, after: !alreadyAfter && gapAfter > 0 };
}

/**
 * Whether a hunk provably spans its whole file.
 *
 * True for a file creation: a single hunk whose old range is `-0,0` and whose new range starts at 1
 * says the new side is exactly `newCount` lines long. Deliberately narrow — a false positive here
 * hides context that does exist, which is worse than the dead button it is meant to remove.
 *
 * @param {import("../diff/model.js").ParsedFile} file
 * @param {import("../diff/model.js").Hunk} hunk
 */
export function coversWholeFile(file, hunk) {
  return file.hunks.length === 1 && hunk.oldStart === 0 && hunk.oldCount === 0 && hunk.newStart === 1;
}

/**
 * Kept as a named export because it is the entry point the server and the lazy-mount route have
 * always used; `tableHtml` is the general form.
 *
 * @param {number} fileIndex
 * @param {import("../diff/model.js").ParsedFile} file
 * @returns {string}
 */
export function unifiedTableHtml(fileIndex, file) {
  return tableHtml(fileIndex, file, "unified");
}

/** @param {import("../diff/model.js").ParsedFile} file */
export function unavailableReason(file) {
  if (file.degraded) return "This file's diff could not be parsed reliably, so it cannot be reviewed here.";
  if (file.patchAvailability === "absent-binary") return "Binary file — no line-by-line diff.";
  if (file.patchAvailability === "absent-large") return "GitHub did not provide a diff for this file (too large).";
  return "No changes to display.";
}

/**
 * The per-file panel: header plus body. The body may be empty for a file that has not been
 * mounted yet, which is what makes a 200-file PR openable.
 *
 * A viewed file is collapsed, matching GitHub — and, like GitHub, `viewed` is scoped to the SHA it
 * was ticked at, so a later push un-views whatever changed. That comparison is made by the caller,
 * which is the only place that knows the current head SHA.
 *
 * @param {number} fileIndex
 * @param {import("../diff/model.js").ParsedFile} file
 * @param {{ rendered: boolean, viewed: boolean, collapsed?: boolean, layout?: Layout, anchorId?: string }} state
 * @returns {string}
 */
export function filePanelHtml(fileIndex, file, state) {
  const status = file.previousPath ? `renamed from ${file.previousPath}` : file.status;
  const collapsed = state.collapsed ?? state.viewed;
  return (
    `<section class="prc-file" id="F${fileIndex}" data-file-index="${fileIndex}"` +
    ` data-path="${escapeHtml(file.path)}" data-state="${state.rendered ? "rendered" : "pending"}"` +
    `${state.anchorId ? ` data-anchor-id="${escapeHtml(state.anchorId)}"` : ""}` +
    ` data-collapsed="${collapsed ? 1 : 0}">` +
    `<div class="prc-file-header">` +
    `<button class="prc-file-fold" type="button" data-act="fold-file" data-file-index="${fileIndex}"` +
    // `▼`, not `▾`: the latter is Unicode's *small* triangle and stays small however large the button
    // is, which is why enlarging the button alone did not help. Same glyph as the expand bands, so the
    // two controls read as members of one family.
    ` aria-expanded="${collapsed ? "false" : "true"}" aria-label="Collapse or expand this file"><svg class="prc-icon"` +
    ` viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"` +
    ` stroke-linejoin="round" aria-hidden="true"><path d="m7 10 5 5 5-5"/></svg></button>` +
    `<span class="prc-file-diffstat" aria-label="${file.additions} additions, ${file.deletions} deletions">` +
    `<ins>+${file.additions}</ins> <del>&minus;${file.deletions}</del></span>` +
    `<button class="prc-file-path" type="button" data-act="copy-path" data-path="${escapeHtml(file.path)}"` +
    ` title="Copy path">${escapeHtml(file.path)}</button>` +
    `<span class="prc-file-status">${escapeHtml(status)}</span>` +
    `<span class="prc-spacer"></span>` +
    `<button class="prc-btn prc-btn-quiet" type="button" data-act="copy-file-link" data-file-index="${fileIndex}"` +
    ` title="Copy a permalink to this file">Copy link</button>` +
    `<label class="prc-viewed"><input type="checkbox" class="prc-viewed-box" data-path="${escapeHtml(file.path)}"` +
    `${state.viewed ? " checked" : ""}><span>Viewed</span></label>` +
    `</div>` +
    // Threads GitHub no longer places on a line live here rather than being pinned to a guessed row.
    `<div class="prc-file-threads" hidden></div>` +
    `<div class="prc-file-body">${state.rendered ? tableHtml(fileIndex, file, state.layout ?? "unified") : ""}</div>` +
    `</section>`
  );
}

import { escapeHtml } from "../shared/escape.js";
import { upgradeDiagrams, zoomDiagram } from "./diagrams.js";
import { columnsFor, parseLineKey, unifiedTableHtml } from "../shared/diff-rows.js";
import { buildFileTree, filterFiles, reviewProgress } from "../shared/file-tree.js";
import { blobLinkFor, filesViewPermalink } from "../shared/permalink.js";
import { renderMarkdown } from "../shared/markdown.js";
import { clampRange, describeRange } from "../shared/selection.js";
import { languageForPath } from "../worker/languages.js";

/**
 * The review client.
 *
 * Bundled by esbuild rather than served as a raw import-free file (lavish's approach) for one
 * decisive reason: the diff row renderer must be shared with the server, and two copies of it
 * drifting apart would put comments on the wrong lines.
 *
 * Every module receives its globals explicitly through `init(deps)`; this file is the only one
 * that touches real ones. That makes the logic testable without fabricating a global scope.
 */

const bootstrap = JSON.parse(document.getElementById("prc-bootstrap")?.textContent ?? "{}");

const state = {
  accessId: String(bootstrap.accessId ?? ""),
  pr: bootstrap.pr ?? {},
  files: Array.isArray(bootstrap.files) ? bootstrap.files : [],
  comments: Array.isArray(bootstrap.comments) ? bootstrap.comments : [],
  threads: Array.isArray(bootstrap.threads) ? bootstrap.threads : [],
  replies: Array.isArray(bootstrap.replies) ? bootstrap.replies : [],
  /** Existing threads already on the PR. Fetched, not authored here — read-only except for replies. */
  existing: Array.isArray(bootstrap.existing) ? bootstrap.existing : [],
  existingResolvedKnown: bootstrap.existingResolvedKnown !== false,
  review: bootstrap.review ?? { verdict: null, body: "" },
  viewed: bootstrap.viewed ?? {},
  prefs: bootstrap.prefs ?? {},
  /** @type {"unified" | "split"} */
  layout: bootstrap.layout === "split" ? "split" : "unified",
  presence: "waiting",
  status: String(bootstrap.status ?? "open"),
  /** Who stopped the review, once one of them has: `"user"` or `"agent"`. */
  endedBy: String(bootstrap.endedBy ?? ""),
  /** @type {{ fileIndex: number, side: string, line: number, startLine?: number } | null} */
  anchor: null,
  /**
   * The keyboard cursor: a `data-lk`, not an anchor.
   *
   * Kept separate from `state.anchor` on purpose. Moving with `j`/`k` is reading, and reading must
   * not arm a comment; the cursor only becomes an anchor when the user asks for one with `c`, `a` or
   * the `+` button.
   *
   * @type {string | null}
   */
  cursor: null,
  /**
   * The most recent anchor, kept after one is consumed.
   *
   * Shift-extending reads this when `anchor` is null, so widening a selection still works after a
   * draft was saved — otherwise the gesture silently starts a new single-line selection instead.
   *
   * @type {{ fileIndex: number, side: string, line: number, startLine?: number } | null}
   */
  lastAnchor: null,
  /**
   * How far each hunk has been expanded, keyed `fileIndex:hunkIndex`.
   *
   * Client-side because an expansion is view state: it changes nothing about the review, and writing
   * it to the session would mean rewriting a multi-megabyte snapshot on a scroll gesture. The server
   * stays stateless about it and is told the cursor with each request.
   *
   * @type {Map<string, { before?: number, after?: number }>}
   */
  expansions: new Map(),
  submitting: false,
  /** The head SHA a check found, once one is known to differ from the rendered diff. @type {string} */
  headMoved: "",
  /** @type {any[]} */
  alerts: Array.isArray(bootstrap.alerts) ? bootstrap.alerts : [],
  /** @type {any[]} */
  chat: Array.isArray(bootstrap.chat) ? bootstrap.chat : [],
  findings: Array.isArray(bootstrap.findings) ? bootstrap.findings : [],
  chatOpen: false,
  /** Agent replies that arrived while the panel was closed. */
  unreadChat: 0,
  /** Which draft `d` last took the user to, so repeated presses walk the list. @type {string | null} */
  lastDraftVisited: null,
};

const api = `/api/ui/s/${encodeURIComponent(state.accessId)}`;

/** @param {string} id */
const el = (id) => document.getElementById(id);

/**
 * Per-tab view state.
 *
 * Keyed by the pull request rather than by the access id, which rotates on every `open` — a reader
 * who reopens the canvas has not changed their mind about whether they want the chat panel.
 *
 * Wrapped in try/catch because `sessionStorage` throws outright in some privacy modes, and a panel
 * remembering its own width is not worth a broken page.
 *
 * @param {string} name
 * @param {string} value
 */
function store(name, value) {
  try {
    window.sessionStorage?.setItem(`prc:${state.pr.ref}:${name}`, value);
  } catch {
    /* not available; the default applies */
  }
}

/** @param {string} name @returns {string | null} */
function restore(name) {
  try {
    return window.sessionStorage?.getItem(`prc:${state.pr.ref}:${name}`) ?? null;
  } catch {
    return null;
  }
}

/**
 * @param {string} path
 * @param {RequestInit} [init]
 */
async function request(path, init = {}) {
  const response = await fetch(`${api}${path}`, {
    ...init,
    headers: { "content-type": "application/json", ...(init.headers ?? {}) },
  });
  const text = await response.text();
  const body = text.trim() ? JSON.parse(text) : null;
  if (!response.ok) throw new Error(body?.error ?? `HTTP ${response.status}`);
  return body;
}

// ---------------------------------------------------------------------------
// Lazy file mounting
// ---------------------------------------------------------------------------

/** @param {number} index */
async function mountFile(index) {
  const section = el(`F${index}`);
  if (!section || section.dataset.state !== "pending") return;
  section.dataset.state = "loading";
  try {
    const body = await request(`/files/${index}?layout=${state.layout}`);
    const host = section.querySelector(".prc-file-body");
    // Trusted markup: this string is produced by `unifiedTableHtml` from the parsed diff, and
    // every byte of file content in it went through `escapeHtml`. No PR-authored markup survives
    // to this point, and the server sets a CSP that forbids inline script regardless.
    if (host) host.innerHTML = body.html;
    section.dataset.state = "rendered";
    renderFile(index);
    // Replay whatever context was expanded before a layout switch remounted the file. Cheap: the
    // server cached the blob, so nothing is re-fetched from GitHub.
    await replayExpansions(index);
    highlightFile(index);
  } catch (error) {
    section.dataset.state = "pending";
    toast(`Could not load ${section.dataset.path}: ${error instanceof Error ? error.message : error}`);
  }
}

function observeFiles() {
  if (typeof IntersectionObserver !== "function") {
    for (const file of state.files) if (!file.rendered) mountFile(file.index);
    return;
  }
  const observer = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        const index = Number(entry.target.getAttribute("data-file-index"));
        mountFile(index);
      }
    },
    { rootMargin: "600px 0px" },
  );
  for (const section of document.querySelectorAll(".prc-file")) observer.observe(section);
}

// ---------------------------------------------------------------------------
// Selection → anchor
// ---------------------------------------------------------------------------

/**
 * Every line commentable on one side of one file, read out of the mounted DOM.
 *
 * The DOM is the right source: `data-side` is written by the same renderer the server validates
 * against, so the client cannot disagree with it about which lines GitHub will accept.
 *
 * @param {number} fileIndex
 * @param {string} side
 * @returns {number[]}
 */
function commentableLines(fileIndex, side) {
  /** @type {number[]} */
  const lines = [];
  const table = document.querySelector(`table.prc-diff[data-file-index="${fileIndex}"]`);
  if (!table) return lines;
  for (const cell of table.querySelectorAll(`td.prc-code[data-side="${side === "LEFT" ? "LEFT" : "RIGHT"}"]`)) {
    const parsed = parseLineKey(cell.getAttribute("data-lk") ?? "");
    const line = side === "LEFT" ? parsed?.oldLine : parsed?.newLine;
    if (line != null) lines.push(line);
  }
  return lines;
}

/**
 * Build a range anchor from two line numbers, trimmed to what GitHub will take.
 *
 * @param {number} fileIndex
 * @param {string} side
 * @param {number} anchorLine where the gesture began
 * @param {number} targetLine where it is now
 * @returns {{ anchor: { fileIndex: number, side: string, line: number, startLine?: number }, range: import("../shared/selection.js").ClampedRange } | null}
 */
function rangeAnchor(fileIndex, side, anchorLine, targetLine) {
  const range = clampRange(commentableLines(fileIndex, side), anchorLine, targetLine);
  if (!range) return null;
  return {
    anchor: {
      fileIndex,
      side,
      line: range.to,
      ...(range.from === range.to ? {} : { startLine: range.from }),
    },
    range,
  };
}

/**
 * Highlight the rows an anchor covers.
 *
 * Selecting four lines and seeing nothing change is the single most disorienting thing about the old
 * behaviour: the only feedback was a line number in the composer's header, which is not where the eye
 * is. Painting the rows also makes a *trimmed* selection legible — the user can see that the range
 * stopped at a hunk boundary rather than wondering why the count is wrong.
 *
 * @param {{ fileIndex: number, side: string, line: number, startLine?: number } | null} anchor
 */
function paintSelection(anchor) {
  for (const marked of document.querySelectorAll(".prc-selected, .prc-selected-num")) {
    marked.classList.remove("prc-selected", "prc-selected-num");
  }
  if (!anchor) return;
  const table = document.querySelector(`table.prc-diff[data-file-index="${anchor.fileIndex}"]`);
  if (!table) return;
  const from = anchor.startLine ?? anchor.line;
  // The gutter that belongs to this side, so a LEFT selection tints the old-number column and a RIGHT
  // one the new-number column. In split view both columns exist on the same row, so picking the wrong
  // one would point at the other side's line.
  const numClass = anchor.side === "LEFT" ? "prc-num-old" : "prc-num-new";
  for (const cell of table.querySelectorAll(`td.prc-code[data-side="${anchor.side}"]`)) {
    const parsed = parseLineKey(cell.getAttribute("data-lk") ?? "");
    const line = anchor.side === "LEFT" ? parsed?.oldLine : parsed?.newLine;
    if (line == null || line < from || line > anchor.line) continue;
    // Marked per **cell**, not per row: a split row holds two different lines, and marking the row
    // would claim the other side's code was selected too.
    cell.classList.add("prc-selected");
    cell.closest("tr")?.querySelector(`td.${numClass}`)?.classList.add("prc-selected-num");
  }
}

/**
 * Where a gutter cell points: the file, the side and the line number.
 *
 * A number cell is a much larger target than the `+` button inside it, and clicking one is the gesture
 * people try first. It resolves through the row's code cell for that side, so a cell whose side is not
 * commentable yields nothing rather than a guess.
 *
 * @param {Element | null} numCell
 */
function gutterTarget(numCell) {
  if (!numCell || numCell.classList.contains("prc-num-empty")) return null;
  const side = numCell.classList.contains("prc-num-old") ? "LEFT" : "RIGHT";
  const row = numCell.closest("tr");
  // In split view the left half of a *context* row is a mirror: it shows the original line number, but
  // the line is only commentable on the new side, so there is no LEFT cell to resolve to and this
  // returns null. Most rows in a diff are context, which is why dragging the left gutter there felt
  // like nothing happening — the CSS now marks that gutter non-interactive so the gesture is not
  // invited in the first place.
  const cell = [...(row?.querySelectorAll("td.prc-code") ?? [])].find(
    (code) => code.getAttribute("data-side") === side,
  );
  const anchor = anchorFromCell(cell ?? null);
  if (!anchor) return null;
  const section = numCell.closest(".prc-file");
  const fileIndex = Number(/** @type {HTMLElement} */ (section)?.dataset.fileIndex);
  return Number.isFinite(fileIndex) ? { fileIndex, side, line: anchor.line } : null;
}

/** @param {Element | null} cell */
function anchorFromCell(cell) {
  if (!cell) return null;
  const key = cell.getAttribute("data-lk");
  const side = cell.getAttribute("data-side");
  // Read from the **cell**, never the row. A split row holds two lines with different answers, so it
  // has no single commentability to report and does not carry the attribute at all — which meant this
  // gate returned null for every cell in split view, killing the `+` button, the drag, shift-click and
  // the `c`/`a` shortcuts in one go.
  if (!key || !side || cell.getAttribute("data-commentable") !== "1") return null;
  const parsed = parseLineKey(key);
  if (!parsed) return null;
  const line = side === "LEFT" ? parsed.oldLine : parsed.newLine;
  if (line == null) return null;
  return { fileIndex: parsed.fileIndex, side, line };
}

/**
 * A drag in progress over the gutter.
 *
 * @type {{ fileIndex: number, side: string, anchorLine: number, moved: boolean } | null}
 */
let dragging = null;

/**
 * Start a gutter drag.
 *
 * This is the gesture people reach for to select several lines, and it did not exist — the only route
 * to a range was click-then-shift-click on a `+` button that appears on hover. Preventing the default
 * matters: without it the browser starts a text selection instead, and the two fight.
 *
 * @param {MouseEvent} event
 */
function onGutterMouseDown(event) {
  if (event.button !== 0) return;
  const target = /** @type {Element} */ (event.target);
  // The `+` button keeps its own click behaviour, including shift to extend.
  if (target.closest(".prc-plus")) return;
  const start = gutterTarget(target.closest("td.prc-num"));
  if (!start) return;

  event.preventDefault();
  // Shift starts the drag from the existing anchor instead, so shift+drag widens a selection.
  const existing =
    event.shiftKey && state.anchor && state.anchor.fileIndex === start.fileIndex && state.anchor.side === start.side
      ? (state.anchor.startLine ?? state.anchor.line)
      : start.line;
  dragging = { fileIndex: start.fileIndex, side: start.side, anchorLine: existing, moved: false };
  document.body.classList.add("prc-dragging");
  const built = rangeAnchor(start.fileIndex, start.side, existing, start.line);
  if (built) paintSelection(built.anchor);
}

/** @param {MouseEvent} event */
function onGutterMouseMove(event) {
  if (!dragging) return;
  const over = gutterTarget(/** @type {Element} */ (event.target).closest("td.prc-num"));
  // Leaving the file or crossing to the other side clamps rather than following the pointer: a range
  // must be one file and one side, and `start_side` must equal `side` at the API.
  if (!over || over.fileIndex !== dragging.fileIndex || over.side !== dragging.side) return;
  dragging.moved = true;
  const built = rangeAnchor(dragging.fileIndex, dragging.side, dragging.anchorLine, over.line);
  if (built) paintSelection(built.anchor);
}

/** @param {MouseEvent} event */
function onGutterMouseUp(event) {
  const active = dragging;
  dragging = null;
  document.body.classList.remove("prc-dragging");
  if (!active) return;
  const over = gutterTarget(/** @type {Element} */ (event.target).closest("td.prc-num"));
  const endLine =
    over && over.fileIndex === active.fileIndex && over.side === active.side ? over.line : active.anchorLine;
  const built = rangeAnchor(active.fileIndex, active.side, active.anchorLine, endLine);
  if (!built) return;
  state.anchor = built.anchor;
  paintSelection(built.anchor);
  openComposer("comment", { note: describeRange(built.range, /** @type {any} */ (active.side)) });
}

/** @param {MouseEvent} event */
function onDocumentClick(event) {
  const target = /** @type {Element} */ (event.target);

  const copyPath = target.closest("[data-act='copy-path']");
  if (copyPath) {
    copyText(copyPath.getAttribute("data-path") ?? "", "Path copied");
    return;
  }

  const copyFileLink = target.closest("[data-act='copy-file-link']");
  if (copyFileLink) {
    const index = Number(copyFileLink.getAttribute("data-file-index"));
    const file = state.files.find((/** @type {any} */ candidate) => candidate.index === index);
    if (file) {
      copyText(
        filesViewPermalink({
          ref: repoRef(),
          number: Number(state.pr.number),
          sha: state.pr.headSha,
          anchorId: file.anchorId,
        }),
        "Link to this file copied",
      );
    }
    return;
  }

  const layoutButton = target.closest("[data-act='layout']");
  if (layoutButton) {
    setLayout(layoutButton.getAttribute("data-layout") === "split" ? "split" : "unified");
    return;
  }

  const fold = target.closest("[data-act='fold-file']");
  if (fold) {
    const index = Number(fold.getAttribute("data-file-index"));
    const section = el(`F${index}`);
    const folding = section?.dataset.collapsed !== "1";
    setFolded(index, folding);
    if (!folding) mountFile(index);
    return;
  }

  const expand = target.closest("[data-act='expand']");
  if (expand) {
    expandContext(expand);
    return;
  }

  const treeFile = target.closest("[data-act='tree-file']");
  if (treeFile) {
    revealFile(Number(treeFile.getAttribute("data-file-index")));
    return;
  }

  const treeDir = target.closest("[data-act='tree-dir']");
  if (treeDir) {
    const open = treeDir.getAttribute("aria-expanded") !== "false";
    treeDir.setAttribute("aria-expanded", open ? "false" : "true");
    const children = treeDir.parentElement?.querySelector(".prc-tree-children");
    if (children) /** @type {HTMLElement} */ (children).hidden = open;
    return;
  }

  const plus = target.closest(".prc-plus");
  if (plus) {
    const cell = plus.closest("tr")?.querySelector(`td.prc-code[data-lk="${cssEscape(plus.getAttribute("data-lk"))}"]`);
    const anchor = anchorFromCell(cell ?? null);
    if (!anchor) return;
    // Shift extends the existing anchor into a range, as long as it stays in one file and side.
    // `state.lastAnchor` is consulted too, so extending still works after a draft was saved and the
    // live anchor was cleared — otherwise the second half of the gesture silently starts over.
    const previous = state.anchor ?? state.lastAnchor;
    const extending =
      event.shiftKey && previous && previous.fileIndex === anchor.fileIndex && previous.side === anchor.side;
    // Extending re-opens the composer on the new range, which destroys the old card — so whatever
    // has been typed into it is carried across. Losing a sentence because the user widened the
    // selection would break the one client rule that outranks everything else: the composer's
    // unsent text is inviolable.
    const carried = extending ? composerContents() : null;
    /** @type {string} */
    let note = "";
    if (extending && previous) {
      // Trimmed through the same clamp the drag uses, so a shift-click across a hunk boundary stops at
      // the boundary instead of building a range GitHub will reject on submit.
      const built = rangeAnchor(anchor.fileIndex, anchor.side, previous.startLine ?? previous.line, anchor.line);
      if (!built) return;
      state.anchor = built.anchor;
      note = describeRange(built.range, /** @type {any} */ (anchor.side));
    } else {
      state.anchor = anchor;
    }
    paintSelection(state.anchor);
    // The suggestion editor deliberately does NOT come across: its contents replace a specific line
    // range, and that range just changed. Re-loading it from the new base is the only correct
    // answer — the same rule `setSuggestionRange` enforces on the server.
    openComposer(carried?.mode ?? "comment", {
      prefill: carried?.text ?? "",
      fromThreadId: carried?.fromThreadId,
      note,
    });
    return;
  }

  const mode = target.closest("[data-act='mode']");
  if (mode) {
    const card = mode.closest(".prc-composer");
    const requested = mode.getAttribute("data-mode");
    if (card && (requested === "ask" || requested === "suggest" || requested === "comment")) {
      applyComposerMode(card, requested);
    }
    return;
  }

  const send = target.closest("[data-act='composer-submit']");
  if (send) {
    const card = send.closest(".prc-composer");
    if (card) submitComposer(card);
    return;
  }

  const cancel = target.closest("[data-act='cancel-draft']");
  if (cancel) {
    closeComposer();
    return;
  }

  const remove = target.closest("[data-act='delete-draft']");
  if (remove) {
    deleteDraft(remove.getAttribute("data-id") ?? "");
    return;
  }

  const acceptDrift = target.closest("[data-act='accept-drift']");
  if (acceptDrift) {
    resolveDrift(acceptDrift.getAttribute("data-id") ?? "", "accept");
    return;
  }

  const dismissDrift = target.closest("[data-act='dismiss-drift']");
  if (dismissDrift) {
    resolveDrift(dismissDrift.getAttribute("data-id") ?? "", "dismiss");
    return;
  }

  const zoom = target.closest("[data-act='zoom-diagram']");
  if (zoom) {
    const figure = zoom.closest(".prc-diagram");
    if (figure) zoomDiagram(figure);
    return;
  }

  const jump = target.closest("[data-jump-path]");
  if (jump) {
    jumpToLine(
      jump.getAttribute("data-jump-path") ?? "",
      Number(jump.getAttribute("data-jump-from")),
      Number(jump.getAttribute("data-jump-to")),
    );
    return;
  }

  if (target.closest("[data-act='refresh-diff']")) {
    refreshDiff();
    return;
  }

  const revealed = target.closest("[data-act='reveal-draft']");
  if (revealed) {
    const id = revealed.getAttribute("data-id") ?? "";
    state.lastDraftVisited = id;
    revealDraft(id);
    return;
  }

  const findingWrite = target.closest("[data-act='finding-write']");
  if (findingWrite) {
    openFindingComposer(findingWrite.getAttribute("data-id") ?? "");
    return;
  }
  const findingStatus = target.closest("[data-act='finding-status']");
  if (findingStatus) {
    setFindingStatus(findingStatus.getAttribute("data-id") ?? "", findingStatus.getAttribute("data-status") ?? "");
    return;
  }

  if (target.closest("[data-act='open-chat']")) {
    toggleChat(true);
    return;
  }

  if (target.closest("[data-act='reload-page']")) {
    window.location.reload();
    return;
  }

  const reply = target.closest("[data-act='qa-reply']");
  if (reply) {
    openReply(reply.getAttribute("data-id") ?? "");
    return;
  }

  const sendReply = target.closest("[data-act='qa-send']");
  if (sendReply) {
    const box = sendReply.closest(".prc-reply");
    if (box) submitReply(box);
    return;
  }

  const cancelReply = target.closest("[data-act='qa-cancel']");
  if (cancelReply) {
    cancelReply.closest(".prc-reply")?.remove();
    return;
  }

  const dismiss = target.closest("[data-act='qa-dismiss']");
  if (dismiss) {
    dismissThread(dismiss.getAttribute("data-id") ?? "");
    return;
  }

  const promote = target.closest("[data-act='qa-promote']");
  if (promote) {
    promoteThread(promote.getAttribute("data-id") ?? "");
    return;
  }

  if (target.closest("[data-act='cancel-arm']")) {
    cancelArmedSubmit();
    return;
  }

  const existingReply = target.closest("[data-act='existing-reply']");
  if (existingReply) {
    openExistingReply(existingReply.getAttribute("data-id") ?? "");
    return;
  }

  const sendExisting = target.closest("[data-act='existing-send']");
  if (sendExisting) {
    const box = sendExisting.closest(".prc-reply");
    if (box) queueExistingReply(box);
    return;
  }

  const deleteReply = target.closest("[data-act='reply-delete']");
  if (deleteReply) {
    removeQueuedReply(deleteReply.getAttribute("data-id") ?? "");
    return;
  }

  // Nothing claimed the click, so it was a click away: drop the selection.
  //
  // Not while a composer is open, because then the selection is *what the composer is about* — and a
  // stray click into the page while writing a comment must not silently re-point it. Escape and Cancel
  // are the ways out of a composer; this is only for a selection nobody is using yet.
  clearSelectionOnOutsideClick(target);
}

/**
 * @param {Element} target
 */
function clearSelectionOnOutsideClick(target) {
  if (!state.anchor) return;
  if (document.querySelector(".prc-composer")) return;
  // A click inside the gutter is the start of a new selection, which the mousedown handler owns.
  if (target.closest("td.prc-num, .prc-thread-row, [data-prc-chrome]")) return;
  state.anchor = null;
  paintSelection(null);
}

/**
 * Open a reply box under an existing GitHub thread.
 *
 * The box lives inside the thread card, unlike the Q&A reply box which is a sibling: an existing
 * thread is never re-rendered by an SSE update, so there is nothing to preserve it from.
 *
 * @param {string} threadId
 */
function openExistingReply(threadId) {
  const card = document.querySelector(`.prc-existing[data-thread-id="${cssEscape(threadId)}"]`);
  if (!card || card.querySelector(".prc-reply")) {
    /** @type {HTMLTextAreaElement | null} */ (card?.querySelector(".prc-reply-text"))?.focus();
    return;
  }
  const box = document.createElement("div");
  box.className = "prc-reply";
  box.dataset.threadId = threadId;
  box.innerHTML =
    `<textarea class="prc-reply-text" rows="3" placeholder="Reply on GitHub"></textarea>` +
    `<div class="prc-composer-actions">` +
    `<span class="prc-hint">Queued now, posted after the review — a posted reply cannot be withdrawn.</span>` +
    `<span class="prc-spacer"></span>` +
    `<button type="button" class="prc-btn" data-act="qa-cancel">Cancel</button>` +
    `<button type="button" class="prc-btn prc-btn-primary" data-act="existing-send">Queue reply</button></div>`;
  card.append(box);
  const text = /** @type {HTMLTextAreaElement} */ (box.querySelector(".prc-reply-text"));
  text.focus();
  text.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      queueExistingReply(box);
    }
    if (event.key === "Escape") {
      event.preventDefault();
      box.remove();
    }
  });
}

/** @param {Element} box */
async function queueExistingReply(box) {
  const threadId = /** @type {HTMLElement} */ (box).dataset.threadId ?? "";
  const text = /** @type {HTMLTextAreaElement | null} */ (box.querySelector(".prc-reply-text"));
  const body = text?.value ?? "";
  if (!threadId || !body.trim()) return;
  try {
    const result = await request("/replies", { method: "POST", body: JSON.stringify({ threadId, body }) });
    upsertById(state.replies, result.reply);
    box.remove();
    renderFile(fileIndexForPath(result.reply.path));
    renderReviewBar();
  } catch (error) {
    toast(`Could not queue the reply: ${error instanceof Error ? error.message : error}`);
  }
}

/** @param {string} replyId */
async function removeQueuedReply(replyId) {
  const reply = state.replies.find((/** @type {any} */ candidate) => candidate.id === replyId);
  try {
    await request(`/replies/${encodeURIComponent(replyId)}`, { method: "DELETE" });
    state.replies = state.replies.filter((/** @type {any} */ candidate) => candidate.id !== replyId);
    if (reply) renderFile(fileIndexForPath(reply.path));
    renderReviewBar();
  } catch (error) {
    toast(`Could not remove the reply: ${error instanceof Error ? error.message : error}`);
  }
}

/**
 * Turn an answered question into a draft review comment.
 *
 * The agent's answer is only ever a **prefill**: it opens in an editable composer, and the comment
 * is created by the user pressing Save like any other. No route on the server posts agent-authored
 * text that the user did not submit themselves, which is the whole reason promote is a UI action
 * rather than something the agent can do.
 *
 * @param {string} threadId
 */
function promoteThread(threadId) {
  const thread = findThread(threadId);
  if (!thread || thread.anchor?.kind !== "line") return;
  const answer = [...(thread.messages ?? [])].reverse().find((/** @type {any} */ m) => m.role === "agent");
  const fileIndex = fileIndexForPath(thread.anchor.path);
  if (fileIndex < 0) return;
  state.anchor = {
    fileIndex,
    side: thread.anchor.side,
    line: thread.anchor.line,
    ...(thread.anchor.startLine ? { startLine: thread.anchor.startLine } : {}),
  };
  openComposer("comment", { prefill: answer?.text ?? "", fromThreadId: threadId });
}

/** @param {string | null} value */
function cssEscape(value) {
  const raw = String(value ?? "");
  return typeof CSS !== "undefined" && CSS.escape ? CSS.escape(raw) : raw.replace(/["\\]/g, "\\$&");
}

// ---------------------------------------------------------------------------
// The composer and inline draft cards
// ---------------------------------------------------------------------------

/**
 * The insertion point for a thread row under a given line, creating it if needed.
 *
 * @param {number} fileIndex
 * @param {number} line
 * @param {string} side
 * @returns {Element | null}
 */
function threadHost(fileIndex, line, side) {
  const table = document.querySelector(`table.prc-diff[data-file-index="${fileIndex}"] tbody`);
  if (!table) return null;
  // Every code cell in the row, not just the first: a split row holds two different lines, and in
  // unified the first cell is the only one — one loop is correct for both layouts.
  const row = [...table.querySelectorAll("tr.prc-line")].find((candidate) =>
    [...candidate.querySelectorAll("td.prc-code")].some((cell) => {
      const anchor = anchorFromCell(cell);
      return anchor && anchor.line === line && anchor.side === side;
    }),
  );
  if (!row) return null;

  let after = row;
  while (
    after.nextElementSibling?.classList.contains("prc-thread-row") &&
    after.nextElementSibling.getAttribute("data-line") === String(line)
  ) {
    after = after.nextElementSibling;
  }
  const existing =
    after.classList.contains("prc-thread-row") && after.getAttribute("data-line") === String(line) ? after : null;
  if (existing) return existing.querySelector(".prc-thread-stack");

  const holder = document.createElement("tr");
  holder.className = "prc-thread-row";
  holder.setAttribute("data-line", String(line));
  holder.setAttribute("data-side", side);
  // The colspan must match the table's own column count — read from the table rather than assumed,
  // so a thread row inserted after a layout switch cannot disagree with the `<colgroup>`.
  const columns = columnsFor(table.closest("table")?.getAttribute("data-layout") === "split" ? "split" : "unified");
  holder.innerHTML = `<td class="prc-thread-cell" colspan="${columns}"><div class="prc-thread-stack"></div></td>`;
  after.after(holder);
  return holder.querySelector(".prc-thread-stack");
}

/** @typedef {"comment" | "suggest" | "ask"} ComposerMode */

/**
 * One composer, three destinations.
 *
 * A comment, a suggestion and a question are anchored the same way and written the same way; only
 * where they end up differs \u2014 GitHub as prose, GitHub as an applicable patch, or the agent.
 * Presenting them as modes of one box, rather than three separate gestures, means the user picks the
 * destination *after* deciding what to say, which is the order the thought actually arrives in.
 *
 * @param {ComposerMode} [mode]
 * @param {{ prefill?: string, fromThreadId?: string, note?: string }} [options]
 */
function openComposer(mode = "comment", options = {}) {
  closeComposer();
  // One gate for every route into writing — the `+` button, `c`, `a`, and promoting an answer — so an
  // ended session cannot be talked into a composer it has no agent to serve.
  if (state.status === "ended") {
    toast("This review has ended. Reopen it with `--reopen` to keep writing.");
    return;
  }
  const anchor = state.anchor;
  if (!anchor) return;
  const stack = threadHost(anchor.fileIndex, anchor.line, anchor.side);
  if (!stack) return;

  const range = anchor.startLine ? `${anchor.startLine}\u2013${anchor.line}` : String(anchor.line);
  const card = document.createElement("div");
  card.className = "prc-composer";
  if (options.fromThreadId) card.dataset.fromThreadId = options.fromThreadId;
  // A suggestion can only apply to the new side, so the tab is not offered on a deletion.
  const canSuggest = anchor.side === "RIGHT";
  card.innerHTML =
    `<div class="prc-composer-head">` +
    `<div class="prc-modes" role="tablist" aria-label="What to do with this selection">` +
    `<button type="button" class="prc-mode" data-act="mode" data-mode="comment" role="tab">Comment</button>` +
    (canSuggest
      ? `<button type="button" class="prc-mode" data-act="mode" data-mode="suggest" role="tab">Suggest</button>`
      : "") +
    `<button type="button" class="prc-mode" data-act="mode" data-mode="ask" role="tab">Ask agent</button>` +
    `</div><span class="prc-spacer"></span>` +
    (options.fromThreadId ? `<span class="prc-composer-from">from the agent's answer</span>` : "") +
    `<span class="prc-composer-where"${options.note && /trimmed/.test(options.note) ? ' data-trimmed="1"' : ""}>` +
    // The note already names the side and says whether anything was dropped, so it replaces the bare
    // line number rather than sitting next to it.
    `${escapeHtml(options.note || `line ${range}${anchor.side === "LEFT" ? " (original)" : ""}`)}</span>` +
    `</div>` +
    `<textarea class="prc-composer-text" rows="3"></textarea>` +
    `<div class="prc-suggest" data-role="suggest" hidden>` +
    `<div class="prc-suggest-head"><span>Suggested replacement</span>` +
    `<span class="prc-suggest-meta" data-role="suggest-meta"></span></div>` +
    `<textarea class="prc-suggest-text" rows="4" spellcheck="false"></textarea>` +
    `</div>` +
    `<div class="prc-composer-actions">` +
    `<span class="prc-hint" data-role="hint"></span><span class="prc-spacer"></span>` +
    `<button type="button" class="prc-btn" data-act="cancel-draft">Cancel</button>` +
    `<button type="button" class="prc-btn prc-btn-primary" data-act="composer-submit"></button></div>`;
  stack.append(card);

  const text = /** @type {HTMLTextAreaElement} */ (card.querySelector(".prc-composer-text"));
  if (options.prefill) text.value = options.prefill;
  applyComposerMode(card, canSuggest || mode !== "suggest" ? mode : "comment");
  text.focus();
  // Enter must insert a newline: a review comment, a suggestion and a question are all
  // multi-paragraph text with code fences, so Cmd/Ctrl+Enter is the only submit key. Deliberately
  // unlike lavish, where Enter sends.
  for (const area of card.querySelectorAll("textarea")) {
    area.addEventListener("keydown", (event) => {
      if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
        event.preventDefault();
        submitComposer(card);
      }
      if (event.key === "Escape") {
        event.preventDefault();
        closeComposer();
      }
    });
  }
}

/**
 * @param {Element} card
 * @param {ComposerMode} mode
 */
function applyComposerMode(card, mode) {
  /** @type {HTMLElement} */ (card).dataset.mode = mode;
  for (const button of card.querySelectorAll(".prc-mode")) {
    const active = button.getAttribute("data-mode") === mode;
    button.classList.toggle("prc-mode-on", active);
    button.setAttribute("aria-selected", active ? "true" : "false");
  }
  const text = /** @type {HTMLTextAreaElement | null} */ (card.querySelector(".prc-composer-text"));
  if (text) {
    text.placeholder =
      mode === "ask"
        ? "Ask the agent about these lines"
        : mode === "suggest"
          ? "Why this change (optional)"
          : "Leave a comment";
  }
  const submit = card.querySelector("[data-act='composer-submit']");
  if (submit) submit.textContent = mode === "ask" ? "Ask agent" : mode === "suggest" ? "Save suggestion" : "Save draft";
  const pane = /** @type {HTMLElement | null} */ (card.querySelector("[data-role='suggest']"));
  if (pane) pane.hidden = mode !== "suggest";
  refreshComposerHint();
  if (mode === "suggest") loadSuggestionBase(card);
  else text?.focus();
}

/**
 * Fill the suggestion editor with the lines it would replace.
 *
 * Fetched from the server rather than read out of the DOM: a `\r` is invisible in the DOM, and
 * getting the line endings wrong makes GitHub reformat the whole file when the suggestion is
 * applied. Fetched once \u2014 a refetch would discard whatever the user has typed.
 *
 * @param {Element} card
 */
async function loadSuggestionBase(card) {
  const pane = /** @type {HTMLElement | null} */ (card.querySelector("[data-role='suggest']"));
  const area = /** @type {HTMLTextAreaElement | null} */ (card.querySelector(".prc-suggest-text"));
  const meta = card.querySelector("[data-role='suggest-meta']");
  const anchor = state.anchor;
  if (!pane || !area || !anchor) return;
  if (pane.dataset.loaded === "1") {
    area.focus();
    return;
  }
  const query = new URLSearchParams({ line: String(anchor.line) });
  if (anchor.startLine) query.set("startLine", String(anchor.startLine));
  try {
    const base = await request(`/suggestion-base/${anchor.fileIndex}?${query}`);
    area.value = (base.lines ?? []).join("\n");
    pane.dataset.loaded = "1";
    if (meta) {
      const notes = [base.eol === "CRLF" ? "CRLF line endings preserved" : "", ...(base.warnings ?? [])].filter(
        Boolean,
      );
      meta.textContent = notes.join(" \u00b7 ");
    }
    area.focus();
    area.setSelectionRange(area.value.length, area.value.length);
  } catch (error) {
    if (meta) meta.textContent = error instanceof Error ? error.message : String(error);
    applyComposerMode(card, "comment");
  }
}

/**
 * The hint under the composer, refreshed on presence changes too.
 *
 * Asking is **not** disabled when no agent is listening. The question is queued durably and
 * delivered on the next poll, so blocking the button would throw away work the protocol is
 * explicitly built to keep. Say what will happen instead.
 */
function refreshComposerHint() {
  for (const card of document.querySelectorAll(".prc-composer")) {
    const hint = card.querySelector("[data-role='hint']");
    if (!hint) continue;
    const mode = /** @type {HTMLElement} */ (card).dataset.mode;
    hint.textContent =
      mode === "ask"
        ? state.presence === "waiting"
          ? "No agent is listening yet \u2014 your question is queued and delivered when one polls."
          : "Cmd/Ctrl+Enter to ask. The answer appears here inline."
        : mode === "suggest"
          ? "Cmd/Ctrl+Enter to save. An empty box means \u201cdelete these lines\u201d."
          : "Cmd/Ctrl+Enter to save. Drafts stay local until you submit the review.";
  }
}

/** @param {Element} card */
function submitComposer(card) {
  const text = /** @type {HTMLTextAreaElement | null} */ (card.querySelector(".prc-composer-text"));
  if (!text) return;
  const host = /** @type {HTMLElement} */ (card);
  const mode = host.dataset.mode;
  if (mode === "ask") {
    askQuestion(text.value);
    return;
  }
  if (mode === "suggest") {
    const area = /** @type {HTMLTextAreaElement | null} */ (card.querySelector(".prc-suggest-text"));
    // `""` is one empty line; an untouched, never-loaded box is not a suggestion at all.
    const replacementLines =
      area && card.querySelector("[data-role='suggest']")?.getAttribute("data-loaded") === "1"
        ? area.value.split("\n")
        : null;
    if (replacementLines === null) {
      toast("The suggestion is still loading.");
      return;
    }
    saveDraft(text.value, { replacementLines, fromThreadId: host.dataset.fromThreadId });
    return;
  }
  saveDraft(text.value, { fromThreadId: host.dataset.fromThreadId });
}

/**
 * What is currently in the open composer, if there is one.
 *
 * @returns {{ mode: ComposerMode, text: string, fromThreadId: string | undefined } | null}
 */
function composerContents() {
  const card = /** @type {HTMLElement | null} */ (document.querySelector(".prc-composer"));
  if (!card) return null;
  const mode = card.dataset.mode;
  return {
    mode: mode === "ask" || mode === "suggest" ? mode : "comment",
    text: /** @type {HTMLTextAreaElement | null} */ (card.querySelector(".prc-composer-text"))?.value ?? "",
    fromThreadId: card.dataset.fromThreadId,
  };
}

function closeComposer() {
  for (const card of document.querySelectorAll(".prc-composer")) {
    const row = card.closest("tr.prc-thread-row");
    card.remove();
    if (row && !row.querySelector(".prc-thread-stack")?.children.length) row.remove();
  }
}

/**
 * The one place a draft enters client state.
 *
 * Four surfaces read `state.comments`: the card under the line, the per-file chip in the tree, the
 * drafts index above it, and the review bar's count. Updating the array and then re-rendering only
 * the surface the user happened to be looking at left the others showing the state before the edit —
 * which is how a saved draft appeared under its line while the index still said "0 drafts".
 *
 * @param {any} comment
 */
function putDraft(comment) {
  upsertById(state.comments, comment);
  renderDrafts();
  renderTree();
}

/**
 * The one place a draft leaves client state. See {@link putDraft}.
 *
 * @param {string} id
 * @returns {any} the comment that was removed, if it was there
 */
function dropDraft(id) {
  const removed = /** @type {any[]} */ (state.comments).find((comment) => comment.id === id);
  state.comments = /** @type {any[]} */ (state.comments).filter((comment) => comment.id !== id);
  renderDrafts();
  renderTree();
  return removed;
}

/**
 * @param {string} body
 * @param {{ replacementLines?: string[], fromThreadId?: string }} [extra]
 */
async function saveDraft(body, extra = {}) {
  const anchor = state.anchor;
  const hasSuggestion = Array.isArray(extra.replacementLines);
  // A suggestion carries its own meaning, so the prose is optional there — but a comment with
  // neither text nor a patch says nothing.
  if (!anchor || (!body.trim() && !hasSuggestion)) return;
  try {
    const result = await request("/comments", {
      method: "POST",
      body: JSON.stringify({
        fileIndex: anchor.fileIndex,
        side: anchor.side,
        line: anchor.line,
        startLine: anchor.startLine,
        body,
        ...(hasSuggestion ? { suggestion: { replacementLines: extra.replacementLines } } : {}),
        ...(extra.fromThreadId ? { fromThreadId: extra.fromThreadId } : {}),
      }),
    });
    putDraft(result.comment);
    if (extra.fromThreadId) {
      const thread = findThread(extra.fromThreadId);
      if (thread) {
        thread.status = "promoted";
        thread.promotedCommentId = result.comment.id;
      }
    }
    closeComposer();
    state.lastAnchor = state.anchor;
    state.anchor = null;
    paintSelection(null);
    renderFile(anchor.fileIndex);
    renderReviewBar();
    for (const warning of result.warnings ?? []) toast(warning);
  } catch (error) {
    toast(`Could not save the draft: ${error instanceof Error ? error.message : error}`);
  }
}

/** @param {string} body */
async function askQuestion(body) {
  const anchor = state.anchor;
  if (!anchor || !body.trim()) return;
  try {
    const result = await request("/questions", {
      method: "POST",
      body: JSON.stringify({
        fileIndex: anchor.fileIndex,
        side: anchor.side,
        line: anchor.line,
        startLine: anchor.startLine,
        body,
      }),
    });
    upsertById(state.threads, result.thread);
    closeComposer();
    state.lastAnchor = state.anchor;
    state.anchor = null;
    paintSelection(null);
    renderFile(anchor.fileIndex);
    if (result.notice) toast(result.notice);
    if (result.presence === "waiting") {
      toast("Question queued. Run `pr-review-canvas poll` in your agent session to deliver it.");
    }
  } catch (error) {
    toast(`Could not send the question: ${error instanceof Error ? error.message : error}`);
  }
}

/** @param {string} threadId */
function openReply(threadId) {
  const card = document.querySelector(`.prc-qa[data-thread-id="${cssEscape(threadId)}"]`);
  if (!card || card.nextElementSibling?.classList.contains("prc-reply")) {
    /** @type {HTMLTextAreaElement | null} */ (
      card?.nextElementSibling?.querySelector(".prc-reply-text") ?? null
    )?.focus();
    return;
  }
  const box = document.createElement("div");
  box.className = "prc-reply";
  box.dataset.threadId = threadId;
  box.innerHTML =
    `<textarea class="prc-reply-text" rows="2" placeholder="Reply to the agent"></textarea>` +
    `<div class="prc-composer-actions"><span class="prc-hint">Cmd/Ctrl+Enter to send</span>` +
    `<span class="prc-spacer"></span>` +
    `<button type="button" class="prc-btn" data-act="qa-cancel">Cancel</button>` +
    `<button type="button" class="prc-btn prc-btn-primary" data-act="qa-send">Send</button></div>`;
  card.after(box);
  const text = /** @type {HTMLTextAreaElement} */ (box.querySelector(".prc-reply-text"));
  text.focus();
  text.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      submitReply(box);
    }
    if (event.key === "Escape") {
      event.preventDefault();
      box.remove();
    }
  });
}

/** @param {Element} box */
async function submitReply(box) {
  const threadId = /** @type {HTMLElement} */ (box).dataset.threadId ?? "";
  const text = /** @type {HTMLTextAreaElement | null} */ (box.querySelector(".prc-reply-text"));
  const body = text?.value ?? "";
  if (!threadId || !body.trim()) return;
  try {
    const result = await request(`/questions/${encodeURIComponent(threadId)}/messages`, {
      method: "POST",
      body: JSON.stringify({ body }),
    });
    const thread = findThread(threadId);
    if (thread) {
      appendMessage(thread, result.message);
      thread.status = "open";
    }
    box.remove();
    renderThreadFile(threadId);
  } catch (error) {
    toast(`Could not send the reply: ${error instanceof Error ? error.message : error}`);
  }
}

/** @param {string} threadId */
async function dismissThread(threadId) {
  try {
    await request(`/questions/${encodeURIComponent(threadId)}/dismiss`, { method: "POST" });
    const thread = findThread(threadId);
    if (thread) thread.status = "dismissed";
    renderThreadFile(threadId);
  } catch (error) {
    toast(`Could not dismiss the thread: ${error instanceof Error ? error.message : error}`);
  }
}

/** @param {string} threadId */
function findThread(threadId) {
  return /** @type {any} */ (state.threads.find((/** @type {any} */ thread) => thread.id === threadId));
}

/**
 * Add a server-created item to a list, or replace the copy already there.
 *
 * Every "create" in this client has two paths back into state: the HTTP response and an SSE
 * broadcast, on independent connections with no ordering between them. So the SSE event can land
 * *before* the POST resolves, and an unguarded `push` in the response handler then appends a second
 * copy of the same object — which renders as two identical cards. That is exactly what happened to
 * a question: one thread on disk, two "Question" cards on screen.
 *
 * Keying on the server's id makes both paths idempotent regardless of which wins.
 *
 * @template {{ id: string }} T
 * @param {T[]} list
 * @param {T} item
 * @returns {T[]}
 */
function upsertById(list, item) {
  if (!item?.id) return list;
  const at = list.findIndex((candidate) => candidate.id === item.id);
  if (at >= 0) list[at] = item;
  else list.push(item);
  return list;
}

/**
 * Append a message unless it is already there. Messages carry no id, so `role` plus the server's
 * timestamp is the identity — enough to make the local echo and the SSE broadcast idempotent.
 *
 * @param {any} thread
 * @param {any} message
 */
function appendMessage(thread, message) {
  if (!message) return;
  const seen = thread.messages.some(
    (/** @type {any} */ existing) => existing.role === message.role && existing.at === message.at,
  );
  if (!seen) thread.messages.push(message);
}

/** @param {string} threadId */
function renderThreadFile(threadId) {
  const thread = findThread(threadId);
  if (thread) renderFile(fileIndexForPath(thread.anchor.path));
}

/**
 * A Q&A thread card. Every piece of text goes in through `textContent`: the agent's answer is
 * model output and the question is the user's own prose, and neither is markup.
 *
 * @param {any} thread
 * @returns {HTMLElement}
 */
function qaCard(thread) {
  const card = document.createElement("div");
  card.className = "prc-qa";
  card.dataset.threadId = thread.id;
  card.dataset.status = thread.status;

  const head = document.createElement("div");
  head.className = "prc-qa-head";
  const badge = document.createElement("span");
  badge.className = "prc-badge prc-badge-qa";
  badge.textContent =
    thread.status === "answered"
      ? "Answered"
      : thread.status === "promoted"
        ? "Promoted"
        : thread.status === "dismissed"
          ? "Dismissed"
          : "Question";
  head.append(badge);
  if (thread.anchor?.outsideDiff) {
    const note = document.createElement("span");
    note.className = "prc-qa-note";
    note.textContent = "outside the diff — cannot become a PR comment";
    head.append(note);
  }
  const spacer = document.createElement("span");
  spacer.className = "prc-spacer";
  head.append(spacer);
  if (thread.status !== "dismissed") {
    // Promote is only offered once there is an answer to promote, and never for an anchor GitHub
    // would refuse — offering a button that can only fail is worse than not offering it.
    if (
      thread.messages?.some((/** @type {any} */ message) => message.role === "agent") &&
      !thread.anchor?.outsideDiff &&
      thread.status !== "promoted"
    ) {
      head.append(quietButton("→ PR comment", "qa-promote", thread.id));
    }
    head.append(quietButton("Reply", "qa-reply", thread.id), quietButton("Dismiss", "qa-dismiss", thread.id));
  }
  card.append(head);

  for (const message of thread.messages ?? []) {
    const row = document.createElement("div");
    row.className = `prc-qa-msg prc-qa-${message.role === "agent" ? "agent" : "user"}`;
    const who = document.createElement("span");
    who.className = "prc-qa-role";
    who.textContent = message.role === "agent" ? "Agent" : "You";
    const text = document.createElement("div");
    text.className = "prc-qa-text prc-md";
    // An agent answer is markdown — fences, lists, links — and so is the question, because the user
    // is typing into the same box that will become a GitHub comment. Rendered through our own parser,
    // which cannot produce an element type the renderer does not know about.
    text.append(renderBody(message.text));
    row.append(who, text);
    card.append(row);
  }

  if (thread.status === "open") {
    const pending = document.createElement("div");
    pending.className = "prc-qa-pending";
    pending.textContent =
      state.presence === "waiting" ? "Queued — no agent is listening yet." : "Waiting for the agent…";
    card.append(pending);
  }
  return card;
}

/**
 * A thread that is already on the pull request.
 *
 * Read-only apart from replying: this is other people's writing, and nothing here edits or resolves
 * it. Resolving is deliberately left to GitHub — doing it from a local tool would change the PR's
 * state without the author seeing why.
 *
 * @param {any} thread
 * @returns {HTMLElement}
 */
function existingCard(thread) {
  const card = document.createElement("div");
  card.className = "prc-existing";
  card.dataset.threadId = thread.id;
  if (thread.isResolved) card.dataset.resolved = "1";
  if (thread.isOutdated) card.dataset.outdated = "1";

  const head = document.createElement("div");
  head.className = "prc-existing-head";
  const badge = document.createElement("span");
  badge.className = "prc-badge prc-badge-existing";
  badge.textContent = "On GitHub";
  head.append(badge);
  if (thread.isResolved) head.append(chip("Resolved", "prc-chip-resolved"));
  if (thread.isOutdated) head.append(chip("Outdated", "prc-chip-outdated"));
  // Say when the flag is simply unknown rather than implying "unresolved".
  if (!state.existingResolvedKnown) head.append(chip("resolved state unavailable", "prc-chip-unknown"));
  head.append(spacerNode());
  const queued = state.replies.filter((/** @type {any} */ reply) => reply.threadId === thread.id);
  if (!queued.some((/** @type {any} */ reply) => reply.state === "draft")) {
    head.append(quietButton("Reply", "existing-reply", thread.id));
  }
  const link = safeHttpUrl(thread.comments?.[0]?.url);
  if (link) {
    const anchor = document.createElement("a");
    anchor.className = "prc-existing-link";
    anchor.href = link;
    anchor.target = "_blank";
    anchor.rel = "noreferrer noopener";
    anchor.textContent = "View";
    head.append(anchor);
  }
  card.append(head);

  for (const comment of thread.comments ?? []) {
    const row = document.createElement("div");
    row.className = "prc-existing-msg";
    const who = document.createElement("span");
    who.className = "prc-existing-author";
    who.textContent = comment.author;
    const body = document.createElement("div");
    body.className = "prc-existing-body prc-md";
    // Someone else's markdown. This is the most hostile input in the application — arbitrary text from
    // strangers — which is exactly why the parser has no node type capable of carrying raw HTML.
    body.append(renderBody(comment.body));
    row.append(who, body);
    card.append(row);
  }

  for (const reply of queued) card.append(queuedReplyCard(reply));
  return card;
}

/**
 * A reply the user has queued but not yet sent.
 *
 * The wording matters: a reply is **not** part of the atomic review. It is posted after it, one call
 * each, and a posted reply cannot be withdrawn — so the card says "will be posted", never "draft".
 *
 * @param {any} reply
 * @returns {HTMLElement}
 */
function queuedReplyCard(reply) {
  const card = document.createElement("div");
  card.className = `prc-queued-reply prc-queued-${reply.state}`;
  card.dataset.replyId = reply.id;
  const head = document.createElement("div");
  head.className = "prc-draft-head";
  const badge = document.createElement("span");
  badge.className = "prc-badge";
  badge.textContent =
    reply.state === "posted" ? "Reply posted" : reply.state === "failed" ? "Reply failed" : "Reply queued";
  head.append(badge, spacerNode());
  if (reply.state !== "posted") head.append(quietButton("Remove", "reply-delete", reply.id));
  card.append(head);
  const body = document.createElement("div");
  body.className = "prc-draft-body prc-md";
  body.append(renderBody(reply.body));
  card.append(body);
  if (reply.state === "failed" && reply.error) {
    const error = document.createElement("div");
    error.className = "prc-queued-error";
    error.textContent = reply.error;
    card.append(error);
  }
  return card;
}

/** @param {string} text @param {string} className */
function chip(text, className) {
  const node = document.createElement("span");
  node.className = `prc-chip ${className}`;
  node.textContent = text;
  return node;
}

function spacerNode() {
  const node = document.createElement("span");
  node.className = "prc-spacer";
  return node;
}

/** @param {string} label @param {string} act @param {string} id */
function quietButton(label, act, id) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "prc-btn prc-btn-quiet";
  button.setAttribute("data-act", act);
  button.setAttribute("data-id", id);
  button.textContent = label;
  return button;
}

/**
 * Accept or decline a proposed re-anchor.
 *
 * The request carries only the comment id. Where the comment may move was decided by the drift
 * cascade and is held server-side, so no request from this page can relocate a comment to a line the
 * cascade never sanctioned.
 *
 * @param {string} id
 * @param {"accept" | "dismiss"} decision
 */
async function resolveDrift(id, decision) {
  try {
    const result = await request(`/comments/${encodeURIComponent(id)}/drift/${decision}`, { method: "POST" });
    if (result?.comment) putDraft(result.comment);
    renderAll();
    renderReviewBar();
    toast(
      decision === "accept"
        ? "Comment moved to the proposed line, and back in the review."
        : "Left where it was. It stays out of the submission until you delete or rewrite it.",
    );
  } catch (error) {
    toast(`Could not update that comment: ${error instanceof Error ? error.message : error}`);
  }
}

/** @param {string} id */
async function deleteDraft(id) {
  try {
    await request(`/comments/${encodeURIComponent(id)}`, { method: "DELETE" });
    const removed = dropDraft(id);
    if (removed) renderFile(fileIndexForPath(removed.anchor.path));
    renderReviewBar();
  } catch (error) {
    toast(`Could not delete the draft: ${error instanceof Error ? error.message : error}`);
  }
}

/** @param {string} path */
function fileIndexForPath(path) {
  return state.files.find((/** @type {any} */ file) => file.path === path)?.index ?? -1;
}

/**
 * Re-render every inline card for one file.
 *
 * The stack order under a line is fixed — **Q&A, then drafts, then the open composer** — so an
 * arriving answer can never reshuffle what the user is looking at, and the composer always stays
 * closest to the next line of code, where the eye already is.
 *
 * An open composer or reply box is never destroyed by a re-render. That rule is load-bearing: the
 * user may have typed a paragraph into it, and no server update is worth losing that.
 *
 * @param {number} fileIndex
 */
function renderFile(fileIndex) {
  const file = state.files.find((/** @type {any} */ candidate) => candidate.index === fileIndex);
  if (!file) return;
  // Unplaced conversations live in the header, so they render whether or not the table is mounted.
  renderFileThreads(fileIndex);
  const table = document.querySelector(`table.prc-diff[data-file-index="${fileIndex}"]`);
  if (!table) return;

  // Detach rather than drop: these are re-attached under their thread once the cards are rebuilt.
  const replies = [...table.querySelectorAll(".prc-reply")];
  for (const box of replies) box.remove();
  for (const card of table.querySelectorAll(".prc-existing, .prc-qa, .prc-draft")) card.remove();

  // Existing PR conversation first: it predates everything the user is writing now, so it reads as
  // the context it is rather than as competing with their own drafts.
  for (const thread of /** @type {any[]} */ (state.existing)) {
    if (thread.path !== file.path || thread.line == null || thread.subjectType === "file") continue;
    const stack = threadHost(fileIndex, thread.line, thread.side);
    if (stack) stack.append(existingCard(thread));
  }

  for (const thread of /** @type {any[]} */ (state.threads)) {
    if (thread.anchor?.path !== file.path || thread.anchor?.kind !== "line") continue;
    const stack = threadHost(fileIndex, thread.anchor.line, thread.anchor.side);
    if (stack) stack.append(qaCard(thread));
  }

  renderCommentsForFile(fileIndex);

  for (const box of replies) {
    const id = /** @type {HTMLElement} */ (box).dataset.threadId ?? "";
    const card = table.querySelector(`.prc-qa[data-thread-id="${cssEscape(id)}"]`);
    if (card) card.after(box);
  }

  // Rows left holding nothing are removed last, so a thread row that only existed for a detached
  // reply is not swept away before the reply goes back into it.
  for (const row of table.querySelectorAll("tr.prc-thread-row")) {
    if (!row.querySelector(".prc-thread-stack")?.children.length) row.remove();
  }
}

/** @param {number} fileIndex */
function renderCommentsForFile(fileIndex) {
  const file = state.files.find((/** @type {any} */ candidate) => candidate.index === fileIndex);
  if (!file) return;
  for (const comment of /** @type {any[]} */ (state.comments)) {
    if (comment.anchor.path !== file.path) continue;
    const stack = threadHost(fileIndex, comment.anchor.line, comment.anchor.side);
    // No host means the line the comment was written against is not on screen — after a push, that is
    // exactly what an orphaned draft looks like. It is rendered under the file header instead by
    // `renderFileThreads`; dropping it here would make the user's own text invisible.
    if (!stack) continue;
    stack.append(draftCard(comment));
  }
}

/**
 * One drafted comment.
 *
 * @param {any} comment
 * @returns {HTMLElement}
 */
function draftCard(comment) {
  const card = document.createElement("div");
  card.className = `prc-draft prc-draft-${comment.state}`;
  card.dataset.draftId = comment.id;
  const label = comment.state === "submitted" ? "Submitted" : comment.state === "stale" ? "Needs a decision" : "Draft";
  card.innerHTML =
    `<div class="prc-draft-head"><span class="prc-badge">${label}</span>` +
    (comment.suggestion ? `<span class="prc-badge prc-badge-suggest">Suggestion</span>` : "") +
    (comment.fromThreadId ? `<span class="prc-qa-note">from a question</span>` : "") +
    `<span class="prc-spacer"></span>` +
    (comment.state !== "submitted"
      ? `<button type="button" class="prc-btn prc-btn-quiet" data-act="delete-draft" data-id="${escapeHtml(comment.id)}">Delete</button>`
      : "") +
    `</div>`;
  if (comment.state === "stale") card.append(driftStrip(comment));
  // The body is appended as nodes rather than interpolated. Rendering it as markdown is not
  // decoration: GitHub will render it as markdown once posted, so showing it any other way means the
  // preview and the posted comment disagree — and the user finds out after it is public.
  const body = document.createElement("div");
  body.className = "prc-draft-body prc-md";
  body.append(renderBody(comment.body));
  card.append(body);
  if (comment.suggestion) card.append(suggestionPreview(comment.suggestion));
  return card;
}

/**
 * The strip on a draft the last refresh could not place with certainty.
 *
 * It says three things, in this order: that the comment is held out of the next submission, where
 * the code went if that is known, and what the user can do. The move is offered as a button and
 * never applied on their behalf — a comment posted onto code the reviewer has not read is the worst
 * outcome this tool has.
 *
 * @param {any} comment
 * @returns {HTMLElement}
 */
function driftStrip(comment) {
  const strip = document.createElement("div");
  strip.className = "prc-drift";

  const text = document.createElement("p");
  text.className = "prc-drift-text";
  const reason = String(comment.staleReason ?? "the anchored code has changed");
  text.textContent = `⚠ The author pushed and ${reason}. This comment stays out of any submission until you decide.`;
  strip.append(text);

  const proposed = comment.proposedAnchor;
  if (proposed && proposed.kind !== "file") {
    const where =
      proposed.startLine !== undefined ? `lines ${proposed.startLine}–${proposed.line}` : `line ${proposed.line}`;
    const moved = proposed.path !== comment.anchor.path ? ` in ${proposed.path}` : "";
    const accept = document.createElement("button");
    accept.type = "button";
    accept.className = "prc-btn";
    accept.dataset.act = "accept-drift";
    accept.dataset.id = comment.id;
    accept.textContent = `Move to ${where}${moved}`;
    const dismiss = document.createElement("button");
    dismiss.type = "button";
    dismiss.className = "prc-btn prc-btn-quiet";
    dismiss.dataset.act = "dismiss-drift";
    dismiss.dataset.id = comment.id;
    dismiss.textContent = "Keep where it was";
    const actions = document.createElement("div");
    actions.className = "prc-drift-actions";
    actions.append(accept, dismiss);
    strip.append(actions);
  } else if ((comment.driftCandidates ?? []).length > 0) {
    // Several equally plausible homes. Listing them without an Accept button is deliberate: picking
    // one for the user here would be the guess the drift cascade refused to make.
    const list = document.createElement("ul");
    list.className = "prc-drift-candidates";
    for (const candidate of comment.driftCandidates) {
      const item = document.createElement("li");
      item.textContent = `line ${candidate.line}: ${candidate.text}`;
      list.append(item);
    }
    const note = document.createElement("p");
    note.className = "prc-drift-text";
    note.textContent = "That line now appears in more than one place, so nothing is proposed:";
    strip.append(note, list);
  }
  return strip;
}

/**
 * The before/after preview of a stored suggestion.
 *
 * Built from DOM nodes with `textContent`, because these lines are file content: escaping them into
 * an HTML string would work, but there is no reason to put source code through a string template at
 * all when the DOM API cannot misinterpret it.
 *
 * @param {any} suggestion
 * @returns {HTMLElement}
 */
function suggestionPreview(suggestion) {
  const host = document.createElement("div");
  host.className = "prc-suggest-preview";
  const removed = document.createElement("pre");
  removed.className = "prc-suggest-old";
  removed.textContent = (suggestion.baseLines ?? []).map((/** @type {string} */ t) => t.replace(/\r$/, "")).join("\n");
  const added = document.createElement("pre");
  added.className = "prc-suggest-new";
  const lines = suggestion.replacementLines ?? [];
  // An empty replacement is a deletion. Saying so beats rendering an empty box.
  added.textContent = lines.length > 0 ? lines.join("\n") : "(these lines are deleted)";
  if (lines.length === 0) added.classList.add("prc-suggest-empty");
  host.append(removed, added);
  return host;
}

function renderAll() {
  for (const file of state.files) renderFile(file.index);
  // The sidebar carries draft and question counts per file, so it follows every render.
  renderTree();
  renderDrafts();
  renderFindings();
}

function renderFindings() {
  const host = el("prcFindings");
  const list = el("prcFindingsList");
  const count = el("prcFindingsCount");
  if (!host || !list || !count) return;
  const findings = /** @type {any[]} */ (state.findings).filter((finding) => finding.status === "open");
  host.hidden = findings.length === 0;
  count.textContent = `${findings.length} agent finding${findings.length === 1 ? "" : "s"}`;
  list.replaceChildren();
  for (const finding of findings) {
    const card = document.createElement("article");
    card.className = "prc-finding";
    card.dataset.severity = finding.severity;
    const title = document.createElement("strong");
    title.textContent = finding.title;
    const where = document.createElement("span");
    where.className = "prc-finding-where";
    const stale = finding.headSha && finding.headSha !== state.pr.headSha;
    where.textContent = finding.anchor?.path
      ? `${finding.anchor.path.split("/").at(-1)}${finding.anchor.line ? `:${finding.anchor.line}` : ""}`
      : "Pull request";
    if (stale) where.textContent += " · evidence is from an older head";
    const body = document.createElement("p");
    body.textContent = finding.body;
    const actions = document.createElement("div");
    actions.className = "prc-finding-actions";
    if (finding.anchor?.line && !stale) actions.append(findingButton("Write comment", "finding-write", finding.id));
    actions.append(
      findingButton("Acknowledge", "finding-status", finding.id, "acknowledged"),
      findingButton("Dismiss", "finding-status", finding.id, "dismissed"),
    );
    card.append(title, where, body, actions);
    list.append(card);
  }
}

/** @param {string} label @param {string} act @param {string} id @param {string} [status] */
function findingButton(label, act, id, status) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "prc-btn prc-btn-quiet";
  button.dataset.act = act;
  button.dataset.id = id;
  if (status) button.dataset.status = status;
  button.textContent = label;
  return button;
}

/** @param {string} id */
async function openFindingComposer(id) {
  const finding = /** @type {any[]} */ (state.findings).find((item) => item.id === id);
  if (!finding?.anchor?.path || !finding.anchor.line) return;
  const fileIndex = fileIndexForPath(finding.anchor.path);
  if (fileIndex < 0) return;
  await mountFile(fileIndex);
  const side = finding.anchor.side ?? "RIGHT";
  let selected = null;
  for (const cell of document.querySelectorAll(`#F${fileIndex} td.prc-code[data-lk]`)) {
    const parsed = parseLineKey(cell.getAttribute("data-lk") ?? "");
    const line = side === "LEFT" ? parsed?.oldLine : parsed?.newLine;
    if (line === finding.anchor.line && cell.getAttribute("data-side") === side) {
      selected = cell;
      break;
    }
  }
  const anchor = anchorFromCell(selected);
  if (!anchor) {
    jumpToLine(finding.anchor.path, finding.anchor.line, finding.anchor.line);
    toast("This finding is not on a GitHub-commentable line. Showing the evidence instead.");
    return;
  }
  state.anchor = anchor;
  paintSelection(anchor);
  openComposer("comment", { note: `agent finding · line ${finding.anchor.line}` });
}

/** @param {string} id @param {string} status */
async function setFindingStatus(id, status) {
  try {
    const result = await request(`/findings/${encodeURIComponent(id)}/status`, {
      method: "PUT",
      body: JSON.stringify({ status }),
    });
    const finding = /** @type {any[]} */ (state.findings).find((item) => item.id === id);
    if (finding && result.finding) Object.assign(finding, result.finding);
    renderFindings();
    renderTree();
  } catch (error) {
    toast(`Could not update finding: ${error instanceof Error ? error.message : error}`);
  }
}

// ---------------------------------------------------------------------------
// Threads GitHub no longer places on a line
// ---------------------------------------------------------------------------

/**
 * Render the per-file list of threads that have no inline home.
 *
 * An outdated thread has `line: null` and only an `original_line`. Pinning it to that number would
 * attach someone else's comment to whatever code now occupies that position — the mis-anchoring this
 * project refuses everywhere else — so those threads are listed under the file header instead, where
 * being out of place is the honest presentation.
 *
 * @param {number} fileIndex
 */
function renderFileThreads(fileIndex) {
  const file = state.files.find((/** @type {any} */ candidate) => candidate.index === fileIndex);
  const host = el(`F${fileIndex}`)?.querySelector(".prc-file-threads");
  if (!file || !host) return;
  host.textContent = "";
  const unplaced = /** @type {any[]} */ (state.existing).filter(
    (thread) => thread.path === file.path && (thread.line == null || thread.subjectType === "file"),
  );
  // A draft whose line the last push removed has nowhere inline to go either. It belongs here for
  // the same reason an outdated thread does: being visibly out of place is honest, and being
  // invisible would lose the user's own writing.
  const orphaned = /** @type {any[]} */ (state.comments).filter(
    (comment) =>
      comment.state === "stale" &&
      comment.anchor.path === file.path &&
      !threadHost(fileIndex, comment.anchor.line, comment.anchor.side),
  );
  /** @type {HTMLElement} */ (host).hidden = unplaced.length === 0 && orphaned.length === 0;
  if (unplaced.length === 0 && orphaned.length === 0) return;

  if (orphaned.length > 0) {
    const head = document.createElement("div");
    head.className = "prc-file-threads-head";
    head.textContent =
      orphaned.length === 1
        ? "1 of your draft comments lost the line it was on"
        : `${orphaned.length} of your draft comments lost the lines they were on`;
    host.append(head);
    for (const comment of orphaned) host.append(draftCard(comment));
  }
  if (unplaced.length === 0) return;

  const head = document.createElement("div");
  head.className = "prc-file-threads-head";
  head.textContent =
    unplaced.length === 1
      ? "1 conversation not attached to a line"
      : `${unplaced.length} conversations not attached to a line`;
  host.append(head);
  for (const thread of unplaced) host.append(existingCard(thread));
}

// ---------------------------------------------------------------------------
// The file tree
// ---------------------------------------------------------------------------

/**
 * Whether a file counts as viewed at the SHA being reviewed.
 *
 * The mark carries the SHA it was made at, so a push un-views whatever changed. A mark with no SHA
 * comes from a session written before that field existed and is trusted as-is.
 *
 * @param {string} path
 */
function isViewed(path) {
  const mark = /** @type {any} */ (state.viewed)[path];
  return Boolean(mark) && (!mark.atSha || mark.atSha === state.pr.headSha);
}

/** The file list the tree and the filter work on, with the live viewed flag folded in. */
function fileEntries() {
  return state.files.map((/** @type {any} */ file) => ({ ...file, viewed: isViewed(file.path) }));
}

let treeQuery = "";

function renderTree() {
  const host = el("prcTreeBody");
  if (!host) return;
  const all = fileEntries();
  const shown = filterFiles(all, treeQuery);
  host.textContent = "";
  if (shown.length === 0) {
    const empty = document.createElement("p");
    empty.className = "prc-tree-empty";
    empty.textContent = "No file matches that filter.";
    host.append(empty);
  } else if (treeQuery.trim()) {
    // A filtered list is a search result, so it stays flat and ranked rather than being re-nested —
    // re-imposing the hierarchy would bury the best match under its directories.
    const list = document.createElement("div");
    list.className = "prc-tree-flat";
    for (const entry of shown) list.append(treeFileRow(entry, entry.path));
    host.append(list);
  } else {
    for (const node of buildFileTree(shown)) host.append(treeNodeElement(node));
  }

  const progress = el("prcTreeProgress");
  if (progress) {
    const { viewed, total } = reviewProgress(all);
    progress.textContent = `${viewed} of ${total} file${total === 1 ? "" : "s"} viewed`;
  }
}

const SVG_NS = "http://www.w3.org/2000/svg";

/** Shared stroke attributes, so every glyph on the page reads as one weight. */
const STROKE = {
  fill: "none",
  stroke: "currentColor",
  "stroke-width": "1.5",
  "stroke-linecap": "round",
  "stroke-linejoin": "round",
};

/** @type {[string, Record<string, string>]} */
const FILE_BOX = ["rect", { x: "2.5", y: "2.5", width: "11", height: "11", rx: "2", ...STROKE }];

/**
 * The page's icons, drawn here rather than imported.
 *
 * An icon font or a sprite sheet would be another asset for the allowlist to serve and the CSP to
 * permit, for nine glyphs. These are paths on a 16-unit grid that inherit `currentColor`, so what a
 * status looks like stays a CSS decision instead of being baked into the shape.
 *
 * @type {Record<string, Array<[string, Record<string, string>]>>}
 */
const ICONS = {
  // Drawn pointing down. The collapsed state rotates it a quarter turn, so one glyph covers both
  // and there is no second path to keep in agreement with the first.
  chevron: [["path", { d: "M4 6.5 8 10.5 12 6.5", ...STROKE }]],
  folder: [
    [
      "path",
      {
        d: "M2 12.75V4.5a.5.5 0 0 1 .5-.5h3.2l1.5 1.75h6.3a.5.5 0 0 1 .5.5v6.5a.5.5 0 0 1-.5.5h-11a.5.5 0 0 1-.5-.5Z",
        ...STROKE,
      },
    ],
  ],
  fileAdded: [FILE_BOX, ["path", { d: "M8 5.75v4.5", ...STROKE }], ["path", { d: "M5.75 8h4.5", ...STROKE }]],
  fileRemoved: [FILE_BOX, ["path", { d: "M5.75 8h4.5", ...STROKE }]],
  fileRenamed: [FILE_BOX, ["path", { d: "M5.5 8h4.5", ...STROKE }], ["path", { d: "M8.5 6 10.5 8 8.5 10", ...STROKE }]],
  fileModified: [FILE_BOX, ["circle", { cx: "8", cy: "8", r: "1.75", fill: "currentColor" }]],
  // The three theme states. `system` is a half-filled disc rather than a third symbol, because what
  // it means is "either of the other two, whichever the OS says".
  themeSystem: [
    ["circle", { cx: "8", cy: "8", r: "5.25", ...STROKE }],
    ["path", { d: "M8 2.75a5.25 5.25 0 0 0 0 10.5Z", fill: "currentColor" }],
  ],
  themeLight: [
    ["circle", { cx: "8", cy: "8", r: "3", ...STROKE }],
    ["path", { d: "M8 1.5v1.25M8 13.25v1.25M1.5 8h1.25M13.25 8h1.25", ...STROKE }],
    ["path", { d: "M3.4 3.4l.9.9M11.7 11.7l.9.9M12.6 3.4l-.9.9M4.3 11.7l-.9.9", ...STROKE }],
  ],
  themeDark: [["path", { d: "M13 9.6A5.5 5.5 0 0 1 6.4 3a5.75 5.75 0 1 0 6.6 6.6Z", ...STROKE }]],
};

/**
 * @param {string} name a key of {@link ICONS}
 * @param {string} className
 * @returns {SVGElement}
 */
function svgIcon(name, className) {
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("viewBox", "0 0 16 16");
  // Decoration: the row's own text already names the file and its status is in the +/− counts.
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("focusable", "false");
  svg.setAttribute("class", className);
  for (const [tag, attrs] of ICONS[name] ?? []) {
    const shape = document.createElementNS(SVG_NS, tag);
    for (const [attr, value] of Object.entries(attrs)) shape.setAttribute(attr, value);
    svg.append(shape);
  }
  return svg;
}

/**
 * GitHub's file vocabulary reduced to the four glyphs worth drawing: `copied` reads as a rename and
 * `changed`/`unchanged` read as a modification, because the distinctions do not survive a 16px box.
 *
 * @param {string} status
 * @returns {string}
 */
function iconForStatus(status) {
  if (status === "added") return "fileAdded";
  if (status === "removed") return "fileRemoved";
  if (status === "renamed" || status === "copied") return "fileRenamed";
  return "fileModified";
}

/**
 * @param {any} node
 * @returns {HTMLElement}
 */
function treeNodeElement(node) {
  if (node.kind === "file") return treeFileRow(node.entry, node.name);
  const wrap = document.createElement("div");
  wrap.className = "prc-tree-dir";
  const head = document.createElement("button");
  head.type = "button";
  head.className = "prc-tree-dirname";
  head.setAttribute("data-act", "tree-dir");
  head.setAttribute("aria-expanded", "true");
  const caret = svgIcon("chevron", "prc-tree-caret");
  const folder = svgIcon("folder", "prc-tree-icon");
  const label = document.createElement("span");
  label.className = "prc-tree-label";
  label.textContent = node.name;
  const count = document.createElement("span");
  count.className = "prc-tree-count";
  count.textContent = `${node.totals.viewed}/${node.totals.files}`;
  head.append(caret, folder, label, count);
  const children = document.createElement("div");
  children.className = "prc-tree-children";
  for (const child of node.children) children.append(treeNodeElement(child));
  wrap.append(head, children);
  return wrap;
}

/**
 * @param {any} entry
 * @param {string} label
 * @returns {HTMLElement}
 */
function treeFileRow(entry, label) {
  const row = document.createElement("button");
  row.type = "button";
  row.className = "prc-tree-file";
  row.setAttribute("data-act", "tree-file");
  row.setAttribute("data-file-index", String(entry.index));
  if (entry.viewed) row.dataset.viewed = "1";
  if (entry.degraded || entry.patchAvailability !== "present") row.dataset.unavailable = "1";
  const glyph = svgIcon(iconForStatus(String(entry.status)), "prc-tree-icon");
  glyph.setAttribute("data-status", String(entry.status));
  const name = document.createElement("span");
  name.className = "prc-tree-label";
  name.textContent = label;
  name.title = entry.path;
  const stat = document.createElement("span");
  stat.className = "prc-tree-stat";
  stat.textContent = `+${entry.additions} −${entry.deletions}`;
  const marks = document.createElement("span");
  marks.className = "prc-tree-marks";
  const drafts = state.comments.filter(
    (/** @type {any} */ comment) => comment.anchor?.path === entry.path && comment.state === "draft",
  ).length;
  const questions = state.threads.filter(
    (/** @type {any} */ thread) => thread.anchor?.path === entry.path && thread.status === "open",
  ).length;
  if (drafts > 0) marks.append(chip(String(drafts), "prc-chip-draft"));
  if (questions > 0) marks.append(chip("?", "prc-chip-question"));
  if (entry.viewed) marks.append(chip("✓", "prc-chip-viewed"));
  row.append(glyph, name, stat, marks);
  return row;
}

/**
 * Publish the real height of the sticky chrome as `--prc-chrome-h`.
 *
 * Every offset below the header depends on this: where a file header sticks, where the tree sticks, and
 * how far a scrolled-to file or row has to clear. CSS cannot know the value — the header carries the
 * pull request's title, whose length is not knowable in advance — so it was hardcoded at 52px, and a
 * title long enough to wrap made the header taller than that. The file headers then stuck *underneath*
 * it, hiding the first rows of every table: the hunk header and the expand band.
 *
 * Measured on load, on resize, and whenever the header's own box changes.
 */
function syncChromeHeight() {
  const header = document.querySelector(".prc-header");
  const toolbar = document.querySelector(".prc-toolbar");
  if (!header) return;
  const headerHeight = Math.round(header.getBoundingClientRect().height);
  const toolbarHeight = toolbar ? Math.round(toolbar.getBoundingClientRect().height) : 0;
  const root = document.documentElement;
  // The review bar is fixed to the bottom, so it covers whatever the sticky columns extend under.
  // That is how the chat's Send button ended up behind it: the panel was sized against the full
  // viewport height, and the last thing in it was the button. Measured for the same reason as the
  // header — the bar wraps on a narrow window.
  const footer = document.querySelector(".prc-reviewbar");
  const footerHeight = footer ? Math.round(footer.getBoundingClientRect().height) : 0;
  if (footerHeight > 0) root.style.setProperty("--prc-footer-h", `${footerHeight}px`);

  // Where the sticky columns actually begin, which is *not* their sticky offset. Before the page is
  // scrolled they sit at their static position — below any banner that happens to be showing — so a
  // height computed from the sticky offset is too tall by however far down the page pushed them, and
  // the bottom of the column disappears behind the review bar. That is the whole bug: the top offset
  // was right and the height was measured from the wrong end.
  const layout = document.querySelector(".prc-layout");
  if (layout) {
    const asideTop = Math.round(layout.getBoundingClientRect().top + window.scrollY);
    if (asideTop > 0) root.style.setProperty("--prc-aside-top", `${asideTop}px`);
  }
  // Two offsets, because two things stick: the toolbar sits under the header, and everything below
  // both — file headers, the tree, the chat panel, every scroll-margin — sits under the pair. One
  // combined number would put a file header behind the toolbar, which is the bug the measured
  // approach exists to prevent in the first place.
  if (headerHeight > 0) root.style.setProperty("--prc-toolbar-top", `${headerHeight}px`);
  if (headerHeight + toolbarHeight > 0) root.style.setProperty("--prc-chrome-h", `${headerHeight + toolbarHeight}px`);
}

function watchChromeHeight() {
  syncChromeHeight();
  window.addEventListener("resize", syncChromeHeight);
  // A ResizeObserver catches what resize does not: fonts finishing loading, a banner appearing, the
  // presence indicator changing width and re-wrapping the row.
  if (typeof ResizeObserver === "function") {
    const observer = new ResizeObserver(syncChromeHeight);
    for (const node of [
      document.querySelector(".prc-header"),
      document.querySelector(".prc-toolbar"),
      // The bar grows when a draft count appears in it, and that changes how much of the viewport the
      // sticky columns may use.
      document.querySelector(".prc-reviewbar"),
      // The body, because a banner appearing or going away moves where the columns start without
      // changing the size of anything the observers above are watching.
      document.body,
    ]) {
      if (node) observer.observe(node);
    }
  }
}

/** @param {boolean} [force] */
function toggleTree(force) {
  const layout = document.querySelector(".prc-layout");
  const button = el("prcToggleTree");
  if (!layout) return;
  const open = force ?? layout.getAttribute("data-tree") !== "open";
  layout.setAttribute("data-tree", open ? "open" : "closed");
  button?.setAttribute("aria-expanded", open ? "true" : "false");
}

/** @param {number} fileIndex */
function revealFile(fileIndex) {
  const section = el(`F${fileIndex}`);
  if (!section) return;
  if (section.dataset.collapsed === "1") setFolded(fileIndex, false);
  mountFile(fileIndex);
  section.scrollIntoView({ block: "start" });
}

// ---------------------------------------------------------------------------
// Folding and layout
// ---------------------------------------------------------------------------

/** @param {number} fileIndex @param {boolean} folded */
function setFolded(fileIndex, folded) {
  const section = el(`F${fileIndex}`);
  if (!section) return;
  section.dataset.collapsed = folded ? "1" : "0";
  section.querySelector("[data-act='fold-file']")?.setAttribute("aria-expanded", folded ? "false" : "true");
}

/**
 * Switch between unified and split.
 *
 * Every mounted file is thrown away and re-fetched in the new layout, which is the one operation in
 * this client that destroys DOM the user might be typing into — so it refuses to run while anything
 * is dirty. Silently discarding a half-written comment to satisfy a layout preference would be the
 * worst trade in the application.
 *
 * Anchors themselves survive for free: `data-lk` is mode-independent, so a comment on line 42 is on
 * line 42 in both layouts without anything being recomputed.
 *
 * @param {"unified" | "split"} layout
 */
async function setLayout(layout) {
  if (layout === state.layout) return;
  if (hasUnsavedText()) {
    toast("Save or cancel what you are writing before switching layout.");
    return;
  }
  state.layout = layout;
  for (const button of document.querySelectorAll("[data-act='layout']")) {
    button.setAttribute("aria-pressed", button.getAttribute("data-layout") === layout ? "true" : "false");
  }
  request("/prefs", { method: "PUT", body: JSON.stringify({ prefs: { layout } }) }).catch(() => {
    // A preference that did not persist is not worth interrupting the review for.
  });

  const cursorBefore = state.cursor;
  for (const section of document.querySelectorAll(".prc-file")) {
    const host = section.querySelector(".prc-file-body");
    if (!host || !(/** @type {HTMLElement} */ (section).dataset.state?.match(/rendered|loading/))) continue;
    host.innerHTML = "";
    /** @type {HTMLElement} */ (section).dataset.state = "pending";
  }
  for (const file of state.files) {
    if (el(`F${file.index}`)?.getAttribute("data-collapsed") === "1") continue;
    await mountFile(file.index);
  }
  if (cursorBefore) setCursor(cursorBefore, { scroll: false });
}

/**
 * One markdown body, with its diagrams.
 *
 * Every place a body is rendered goes through here — a chat message, a question, a reply, a draft — so
 * a ```mermaid fence means the same thing everywhere rather than in whichever surface remembered to
 * ask. The fragment comes back synchronously with the fence still a code block; the picture replaces it
 * when the renderer has loaded, which is a fetch this page may never make.
 *
 * @param {string} text
 * @returns {DocumentFragment}
 */
function renderBody(text) {
  const fragment = renderMarkdown(document, text);
  upgradeDiagrams(fragment);
  return fragment;
}

// ---------------------------------------------------------------------------
// Theme
// ---------------------------------------------------------------------------

/** In the order the button cycles them. The server's `sanitizePrefs` allows exactly these three. */
const THEMES = ["system", "light", "dark"];

/** @type {Record<string, {label: string, icon: string}>} */
const THEME_FACES = {
  system: { label: "Auto", icon: "themeSystem" },
  light: { label: "Light", icon: "themeLight" },
  dark: { label: "Dark", icon: "themeDark" },
};

/**
 * The theme in force, as the page was served.
 *
 * Read off the button rather than off `state.prefs`, because the server has already resolved an
 * unknown or absent preference into one of the three and stamped the result on `<html>`. Taking it
 * from the same place the attribute came from keeps the first click a step rather than a correction.
 */
function currentTheme() {
  const choice = el("prcTheme")?.getAttribute("data-theme-choice") ?? "system";
  return THEMES.includes(choice) ? choice : "system";
}

/**
 * Put a theme on the page.
 *
 * `system` is the *absence* of `data-theme`: the `prefers-color-scheme` block in the stylesheet is
 * what handles that case, so leaving an attribute behind — even an empty one — would be a third
 * state the CSS does not describe.
 *
 * @param {string} theme
 * @returns {string} the choice actually applied
 */
function applyTheme(theme) {
  const choice = THEMES.includes(theme) ? theme : "system";
  const face = THEME_FACES[choice];
  if (choice === "system") document.documentElement.removeAttribute("data-theme");
  else document.documentElement.setAttribute("data-theme", choice);

  const button = el("prcTheme");
  if (button) {
    button.setAttribute("data-theme-choice", choice);
    button.setAttribute("title", `Theme: ${face.label.toLowerCase()} — click to change`);
    button.setAttribute("aria-label", `Theme: ${face.label.toLowerCase()}`);
    button.textContent = "";
    const label = document.createElement("span");
    label.className = "prc-theme-label";
    label.textContent = face.label;
    button.append(svgIcon(face.icon, "prc-theme-icon"), label);
  }
  return choice;
}

/**
 * Apply a theme *and* remember it. Separate from {@link applyTheme} because the page applies one on
 * every load, and a PUT there would write a preference nobody changed into the journal each time.
 *
 * @param {string} theme
 */
function setTheme(theme) {
  const choice = applyTheme(theme);
  state.prefs = { ...state.prefs, theme: choice };
  request("/prefs", { method: "PUT", body: JSON.stringify({ prefs: { theme: choice } }) }).catch(() => {
    // A preference that did not persist is not worth interrupting the review for.
  });
}

/** Whether any composer or reply box holds text the server has not seen. */
function hasUnsavedText() {
  for (const area of document.querySelectorAll(".prc-composer textarea, .prc-reply textarea")) {
    if (/** @type {HTMLTextAreaElement} */ (area).value.trim()) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Expand context
// ---------------------------------------------------------------------------

/** @param {number} fileIndex @param {number} hunkIndex */
const expansionKey = (fileIndex, hunkIndex) => `${fileIndex}:${hunkIndex}`;

/**
 * Reveal more of the file around a hunk.
 *
 * @param {Element} button
 */
async function expandContext(button) {
  const section = button.closest(".prc-file");
  const fileIndex = Number(/** @type {HTMLElement} */ (section)?.dataset.fileIndex);
  const hunkIndex = Number(button.getAttribute("data-hunk-index"));
  const direction = button.getAttribute("data-direction") === "before" ? "before" : "after";
  // The row the button sits in: the hunk header for `before`, the hunk's own footer row for `after`.
  const controlRow = button.closest("tr.prc-hunk");
  if (!Number.isFinite(fileIndex) || !controlRow) return;

  const record = state.expansions.get(expansionKey(fileIndex, hunkIndex)) ?? {};
  /** @type {HTMLButtonElement} */ (button).disabled = true;
  try {
    const result = await request("/expand", {
      method: "POST",
      body: JSON.stringify({
        fileIndex,
        hunkIndex,
        direction,
        layout: state.layout,
        cursorNew: record[direction] ?? null,
      }),
    });
    if (result.rows) {
      // Trusted markup, and the trust is specific rather than assumed. These rows come from our own
      // origin, built by `rowsHtml` — the same function the server renders the initial table with —
      // and every byte of file content in them has been through `escapeHtml`, which
      // diff-rows.test.js asserts directly with an `<img onerror>` payload. Parsing HTML here cannot
      // run a `<script>` (the HTML spec forbids it for this insertion path) and the page's CSP
      // allows no inline script in any case.
      //
      // The alternative — rebuilding rows with DOM calls in the client — would mean a second row
      // renderer that can drift from the server's, which is the single most likely cause of a
      // comment landing on the wrong line. That trade is not worth making.
      // Both directions insert next to the button that was clicked: below it going up, above it going
      // down. That is only possible because the downward control has its own row at the end of the
      // hunk — with both arrows in the header, expanding down put rows hundreds of lines away.
      if (direction === "before") controlRow.insertAdjacentHTML("afterend", result.rows);
      else controlRow.insertAdjacentHTML("beforebegin", result.rows);
      record[direction] = direction === "before" ? result.firstNew : result.lastNew;
      state.expansions.set(expansionKey(fileIndex, hunkIndex), record);
      // New rows joined the hunk's block, so the whole file is coloured again from scratch. Cheaper
      // than it looks — the grammar is already parsed and the work happens off the main thread.
      const table = document.querySelector(`table.prc-diff[data-file-index="${fileIndex}"]`);
      if (table) delete (/** @type {HTMLElement} */ (table).dataset.highlighted);
      highlightFile(fileIndex);
    }
    if (result.exhausted || !result.rows) {
      button.remove();
      if (!result.rows) toast("There is nothing more to show there.");
    }
  } catch (error) {
    toast(`Could not expand context: ${error instanceof Error ? error.message : error}`);
  } finally {
    /** @type {HTMLButtonElement} */ (button).disabled = false;
  }
}

/**
 * Re-apply this file's expansions after it was remounted.
 *
 * @param {number} fileIndex
 */
async function replayExpansions(fileIndex) {
  for (const [key, record] of state.expansions) {
    const [index, hunkIndex] = key.split(":").map(Number);
    if (index !== fileIndex) continue;
    for (const direction of /** @type {Array<"before" | "after">} */ (["before", "after"])) {
      const target = record[direction];
      if (target == null) continue;
      const button = document.querySelector(
        `#F${fileIndex} tr.prc-hunk[data-hunk-index="${hunkIndex}"] [data-direction="${direction}"]`,
      );
      // Replayed by walking the same route the click uses, one chunk at a time, so the rows land in
      // the same places. The blob is cached server-side, so this costs no GitHub requests.
      let guard = 0;
      while (
        button &&
        guard < 50 &&
        (direction === "before"
          ? (state.expansions.get(key)?.before ?? Number.POSITIVE_INFINITY) > target
          : (state.expansions.get(key)?.after ?? -1) < target)
      ) {
        guard += 1;
        const before = JSON.stringify(state.expansions.get(key));
        await expandContext(button);
        if (JSON.stringify(state.expansions.get(key)) === before) break;
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Permalinks
// ---------------------------------------------------------------------------

/**
 * The repository, in the shape `shared/permalink.js` wants.
 *
 * Taken from the bootstrap rather than parsed out of the display ref: an Enterprise host is not
 * recoverable from `owner/repo#1`, and defaulting it to github.com would produce links that look
 * right and point at the wrong server.
 */
function repoRef() {
  return { host: state.pr.host, owner: state.pr.owner, repo: state.pr.repo };
}

/**
 * Two links per location, because they answer different questions: the blob link is durable and
 * shows the file, the files-view link shows the review context around it. Copying both, one per
 * line, means the user pastes whichever one they meant.
 *
 * @param {string} lk
 * @returns {string | null}
 */
function permalinksFor(lk) {
  const parsed = parseLineKey(lk);
  if (!parsed) return null;
  const file = state.files.find((/** @type {any} */ candidate) => candidate.index === parsed.fileIndex);
  if (!file) return null;
  const anchor = state.anchor;
  const ranged = anchor && anchor.fileIndex === parsed.fileIndex && anchor.startLine != null;
  const side = parsed.kind === "del" ? "LEFT" : "RIGHT";
  const line = side === "LEFT" ? parsed.oldLine : parsed.newLine;
  if (line == null) return null;
  const startLine = ranged ? anchor.startLine : undefined;
  const blob = blobLinkFor({
    ref: repoRef(),
    headSha: state.pr.headSha,
    baseSha: state.pr.baseSha,
    file,
    side,
    line,
    startLine,
  });
  const review = filesViewPermalink({
    ref: repoRef(),
    number: Number(state.pr.number),
    sha: state.pr.headSha,
    anchorId: file.anchorId,
    side,
    line,
    startLine,
  });
  return `${blob}\n${review}`;
}

/** @param {string} text @param {string} note */
function copyText(text, note) {
  navigator.clipboard
    ?.writeText(text)
    .then(() => toast(note))
    .catch(() => toast("Could not reach the clipboard."));
}

// ---------------------------------------------------------------------------
// Syntax highlighting
// ---------------------------------------------------------------------------

/** @type {Worker | null} */
let highlighter = null;
let highlightSeq = 0;
/** @type {Map<number, (result: { lines: string[], highlighted: boolean }) => void>} */
const highlightWaiters = new Map();

/**
 * The worker, created on first use.
 *
 * A failure to create it is not reported: the diff is completely readable without colour, and a
 * toast about a Worker constructor would be noise in the middle of a review.
 */
function highlightWorker() {
  if (highlighter !== null) return highlighter;
  try {
    highlighter = new Worker("/assets/prc-hl-worker.js");
    highlighter.addEventListener("message", (event) => {
      const data = /** @type {any} */ (event).data ?? {};
      const waiter = highlightWaiters.get(data.id);
      if (!waiter) return;
      highlightWaiters.delete(data.id);
      waiter({ lines: data.lines ?? [], highlighted: data.highlighted === true });
    });
    highlighter.addEventListener("error", () => {
      for (const waiter of highlightWaiters.values()) waiter({ lines: [], highlighted: false });
      highlightWaiters.clear();
    });
  } catch {
    highlighter = null;
  }
  return highlighter;
}

/**
 * @param {string} code
 * @param {string} path
 * @returns {Promise<{ lines: string[], highlighted: boolean }>}
 */
function highlight(code, path) {
  const worker = highlightWorker();
  if (!worker) return Promise.resolve({ lines: [], highlighted: false });
  const id = (highlightSeq += 1);
  return new Promise((resolve) => {
    highlightWaiters.set(id, resolve);
    worker.postMessage({ id, code, path, language: languageForPath(path) });
  });
}

/**
 * Colour one file's rows.
 *
 * Highlighting runs **per hunk and per side**, never per row. A row on its own cannot be highlighted
 * correctly: a template literal, a block comment or a heredoc spans lines, and a highlighter shown
 * one line has no way to know it is inside one. So each hunk's new-side text is reassembled, coloured
 * as one block, and split back into lines by the worker.
 *
 * Per hunk rather than per file, because concatenating code across a hunk gap would splice together
 * lines that are not adjacent in the real file — which can open a construct that never closes and
 * mis-colour everything after it. Confining that risk to one hunk is the best available answer; there
 * is no way to be exactly right without the whole file, and expanding context is how a reader gets
 * that when it matters.
 *
 * @param {number} fileIndex
 */
async function highlightFile(fileIndex) {
  if (state.prefs.highlight === false) return;
  const file = state.files.find((/** @type {any} */ candidate) => candidate.index === fileIndex);
  const table = document.querySelector(`table.prc-diff[data-file-index="${fileIndex}"]`);
  if (!file || !table || !languageForPath(file.path)) return;
  if (/** @type {HTMLElement} */ (table).dataset.highlighted === "1") return;
  /** @type {HTMLElement} */ (table).dataset.highlighted = "1";

  for (const block of highlightBlocks(table)) {
    const result = await highlight(block.cells.map((cell) => textOfCell(cell)).join("\n"), file.path);
    if (!result.highlighted || result.lines.length !== block.cells.length) continue;
    for (const [index, cell] of block.cells.entries()) {
      const inner = cell.querySelector(".prc-code-inner");
      // Trusted for the same reasons as the expanded rows, plus one more that is specific to here:
      // the worker's output is asserted to contain exactly the original characters (hl-split.test.js
      // checks that per line), so this cannot change what the code says — only how it is wrapped.
      if (inner) inner.innerHTML = result.lines[index];
    }
  }
}

/**
 * Group a table's code cells into the blocks that must be highlighted together: one per hunk, per
 * side. A mirrored cell is skipped — it is a second view of a line that is coloured on its own side.
 *
 * @param {Element} table
 */
function highlightBlocks(table) {
  /** @type {Array<{ cells: Element[] }>} */
  const blocks = [];
  /** @type {Map<string, Element[]>} */
  let current = new Map();
  const flush = () => {
    for (const cells of current.values()) if (cells.length > 0) blocks.push({ cells });
    current = new Map();
  };
  for (const row of table.querySelectorAll("tr")) {
    if (row.classList.contains("prc-hunk")) {
      flush();
      continue;
    }
    if (!row.classList.contains("prc-line")) continue;
    for (const cell of row.querySelectorAll("td.prc-code")) {
      if (cell.getAttribute("data-mirror") === "1" || !cell.querySelector(".prc-code-inner")) continue;
      // A deletion belongs to the old side's text, everything else to the new side's.
      const side = cell.classList.contains("prc-code-del") ? "old" : "new";
      const list = current.get(side) ?? [];
      list.push(cell);
      current.set(side, list);
    }
  }
  flush();
  return blocks;
}

/**
 * The source text of a cell, read back from the DOM.
 *
 * `textContent` of the inner span and nothing else: the marker and the screen-reader prefix are
 * siblings, and including either would shift every column by a character.
 *
 * @param {Element} cell
 */
function textOfCell(cell) {
  return cell.querySelector(".prc-code-inner")?.textContent ?? "";
}

// ---------------------------------------------------------------------------
// Keyboard navigation
// ---------------------------------------------------------------------------

/** Elements that own their own keystrokes. */
const isTypingTarget = (/** @type {Element | null} */ element) =>
  Boolean(element?.closest?.("input, textarea, select, [contenteditable]:not([contenteditable='false'])"));

/** Every addressable code cell currently on screen, in document order. */
function navigableCells() {
  return [...document.querySelectorAll("td.prc-code[data-lk]")].filter((cell) => {
    const section = cell.closest(".prc-file");
    return !section || /** @type {HTMLElement} */ (section).dataset.collapsed !== "1";
  });
}

/**
 * @param {string | null} lk
 * @param {{ scroll?: boolean }} [options]
 */
function setCursor(lk, options = {}) {
  for (const previous of document.querySelectorAll(".prc-cursor")) previous.classList.remove("prc-cursor");
  state.cursor = lk;
  if (!lk) return;
  const cell = document.querySelector(`td.prc-code[data-lk="${cssEscape(lk)}"]`);
  if (!cell) return;
  cell.closest("tr")?.classList.add("prc-cursor");
  if (options.scroll !== false) cell.scrollIntoView({ block: "nearest" });
}

/** @param {number} step */
function moveCursor(step) {
  const cells = navigableCells();
  if (cells.length === 0) return;
  const current = state.cursor ? cells.findIndex((cell) => cell.getAttribute("data-lk") === state.cursor) : -1;
  const next =
    current < 0 ? (step > 0 ? 0 : cells.length - 1) : Math.min(cells.length - 1, Math.max(0, current + step));
  setCursor(cells[next].getAttribute("data-lk"));
}

/** @param {number} step */
function moveFile(step) {
  const indices = state.files.map((/** @type {any} */ file) => file.index);
  const currentIndex = cursorFileIndex();
  const at = indices.indexOf(currentIndex);
  const next =
    at < 0 ? (step > 0 ? indices[0] : indices.at(-1)) : indices[Math.min(indices.length - 1, Math.max(0, at + step))];
  if (next == null) return;
  revealFile(next);
  const first = document.querySelector(`#F${next} td.prc-code[data-lk]`);
  setCursor(first?.getAttribute("data-lk") ?? null, { scroll: false });
}

/** @param {number} step */
function moveHunk(step) {
  const headers = [...document.querySelectorAll("tr.prc-hunk")];
  if (headers.length === 0) return;
  const cursorRow = document.querySelector(".prc-cursor");
  const position = cursorRow ? headers.findIndex((header) => header.compareDocumentPosition(cursorRow) & 4) : -1;
  // `4` is DOCUMENT_POSITION_FOLLOWING: the first header that comes after the cursor.
  const target =
    step > 0
      ? headers[position < 0 ? 0 : position]
      : headers[Math.max(0, (position < 0 ? headers.length : position) - 2)];
  const cell = target?.parentElement ? nextKeyedCellAfter(target) : null;
  if (cell) setCursor(cell.getAttribute("data-lk"));
  else target?.scrollIntoView({ block: "center" });
}

/** @param {Element} row */
function nextKeyedCellAfter(row) {
  let candidate = row.nextElementSibling;
  while (candidate) {
    const cell = candidate.querySelector("td.prc-code[data-lk]");
    if (cell) return cell;
    candidate = candidate.nextElementSibling;
  }
  return null;
}

function cursorFileIndex() {
  const cell = state.cursor ? document.querySelector(`td.prc-code[data-lk="${cssEscape(state.cursor)}"]`) : null;
  const section = cell?.closest(".prc-file") ?? document.querySelector(".prc-file");
  return Number(/** @type {HTMLElement} */ (section)?.dataset.fileIndex ?? 0);
}

/**
 * Open the composer on the cursor line.
 *
 * A cell with no `data-side` is outside the diff — expanded context. Asking about it is useful and
 * allowed; commenting on it is a guaranteed 422, so only the question mode is offered there.
 *
 * @param {"comment" | "ask"} mode
 */
function composeAtCursor(mode) {
  const cell = state.cursor ? document.querySelector(`td.prc-code[data-lk="${cssEscape(state.cursor)}"]`) : null;
  if (!cell) return;
  const anchor = anchorFromCell(cell) ?? questionAnchorFromCell(cell);
  if (!anchor) return;
  if (mode === "comment" && !cell.getAttribute("data-side")) {
    toast("That line is not part of the diff, so GitHub cannot take a comment on it. You can still ask about it.");
    return;
  }
  state.anchor = anchor;
  openComposer(mode);
}

/**
 * The anchor for a line that cannot be commented on.
 *
 * Deliberately separate from `anchorFromCell`: that function's null answer is what stops a comment
 * being offered, and widening it would let a 422 through. This one exists only for questions, which
 * the server accepts for any real line via `anchorForQuestion`.
 *
 * @param {Element} cell
 */
function questionAnchorFromCell(cell) {
  const parsed = parseLineKey(cell.getAttribute("data-lk") ?? "");
  if (!parsed) return null;
  const line = parsed.newLine ?? parsed.oldLine;
  if (line == null) return null;
  return { fileIndex: parsed.fileIndex, side: parsed.newLine != null ? "RIGHT" : "LEFT", line };
}

/** @param {KeyboardEvent} event */
function onKeyDown(event) {
  if (event.defaultPrevented) return;
  if (event.key === "Escape") {
    escapeLadder(event);
    return;
  }
  if (event.metaKey || event.ctrlKey || event.altKey) return;
  const target = /** @type {Element | null} */ (event.target);
  if (isTypingTarget(target)) return;

  // Shift+J/K grows the selection from the keyboard, so a range is reachable without a mouse at all.
  if (event.shiftKey && (event.key === "J" || event.key === "K")) {
    event.preventDefault();
    extendSelection(event.key === "J" ? 1 : -1);
    return;
  }

  /** @type {Record<string, () => void>} */
  const bindings = {
    j: () => moveCursor(1),
    k: () => moveCursor(-1),
    n: () => moveFile(1),
    p: () => moveFile(-1),
    "]": () => moveHunk(1),
    "[": () => moveHunk(-1),
    c: () => composeAtCursor("comment"),
    a: () => composeAtCursor("ask"),
    v: () => toggleViewedForFile(cursorFileIndex()),
    t: () => focusFilter(),
    g: () => toggleChat(),
    d: () => stepDraft(1),
    D: () => stepDraft(-1),
    y: () => {
      const links = state.cursor ? permalinksFor(state.cursor) : null;
      if (links) copyText(links, "Permalinks copied — blob first, review context second.");
    },
    "?": () => /** @type {HTMLDialogElement | null} */ (el("prcShortcutsDialog"))?.showModal(),
  };
  const action = bindings[event.key];
  if (!action) return;
  event.preventDefault();
  action();
}

/**
 * Escape closes the innermost thing that is open, one level per press.
 *
 * Explicitly ordered rather than left to whichever listener happens to run first: with a dialog, a
 * composer, a reply box, a filter and a cursor all potentially live, "one press, one effect" is only
 * true if something decides the order.
 *
 * @param {KeyboardEvent} event
 */
function escapeLadder(event) {
  const dialog = /** @type {HTMLDialogElement | null} */ (document.querySelector("dialog[open]"));
  if (dialog) {
    event.preventDefault();
    dialog.close();
    return;
  }
  const reply = [...document.querySelectorAll(".prc-reply")].at(-1);
  if (reply) {
    event.preventDefault();
    reply.remove();
    return;
  }
  if (document.querySelector(".prc-composer")) {
    event.preventDefault();
    closeComposer();
    return;
  }
  // Above the filter and the selection: the panel is something the user opened deliberately and has
  // focus inside, so it is the innermost thing still open.
  if (state.chatOpen && el("prcChat")?.contains(document.activeElement)) {
    event.preventDefault();
    toggleChat(false);
    return;
  }
  const filter = /** @type {HTMLInputElement | null} */ (el("prcTreeFilter"));
  if (filter && (document.activeElement === filter || filter.value)) {
    event.preventDefault();
    filter.value = "";
    treeQuery = "";
    renderTree();
    filter.blur();
    return;
  }
  if (state.anchor) {
    event.preventDefault();
    state.anchor = null;
    paintSelection(null);
    return;
  }
  if (state.cursor) {
    event.preventDefault();
    setCursor(null);
  }
}

/**
 * Grow or shrink the selection by one line from the keyboard.
 *
 * Anchored on the cursor's line the first time, then on whichever end the selection started from, so
 * repeated presses extend rather than flip-flopping.
 *
 * @param {number} step
 */
function extendSelection(step) {
  const cell = state.cursor ? document.querySelector(`td.prc-code[data-lk="${cssEscape(state.cursor)}"]`) : null;
  const here = anchorFromCell(cell ?? null);
  if (!here || !cell) return;
  const section = cell.closest(".prc-file");
  const fileIndex = Number(/** @type {HTMLElement} */ (section)?.dataset.fileIndex);
  const previous =
    state.anchor && state.anchor.fileIndex === fileIndex && state.anchor.side === here.side ? state.anchor : null;
  const anchorLine = previous ? (previous.startLine ?? previous.line) : here.line;
  const targetLine = previous ? previous.line + step : here.line + step;
  const built = rangeAnchor(fileIndex, here.side, anchorLine, targetLine);
  if (!built) return;
  state.anchor = built.anchor;
  paintSelection(built.anchor);
  announce(describeRange(built.range, /** @type {any} */ (here.side)));
}

/**
 * Say something to a screen reader without disturbing the page.
 *
 * A selection that only exists as a colour is invisible to anyone using one, and the keyboard path is
 * exactly the path such a user takes.
 *
 * @param {string} message
 */
function announce(message) {
  const live = el("prcLive");
  if (live) live.textContent = message;
}

function focusFilter() {
  toggleTree(true);
  const filter = /** @type {HTMLInputElement | null} */ (el("prcTreeFilter"));
  filter?.focus();
  filter?.select();
}

/** @param {number} fileIndex */
function toggleViewedForFile(fileIndex) {
  const box = /** @type {HTMLInputElement | null} */ (el(`F${fileIndex}`)?.querySelector(".prc-viewed-box") ?? null);
  if (!box) return;
  box.checked = !box.checked;
  box.dispatchEvent(new Event("change", { bubbles: true }));
}

// ---------------------------------------------------------------------------
// Review bar and submit
// ---------------------------------------------------------------------------

function draftCount() {
  return state.comments.filter((/** @type {any} */ comment) => comment.state === "draft").length;
}

function renderReviewBar() {
  const count = draftCount();
  const queued = state.replies.filter((/** @type {any} */ reply) => reply.state === "draft").length;
  const summary = el("prcReviewBarSummary");
  if (summary) {
    const parts = [];
    if (count > 0) parts.push(`${count} drafted comment${count === 1 ? "" : "s"}`);
    if (queued > 0) parts.push(`${queued} queued repl${queued === 1 ? "y" : "ies"}`);
    summary.textContent = parts.length === 0 ? "No drafted comments" : parts.join(" · ");
  }
  const button = /** @type {HTMLButtonElement | null} */ (el("prcOpenSubmit"));
  if (button) {
    // Blocked while the agent is mid-work, mirroring lavish's presence gate: the agent is the one
    // that will perform the submit, so arming a second one would race it.
    button.disabled = state.submitting || state.presence === "working" || state.status === "ended";
  }
}

function openSubmitDialog() {
  const dialog = /** @type {HTMLDialogElement | null} */ (el("prcSubmitDialog"));
  if (!dialog) return;
  const count = draftCount();
  const countLabel = el("prcSubmitCount");
  if (countLabel) {
    countLabel.textContent =
      count === 0
        ? "No line comments — the summary alone will be posted."
        : `${count} line comment${count === 1 ? "" : "s"} will be posted.`;
  }
  const summary = /** @type {HTMLTextAreaElement | null} */ (el("prcSummary"));
  if (summary) summary.value = state.review.body ?? "";
  const note = el("prcSubmitNote");
  if (note) note.textContent = "";
  dialog.showModal();
}

async function confirmSubmit() {
  const dialog = /** @type {HTMLDialogElement | null} */ (el("prcSubmitDialog"));
  const summary = /** @type {HTMLTextAreaElement | null} */ (el("prcSummary"));
  const verdict = /** @type {HTMLInputElement | null} */ (document.querySelector("input[name='verdict']:checked"))
    ?.value;
  const note = el("prcSubmitNote");

  try {
    state.submitting = true;
    renderReviewBar();
    // This does NOT submit. It validates every comment against the diff and mints a one-shot
    // token; the agent performs the actual GitHub call. The click is the approval gate.
    const armed = await request("/submit/arm", {
      method: "POST",
      body: JSON.stringify({ verdict, body: summary?.value ?? "" }),
    });
    state.review = { verdict, body: summary?.value ?? "" };
    dialog?.close();
    showBanner(`Review armed — waiting for the agent to submit ${armed.comments} comment(s).`);
    appendBannerAction("Cancel", "cancel-arm");
    watchArmExpiry(armed.expiresAt);
  } catch (error) {
    state.submitting = false;
    renderReviewBar();
    const message = error instanceof Error ? error.message : String(error);
    if (note) note.textContent = message;
    // The dialog stays open and, when the complaint is about the summary, the caret goes there. A note
    // in small print under a form the user has just tried to submit is easy to miss entirely, and the
    // failure looks like the button not working.
    if (/summary/i.test(message)) summary?.focus();
  }
}

/** @type {ReturnType<typeof setTimeout> | null} */
let armTimer = null;

/**
 * Re-enable Submit if the arming expires unused.
 *
 * The raw token is handed to the agent exactly once and kept nowhere else, so an agent that polls
 * and then loses it — crash, parse failure, killed process — leaves the arming live but unusable.
 * Without this the Submit button stays disabled with a banner promising something that will never
 * happen, and the only way out is a page reload.
 *
 * @param {string | undefined} expiresAt
 */
function watchArmExpiry(expiresAt) {
  if (armTimer) clearTimeout(armTimer);
  const deadline = Date.parse(String(expiresAt ?? ""));
  if (!Number.isFinite(deadline)) return;
  armTimer = setTimeout(
    () => {
      armTimer = null;
      if (!state.submitting) return;
      state.submitting = false;
      renderReviewBar();
      showBanner(
        "The armed submission expired before the agent submitted it. Nothing was posted and your drafts are " +
          "intact — click Review changes to try again.",
      );
    },
    Math.max(1000, deadline - Date.now() + 1000),
  );
}

/** Stop waiting for an agent that is not coming. */
async function cancelArmedSubmit() {
  if (armTimer) clearTimeout(armTimer);
  armTimer = null;
  try {
    await request("/submit/cancel", { method: "POST" });
  } catch {
    // Already gone, or the server restarted: either way there is nothing left armed.
  }
  state.submitting = false;
  renderReviewBar();
  showBanner("Submission cancelled. Nothing was posted and your drafts are intact.");
}

// ---------------------------------------------------------------------------
// Viewed checkboxes
// ---------------------------------------------------------------------------

/** @param {Event} event */
async function onViewedChange(event) {
  const box = /** @type {HTMLInputElement} */ (event.target);
  if (!box.classList?.contains("prc-viewed-box")) return;
  const path = box.getAttribute("data-path") ?? "";
  const index = Number(/** @type {HTMLElement} */ (box.closest(".prc-file"))?.dataset.fileIndex);
  // Marked viewed folds the file away, the way GitHub does — the point of the tick is to stop
  // looking at it.
  if (box.checked) /** @type {any} */ (state.viewed)[path] = { at: new Date().toISOString(), atSha: state.pr.headSha };
  else delete (/** @type {any} */ (state.viewed)[path]);
  if (Number.isFinite(index)) setFolded(index, box.checked);
  renderTree();
  try {
    await request("/viewed", { method: "PUT", body: JSON.stringify({ path, viewed: box.checked }) });
  } catch (error) {
    box.checked = !box.checked;
    if (box.checked)
      /** @type {any} */ (state.viewed)[path] = { at: new Date().toISOString(), atSha: state.pr.headSha };
    else delete (/** @type {any} */ (state.viewed)[path]);
    if (Number.isFinite(index)) setFolded(index, box.checked);
    renderTree();
    toast(`Could not save Viewed: ${error instanceof Error ? error.message : error}`);
  }
}

// ---------------------------------------------------------------------------
// SSE
// ---------------------------------------------------------------------------

function connectEvents() {
  const events = new EventSource(`/events/${encodeURIComponent(state.accessId)}`);
  events.addEventListener("agent-presence", (event) => {
    setPresence(JSON.parse(/** @type {MessageEvent} */ (event).data).state);
  });
  events.addEventListener("submit-cancelled", () => {
    if (armTimer) clearTimeout(armTimer);
    armTimer = null;
    state.submitting = false;
    renderReviewBar();
  });
  events.addEventListener("review-result", (event) => {
    const data = JSON.parse(/** @type {MessageEvent} */ (event).data);
    if (armTimer) clearTimeout(armTimer);
    armTimer = null;
    state.submitting = false;
    for (const comment of /** @type {any[]} */ (state.comments)) {
      if ((data.commentIds ?? []).includes(comment.id)) comment.state = "submitted";
    }
    for (const posted of data.posted ?? []) {
      const reply = state.replies.find((/** @type {any} */ candidate) => candidate.id === posted.id);
      if (reply) Object.assign(reply, { state: "posted", url: posted.url ?? null });
    }
    for (const failure of data.failed ?? []) {
      const reply = state.replies.find((/** @type {any} */ candidate) => candidate.id === failure.id);
      if (reply) Object.assign(reply, { state: "failed", error: failure.error ?? "" });
    }
    renderAll();
    renderReviewBar();
    const failedCount = (data.failed ?? []).length;
    // Replies are separate POSTs, so a partial outcome is a real outcome and has to be said out loud
    // rather than folded into "submitted".
    const replyNote = failedCount
      ? ` ${failedCount} repl${failedCount === 1 ? "y" : "ies"} to existing threads failed; the rest are posted.`
      : "";
    showBanner(`Review submitted as ${data.state}.${replyNote} ${data.html_url ?? ""}`, data.html_url);
  });
  events.addEventListener("submit-failed", (event) => {
    const data = JSON.parse(/** @type {MessageEvent} */ (event).data);
    if (armTimer) clearTimeout(armTimer);
    armTimer = null;
    state.submitting = false;
    renderReviewBar();
    showBanner(`Submit failed: ${data.error}. Nothing was posted — your drafts are intact.`);
  });
  // An answer arriving is the whole point of the loop, and it must land without a reload: a reload
  // here could destroy a half-written review, which is why this protocol has no `reload` event.
  events.addEventListener("qa-answer", (event) => {
    const data = JSON.parse(/** @type {MessageEvent} */ (event).data);
    const thread = findThread(String(data.threadId ?? ""));
    if (!thread) return;
    appendMessage(thread, data.message);
    thread.status = "answered";
    renderThreadFile(thread.id);
    toast(`The agent answered on ${thread.anchor?.path ?? "this diff"}:${thread.anchor?.line ?? ""}`);
  });
  events.addEventListener("qa-message", (event) => {
    const data = JSON.parse(/** @type {MessageEvent} */ (event).data);
    const thread = findThread(String(data.threadId ?? ""));
    if (!thread) return;
    appendMessage(thread, data.message);
    renderThreadFile(thread.id);
  });
  // Emitted for the asker's own question too. Idempotent by id, so the local echo is not doubled.
  events.addEventListener("qa-thread", (event) => {
    const data = JSON.parse(/** @type {MessageEvent} */ (event).data);
    const thread = data.thread;
    if (!thread?.id) return;
    upsertById(state.threads, thread);
    renderThreadFile(thread.id);
  });
  // The diff itself changed under the page. Never a reload from here: `applyRefreshSummary` decides,
  // and it refuses while anything unsent is on screen.
  events.addEventListener("diff-changed", (event) => {
    const data = JSON.parse(/** @type {MessageEvent} */ (event).data);
    state.headMoved = String(data.head?.new ?? "");
    applyRefreshSummary(data);
  });
  events.addEventListener("chat-message", (event) => {
    const data = JSON.parse(/** @type {MessageEvent} */ (event).data);
    if (!data.message) return;
    // Idempotent by id, because this event also comes back for the user's own message — the same
    // reason `qa-thread` upserts rather than pushes.
    upsertById(state.chat, data.message);
    renderChat();
    if (data.message.role === "agent") {
      setChatHint("");
      // The banner is for when the panel is closed; with it open the transcript is the better place.
      notifyChatReply();
    }
  });
  events.addEventListener("session-alerts", (event) => {
    const data = JSON.parse(/** @type {MessageEvent} */ (event).data);
    state.alerts = Array.isArray(data.alerts) ? data.alerts : [];
    renderAlerts();
  });
  events.addEventListener("finding-added", (event) => {
    const finding = JSON.parse(/** @type {MessageEvent} */ (event).data).finding;
    if (finding?.id) upsertById(state.findings, finding);
    renderFindings();
    renderTree();
    toast("Your agent added a finding for you to inspect.");
  });
  events.addEventListener("finding-updated", (event) => {
    const finding = JSON.parse(/** @type {MessageEvent} */ (event).data).finding;
    if (finding?.id) upsertById(state.findings, finding);
    renderFindings();
  });
  events.addEventListener("state-sync", (event) => {
    const data = JSON.parse(/** @type {MessageEvent} */ (event).data);
    applyServerState(data);
  });
  // A draft the server changed without this tab asking: accepting a drift proposal after a push, or
  // the same review open in a second window. The server has been emitting this all along; with no
  // listener for it, the drafts index and the tree kept whatever they last drew.
  events.addEventListener("drafts", (event) => {
    applyServerState(JSON.parse(/** @type {MessageEvent} */ (event).data));
  });
  // Either end of the review can stop it: this toolbar, the agent's `end` command, or another tab.
  events.addEventListener("ended", (event) => {
    const data = JSON.parse(/** @type {MessageEvent} */ (event).data ?? "{}");
    applyEnded(String(data.endedBy ?? ""));
  });
  // The `open` handler is the reconnect catch-up: EventSource reconnects on its own, so this is
  // where any state missed while disconnected is refetched.
  events.addEventListener("open", () => {
    request("")
      .then((data) => {
        if (data?.session) applyServerState(data.session);
      })
      .catch(() => {});
  });
}

// ---------------------------------------------------------------------------
// The drafts list
// ---------------------------------------------------------------------------

/**
 * Every comment the user has written, in the order they will be submitted in.
 *
 * Sorted by file then line rather than by when it was written: that is the order they will appear in
 * the review, and it is the order the reviewer reads the diff in. Creation order would make the list
 * disagree with both.
 */
function draftsInOrder() {
  return /** @type {any[]} */ (state.comments)
    .filter((comment) => comment.state !== "submitted")
    .map((comment) => ({ comment, fileIndex: fileIndexForPath(comment.anchor.path) }))
    .sort((a, b) => {
      if (a.fileIndex !== b.fileIndex) return a.fileIndex - b.fileIndex;
      return (a.comment.anchor.line ?? 0) - (b.comment.anchor.line ?? 0);
    })
    .map((entry) => entry.comment);
}

function renderDrafts() {
  const host = el("prcDrafts");
  const list = el("prcDraftsList");
  const count = el("prcDraftsCount");
  if (!host || !list || !count) return;

  const drafts = draftsInOrder();
  // Hidden entirely when there is nothing, rather than showing an empty heading: the panel's job is to
  // get the reviewer back to their own writing, and a section that is always there but usually empty
  // just costs the file tree height.
  /** @type {HTMLElement} */ (host).hidden = drafts.length === 0;
  const needing = drafts.filter((draft) => draft.state === "stale").length;
  count.textContent =
    `${drafts.length} draft${drafts.length === 1 ? "" : "s"}` + (needing > 0 ? ` · ${needing} need a decision` : "");

  list.textContent = "";
  for (const draft of drafts) list.append(draftRow(draft));
}

/** @param {any} draft @returns {HTMLElement} */
function draftRow(draft) {
  const item = document.createElement("li");
  const button = document.createElement("button");
  button.type = "button";
  button.className = "prc-draft-row";
  button.dataset.act = "reveal-draft";
  button.dataset.id = draft.id;
  if (draft.state === "stale") button.dataset.stale = "1";

  const where = document.createElement("span");
  where.className = "prc-draft-row-where";
  const anchor = draft.anchor;
  const range =
    anchor.kind === "file"
      ? "whole file"
      : anchor.startLine !== undefined
        ? `${anchor.startLine}-${anchor.line}`
        : String(anchor.line);
  // The file's own name, not the whole path: the path is often long enough to eat the row on its own,
  // and the sidebar right below it already gives the directory.
  where.textContent = `${anchor.path.split("/").at(-1)}:${range}`;
  where.title = `${anchor.path}:${range}`;

  const preview = document.createElement("span");
  preview.className = "prc-draft-row-text";
  // One line of the body as written, deliberately not rendered as markdown: this is an index, and a
  // heading or a code fence collapsing to nothing would make a row look empty.
  preview.textContent =
    String(draft.body ?? "")
      .split("\n")
      .find((line) => line.trim())
      ?.trim() ?? "(empty)";

  button.append(where, preview);
  if (draft.suggestion) {
    const badge = document.createElement("span");
    badge.className = "prc-badge prc-badge-suggest";
    badge.textContent = "suggestion";
    button.append(badge);
  }
  if (draft.state === "stale") {
    const badge = document.createElement("span");
    badge.className = "prc-badge prc-badge-stale";
    badge.textContent = "needs a decision";
    button.append(badge);
  }
  item.append(button);
  return item;
}

/**
 * Scroll to a draft and put the cursor on the line it is attached to.
 *
 * Reuses the jump machinery, so a draft on a file that has not been rendered yet — or one the user
 * collapsed — still works. The card is scrolled to rather than the row, because the card is what they
 * are looking for; the flash on the row says which line it belongs to.
 *
 * @param {string} id
 */
function revealDraft(id) {
  const draft = /** @type {any[]} */ (state.comments).find((comment) => comment.id === id);
  if (!draft) return;
  const anchor = draft.anchor;
  if (anchor.kind === "file") {
    revealFile(fileIndexForPath(anchor.path));
    return;
  }
  jumpToLine(anchor.path, anchor.startLine ?? anchor.line, anchor.line);
  // After the jump, because mounting the file is what creates the card in the first place.
  const card = document.querySelector(`[data-draft-id="${cssEscape(id)}"]`);
  card?.scrollIntoView({ block: "center" });
}

/** @param {number} step */
function stepDraft(step) {
  const drafts = draftsInOrder();
  if (drafts.length === 0) {
    toast("You have not drafted any comments yet.");
    return;
  }
  const current = drafts.findIndex((draft) => draft.id === state.lastDraftVisited);
  const next = (current + (current < 0 && step < 0 ? 0 : step) + drafts.length) % drafts.length;
  state.lastDraftVisited = drafts[next].id;
  revealDraft(drafts[next].id);
}

// ---------------------------------------------------------------------------
// Chat with the agent
// ---------------------------------------------------------------------------

/** @param {boolean} [force] */
function toggleChat(force) {
  const layout = document.querySelector(".prc-layout");
  const panel = el("prcChat");
  if (!layout || !panel) return;
  const open = force ?? !state.chatOpen;
  state.chatOpen = open;
  layout.setAttribute("data-chat", open ? "open" : "closed");
  /** @type {HTMLElement} */ (panel).hidden = !open;
  el("prcToggleChat")?.setAttribute("aria-expanded", open ? "true" : "false");
  store(`chat`, open ? "1" : "0");
  if (open) {
    clearChatUnread();
    renderChat();
    el("prcChatText")?.focus();
  }
}

function renderChat() {
  const log = el("prcChatLog");
  if (!log) return;
  const messages = /** @type {any[]} */ (state.chat ?? []);
  log.textContent = "";
  if (messages.length === 0) {
    const empty = document.createElement("p");
    empty.className = "prc-chat-empty";
    empty.textContent =
      "Ask anything about this pull request — what to look at first, whether a change is deliberate. " +
      "Answers can point at lines, and those become links into the diff.";
    log.append(empty);
    return;
  }
  for (const message of messages) log.append(chatMessageCard(message));
  // Newest last, so the log scrolls like a conversation rather than like a feed.
  log.scrollTop = log.scrollHeight;
}

/** @param {any} message @returns {HTMLElement} */
function chatMessageCard(message) {
  const card = document.createElement("div");
  card.className = "prc-chat-msg prc-md";
  card.dataset.role = message.role === "agent" ? "agent" : "user";
  if (message.pending) card.dataset.pending = "1";
  const who = document.createElement("span");
  who.className = "prc-chat-who";
  who.textContent = message.role === "agent" ? "Agent" : "You";
  card.append(who);
  // Markdown for both sides. The agent's replies contain code and line references, and the user's own
  // text is rendered the same way so what they typed is not shown differently from how it was read.
  card.append(renderBody(String(message.text ?? "")));
  return card;
}

async function sendChatMessage() {
  const box = /** @type {HTMLTextAreaElement | null} */ (el("prcChatText"));
  const text = box?.value.trim() ?? "";
  if (!text) return;

  // Optimistic, and marked as such: the message is the user's own words, so showing them immediately
  // is right, but pretending it has reached the agent before the POST returns is not.
  const pending = { id: `local:${Date.now()}`, role: "user", text, at: new Date().toISOString(), pending: true };
  state.chat.push(pending);
  renderChat();
  if (box) box.value = "";
  setChatHint(state.presence === "listening" ? "Sent — the agent is listening." : "Sent. No agent is polling yet.");

  try {
    const result = await request("/messages", { method: "POST", body: JSON.stringify({ text }) });
    const saved = result?.message;
    if (saved?.id) {
      state.chat = state.chat.filter((/** @type {any} */ entry) => entry !== pending);
      upsertById(state.chat, saved);
      renderChat();
    }
  } catch (error) {
    pending.pending = false;
    /** @type {any} */ (pending).failed = true;
    renderChat();
    setChatHint("");
    toast(`Could not send that message: ${error instanceof Error ? error.message : error}`);
    // Handed back rather than lost: it is the user's text, and a failed request is not a reason to
    // make them type it again.
    if (box && !box.value.trim()) box.value = text;
  }
}

/** @param {string} text */
function setChatHint(text) {
  const hint = el("prcChatHint");
  if (hint) hint.textContent = text;
}

/**
 * Scroll the diff to a line a message pointed at.
 *
 * The file may not be mounted — most of a large PR is not — so this mounts it, unfolds it if the user
 * had collapsed it, then flashes the range. A flash rather than a selection: it answers "which row?"
 * and gets out of the way, and it must not be mistaken for something the user selected.
 *
 * @param {string} path
 * @param {number} from
 * @param {number} to
 */
function jumpToLine(path, from, to) {
  const fileIndex = fileIndexForPath(path);
  if (fileIndex < 0) {
    toast(`${path} is not one of the files changed in this pull request.`);
    return;
  }
  const section = el(`F${fileIndex}`);
  if (section?.dataset.collapsed === "1") setFolded(fileIndex, false);
  mountFile(fileIndex);

  for (const previous of document.querySelectorAll(".prc-flash")) previous.classList.remove("prc-flash");
  // The line numbers live inside `data-lk`, so this parses the keys rather than adding attributes
  // that would duplicate them — two encodings of the same fact are two things to keep in agreement.
  /** @type {Element[]} */
  const rows = [];
  for (const cell of document.querySelectorAll(`#F${fileIndex} td.prc-code[data-lk]`)) {
    const parsed = parseLineKey(cell.getAttribute("data-lk") ?? "");
    if (!parsed) continue;
    // A message naming a line almost always means the new file, so `newLine` decides when it exists.
    // Falling back to the old number means a reference to a deleted line still lands somewhere.
    const line = parsed.newLine ?? parsed.oldLine;
    if (line == null || line < from || line > to) continue;
    const row = cell.closest("tr");
    if (row && !rows.includes(row)) rows.push(row);
  }
  if (rows.length === 0) {
    revealFile(fileIndex);
    toast(`${path} has no line ${from}${to === from ? "" : `-${to}`} in this diff; showing the file instead.`);
    return;
  }
  for (const row of rows) row.classList.add("prc-flash");
  rows[0].scrollIntoView({ block: "center" });
}

// ---------------------------------------------------------------------------
// The author pushed
// ---------------------------------------------------------------------------

/** How often to ask whether the head moved, while this tab is visible. */
const HEAD_POLL_MS = 90_000;

/** @type {number | null} */
let headTimer = null;

/**
 * Watch for a push.
 *
 * Only while the tab is visible: a review left open in a background tab for a day should not spend a
 * `gh pr view` a minute on a page nobody is reading. Checking again on becoming visible is what makes
 * that safe — the answer is fetched the moment it matters.
 */
function watchHead() {
  const tick = () => {
    if (document.visibilityState !== "visible") return;
    checkHead().catch(() => {});
  };
  if (headTimer) window.clearInterval(headTimer);
  headTimer = window.setInterval(tick, HEAD_POLL_MS);
  document.addEventListener("visibilitychange", tick);
  tick();
}

async function checkHead() {
  const result = await request("/head");
  if (!result?.changed) return;
  state.headMoved = String(result.headSha ?? "");
  showHeadMovedBanner();
}

function showHeadMovedBanner() {
  // A banner and a button, never an automatic re-fetch. Re-anchoring is only *safe* because the user
  // sees the result; doing it behind their back while they type would defeat the point.
  showBanner("The author has pushed since this page loaded. The diff below is the older commit.");
  appendBannerAction("Refresh the diff", "refresh-diff");
}

/** Whether anything on the page holds text the user has not sent. */
function anyDirty() {
  const composer = composerContents();
  if (composer && composer.text.trim()) return true;
  for (const box of document.querySelectorAll(".prc-reply-text, .prc-composer-text")) {
    if (/** @type {HTMLTextAreaElement} */ (box).value.trim()) return true;
  }
  return false;
}

async function refreshDiff() {
  try {
    toast("Re-fetching the pull request…");
    const summary = await request("/refresh", { method: "POST" });
    applyRefreshSummary(summary);
  } catch (error) {
    toast(`Could not refresh: ${error instanceof Error ? error.message : error}`);
  }
}

/**
 * What to do once the diff has been re-fetched.
 *
 * A reload is the only way this page picks up new diff rows, and it is safe exactly when there is
 * nothing unsent: drafts, questions and the review summary all live on the server. So it reloads
 * when the page is clean and refuses to when it is not — the one thing it must never do is discard
 * text the user is in the middle of writing.
 *
 * @param {any} summary
 */
function applyRefreshSummary(summary) {
  const stale = Array.isArray(summary?.stale) ? summary.stale : [];
  if (!anyDirty() && !state.submitting) {
    window.location.reload();
    return;
  }
  const staleNote = stale.length
    ? ` ${stale.length} draft comment${stale.length === 1 ? "" : "s"} need a decision once you have sent what you are writing.`
    : "";
  showBanner(
    `The pull request was re-fetched, but this page still shows the older diff because you have unsent text.${staleNote}`,
  );
  appendBannerAction("Reload now and lose the unsent text", "reload-page");
}

/**
 * Adopt server state.
 *
 * Threads and comments are replaced wholesale, but an **open composer or reply box is never
 * touched** — `renderFile` preserves both. That is the one client rule worth stating twice: the
 * user's unsent text outranks every server update.
 *
 * @param {any} data
 */
function applyServerState(data) {
  if (Array.isArray(data.chat)) {
    state.chat = data.chat;
    renderChat();
  }
  if (Array.isArray(data.alerts)) {
    state.alerts = data.alerts;
    renderAlerts();
  }
  if (Array.isArray(data.comments)) state.comments = data.comments;
  if (Array.isArray(data.threads)) state.threads = data.threads;
  if (Array.isArray(data.replies)) state.replies = data.replies;
  if (Array.isArray(data.findings)) state.findings = data.findings;
  if (data.status) state.status = data.status;
  // Nothing to announce on a plain state sync: `chat-message` is what says a reply just arrived, and
  // treating a reconnect's hydration as new mail would re-announce the same message on every refetch.
  renderAll();
  renderReviewBar();
}

/**
 * The session-alert strip.
 *
 * Not a toast. Every alert says something about this review has stopped working — the PR was merged,
 * `gh` lost its login — and none of it is fixable from inside the page, so it has to stay on screen
 * until the condition is retracted server-side.
 */
function renderAlerts() {
  const host = el("prcAlerts");
  if (!host) return;
  const alerts = /** @type {any[]} */ (state.alerts ?? []);
  host.hidden = alerts.length === 0;
  host.textContent = "";
  for (const alert of alerts) {
    const line = document.createElement("div");
    const label = document.createElement("strong");
    label.textContent = `${ALERT_LABELS[alert.kind] ?? alert.kind}: `;
    const detail = document.createElement("span");
    detail.textContent = String(alert.detail ?? "");
    line.append(label, detail);
    host.append(line);
  }
}

/** @type {Record<string, string>} */
const ALERT_LABELS = {
  "pr-merged": "This pull request was merged, so a review can no longer be posted to it",
  "pr-closed": "This pull request was closed, so a review can no longer be posted to it",
  "gh-auth-failed": "GitHub CLI authentication failed — your drafts are safe on disk",
  "snapshot-fetch-failed": "The pull request could not be re-fetched, so this diff may be out of date",
};

/**
 * Say that a reply arrived — not what it said.
 *
 * This used to print the whole message at the top of the page as plain text, which was defensible
 * when the only agent message was a one-line note and there was nowhere else to put it. With a
 * transcript panel it is actively wrong: the text appeared twice, and the copy at the top was raw
 * markdown, so `**bold**` and backticks showed as themselves. A reply now has exactly one home, and
 * this is a pointer to it.
 */
function notifyChatReply() {
  const host = el("prcChatNotice");
  if (!host || state.chatOpen) return;
  state.unreadChat += 1;
  host.hidden = false;
  host.textContent = "";
  const label = document.createElement("span");
  label.textContent =
    state.unreadChat === 1 ? "Your agent replied in the chat." : `Your agent sent ${state.unreadChat} replies.`;
  const open = document.createElement("button");
  open.type = "button";
  open.className = "prc-btn prc-btn-quiet";
  open.dataset.act = "open-chat";
  open.textContent = "Read it";
  host.append(label, " ", open);
  markChatUnread();
}

/** The dot on the toggle, so the notice is not the only way to notice. */
function markChatUnread() {
  const button = el("prcToggleChat");
  if (!button) return;
  if (state.unreadChat > 0) button.dataset.unread = String(state.unreadChat);
  else delete button.dataset.unread;
}

function clearChatUnread() {
  state.unreadChat = 0;
  markChatUnread();
  const host = el("prcChatNotice");
  if (host) {
    host.hidden = true;
    host.textContent = "";
  }
}

/**
 * The session is over — from this toolbar, from the agent's `end`, or in another tab.
 *
 * Deliberately does not reload and does not clear anything: the drafts are the user's own writing and
 * an ended session is still worth reading. What changes is that nothing new can be written, which is
 * the honest shape for a canvas whose agent has stopped listening.
 *
 * @param {string} [endedBy]
 */
function applyEnded(endedBy) {
  state.status = "ended";
  if (endedBy) state.endedBy = endedBy;
  const banner = el("prcEndedBanner");
  if (banner) banner.hidden = false;
  const button = el("prcEnd");
  if (button) /** @type {HTMLButtonElement} */ (button).disabled = true;
  closeComposer();
  // Submit is already gated on `status === "ended"`; this is what makes the bar redraw and say so.
  renderReviewBar();
}

/** @param {string} next */
function setPresence(next) {
  state.presence = next === "listening" || next === "working" ? next : "waiting";
  const host = el("prcPresence");
  const label = el("prcPresenceLabel");
  const banner = el("prcPresenceBanner");
  if (host) host.dataset.state = state.presence;
  if (label) {
    label.textContent =
      state.presence === "listening" ? "Agent listening" : state.presence === "working" ? "Agent working…" : "No agent";
  }
  if (banner) banner.hidden = state.presence !== "waiting";
  // The composer hint and any pending-question note both say something different depending on
  // whether an agent is attached, so both follow presence.
  refreshComposerHint();
  for (const note of document.querySelectorAll(".prc-qa-pending")) {
    note.textContent = state.presence === "waiting" ? "Queued — no agent is listening yet." : "Waiting for the agent…";
  }
  renderReviewBar();
}

/**
 * Only `http:` and `https:` may become an `href`.
 *
 * Escaping is not enough on its own: `javascript:alert(1)` contains no character that
 * `escapeHtml` touches, so an escaped-but-unvalidated URL is still an XSS vector. The URL here
 * comes from GitHub's `html_url`, but a scheme allowlist is the difference between "safe because
 * of where it came from" and "safe regardless".
 *
 * @param {unknown} value
 * @returns {string | null}
 */
export function safeHttpUrl(value) {
  try {
    const url = new URL(String(value ?? ""));
    return url.protocol === "http:" || url.protocol === "https:" ? url.href : null;
  } catch {
    return null;
  }
}

/** @param {string} message @param {string} [href] */
function showBanner(message, href) {
  const banner = el("prcSubmitBanner");
  if (!banner) return;
  banner.hidden = false;
  const safe = safeHttpUrl(href);
  // Built from DOM nodes rather than an HTML string so the link's href is set through the DOM API
  // and can never be reinterpreted as markup.
  banner.textContent = safe ? message.replace(safe, "").trim() : message;
  if (safe) {
    const link = document.createElement("a");
    link.href = safe;
    link.target = "_blank";
    link.rel = "noreferrer noopener";
    link.textContent = "View on GitHub";
    banner.append(" ", link);
  }
}

/**
 * Add a button to the banner. Kept separate from `showBanner` so the banner itself stays a pure
 * text-plus-optional-link function.
 *
 * @param {string} label
 * @param {string} act
 */
function appendBannerAction(label, act) {
  const banner = el("prcSubmitBanner");
  if (!banner) return;
  const button = document.createElement("button");
  button.type = "button";
  button.className = "prc-btn prc-btn-quiet";
  button.setAttribute("data-act", act);
  button.textContent = label;
  banner.append(" ", button);
}

/** @param {string} message */
function toast(message) {
  const host = el("prcToasts");
  if (!host) return;
  const node = document.createElement("div");
  node.className = "prc-toast";
  node.textContent = message;
  host.append(node);
  setTimeout(() => node.remove(), 6000);
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

document.addEventListener("click", onDocumentClick);
document.addEventListener("change", onViewedChange);
document.addEventListener("keydown", onKeyDown);
// Dragging down the gutter selects a range. mousemove and mouseup go on the document, not the gutter,
// so a drag that leaves the table still ends cleanly instead of leaving the handler armed.
document.addEventListener("mousedown", onGutterMouseDown);
document.addEventListener("mousemove", onGutterMouseMove);
document.addEventListener("mouseup", onGutterMouseUp);
el("prcOpenSubmit")?.addEventListener("click", openSubmitDialog);
el("prcSubmitConfirm")?.addEventListener("click", confirmSubmit);
el("prcSubmitCancel")?.addEventListener("click", () => {
  /** @type {HTMLDialogElement | null} */ (el("prcSubmitDialog"))?.close();
});
el("prcToggleTree")?.addEventListener("click", () => toggleTree());
el("prcDraftsToggle")?.addEventListener("click", () => {
  const list = el("prcDraftsList");
  const toggle = el("prcDraftsToggle");
  if (!list || !toggle) return;
  const open = toggle.getAttribute("aria-expanded") !== "true";
  toggle.setAttribute("aria-expanded", open ? "true" : "false");
  /** @type {HTMLElement} */ (list).hidden = !open;
});
el("prcToggleChat")?.addEventListener("click", () => toggleChat());
el("prcChatClose")?.addEventListener("click", () => toggleChat(false));
el("prcChatSend")?.addEventListener("click", () => sendChatMessage());
el("prcChatText")?.addEventListener("keydown", (event) => {
  // Cmd/Ctrl+Enter, the same key every other composer here uses. Plain Enter inserts a newline,
  // because a question about a diff runs to several lines more often than not.
  const key = /** @type {KeyboardEvent} */ (event);
  if (key.key === "Enter" && (key.metaKey || key.ctrlKey)) {
    key.preventDefault();
    sendChatMessage();
  }
});
el("prcShortcuts")?.addEventListener("click", () => {
  /** @type {HTMLDialogElement | null} */ (el("prcShortcutsDialog"))?.showModal();
});
// Cycles rather than opening a menu: three states, and the one the reader wants is at most two
// clicks away with nothing to aim at.
el("prcTheme")?.addEventListener("click", () => {
  setTheme(THEMES[(THEMES.indexOf(currentTheme()) + 1) % THEMES.length]);
});
el("prcEnd")?.addEventListener("click", () => {
  /** @type {HTMLDialogElement | null} */ (el("prcEndDialog"))?.showModal();
});
el("prcEndCancel")?.addEventListener("click", () => {
  /** @type {HTMLDialogElement | null} */ (el("prcEndDialog"))?.close();
});
el("prcEndConfirm")?.addEventListener("click", async () => {
  /** @type {HTMLDialogElement | null} */ (el("prcEndDialog"))?.close();
  try {
    await request("/end", { method: "POST" });
    // Applied locally as well as on the push: the server's `ended` event is what tells the other tabs,
    // and waiting for our own copy of it would leave this one live for a round trip.
    applyEnded("user");
    toast("Review ended. Your drafts are kept.");
  } catch (error) {
    toast(`Could not end the review: ${error instanceof Error ? error.message : error}`);
  }
});
// Paint the icon the server could not: the markup ships with the label only, so the button says
// something useful before the bundle arrives and gains its glyph the moment it does.
applyTheme(currentTheme());
// A session that was already over when the page was served: the banner is rendered server-side, but
// the controls it disables are this side.
if (state.status === "ended") applyEnded(state.endedBy);
el("prcShortcutsClose")?.addEventListener("click", () => {
  /** @type {HTMLDialogElement | null} */ (el("prcShortcutsDialog"))?.close();
});
el("prcDiagramClose")?.addEventListener("click", () => {
  /** @type {HTMLDialogElement | null} */ (el("prcDiagramDialog"))?.close();
});
// Clicking outside the picture closes it. The dialog element is the backdrop as far as a click is
// concerned, so a click that lands on the dialog itself — rather than on its contents — is a click away.
el("prcDiagramDialog")?.addEventListener("click", (event) => {
  if (event.target === el("prcDiagramDialog")) /** @type {HTMLDialogElement} */ (el("prcDiagramDialog")).close();
});
// The copy exists only while it is on screen: a closed dialog holding a duplicate of every diagram the
// reader has looked at is memory nobody asked for.
el("prcDiagramDialog")?.addEventListener("close", () => {
  const host = el("prcDiagramZoom");
  if (host) host.textContent = "";
});
el("prcTreeFilter")?.addEventListener("input", (event) => {
  treeQuery = /** @type {HTMLInputElement} */ (event.target).value;
  renderTree();
});
// Enter in the filter jumps to the best match, so finding a file never needs the mouse.
el("prcTreeFilter")?.addEventListener("keydown", (event) => {
  if (event.key !== "Enter") return;
  event.preventDefault();
  const best = filterFiles(fileEntries(), treeQuery)[0];
  if (best) revealFile(best.index);
});

watchChromeHeight();
observeFiles();
renderAll();
renderTree();
renderReviewBar();
renderAlerts();
renderChat();
// Restored from sessionStorage, like the tree and the layout: whether a panel is open is view state,
// and asking the server about it would mean a round trip to answer a question about this tab.
if (restore("chat") === "1") toggleChat(true);
connectEvents();
watchHead();
// The server pre-rendered the first files, so they are on screen but not yet coloured.
for (const file of state.files) if (file.rendered) highlightFile(file.index);

// Exported only so the bundle has a stable named export for the smoke test.
export const ready = true;
export { unifiedTableHtml };

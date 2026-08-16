import { fileAnchorId } from "../anchor/file-anchor.js";
import { escapeHtml, jsonScript } from "../shared/escape.js";
import { filePanelHtml } from "../shared/diff-rows.js";

/**
 * The review page shell.
 *
 * There is deliberately **no iframe**. lavish needs one because it hosts untrusted,
 * agent-authored HTML with live scripts, and the price is a whole postMessage protocol plus a
 * duplicated keydown listener in two realms. Here the diff HTML is ours, generated from a parsed
 * model with every byte escaped, so one document buys real `window.getSelection()`, one scroll
 * context, one keymap owner, and continuous focus order.
 *
 * What the iframe was buying — isolation — is replaced explicitly by a strict CSP (set by the
 * server) plus the rule that no PR content is ever passed to `innerHTML` unescaped.
 */

/** How many files are rendered server-side; the rest mount lazily in the browser. */
export const PRERENDER_FILE_COUNT = 10;

/**
 * The three theme choices, in the order the toolbar button cycles them.
 *
 * `system` is a real choice and not just the absence of one: a reviewer who wants the page to follow
 * their OS has to be able to get back to it after trying the other two. It is expressed as *no*
 * `data-theme` attribute, which is what lets the `prefers-color-scheme` block apply.
 */
export const THEMES = ["system", "light", "dark"];

/**
 * @param {object} input
 * @param {import("../session-store.js").Session} input.session
 * @param {import("../snapshot.js").Snapshot} input.snapshot
 * @param {string} input.clientScript
 * @param {string} input.version
 * @param {import("../gh-threads.js").ThreadsSnapshot | null} [input.threads] existing PR threads
 * @returns {string}
 */
export function renderReviewPage({ session, snapshot, clientScript, version, threads }) {
  const pr = snapshot.pr;
  const title = `${pr.title} · ${session.pr.ref}`;
  const existingThreads = threads?.threads ?? [];
  const resolvedStateKnown = threads?.graphqlAvailable !== false;
  const layout = session.prefs?.layout === "split" ? "split" : "unified";
  // Stamped on <html> below rather than applied by the client, so a reader whose choice is the
  // opposite of their OS never sees the other theme flash before the bundle has loaded.
  const theme = THEMES.includes(String(session.prefs?.theme)) ? String(session.prefs?.theme) : "system";
  const themeLabel = theme === "system" ? "Auto" : theme === "dark" ? "Dark" : "Light";

  /**
   * Whether a file counts as viewed **right now**.
   *
   * `viewed` is recorded together with the SHA it was ticked at, so a push un-views whatever changed
   * — the same behaviour as GitHub, and for the same reason: a tick that survives a rewrite of the
   * file is a claim the reviewer never made.
   *
   * @param {string} path
   */
  const isViewed = (path) => {
    const mark = session.viewed[path];
    return Boolean(mark) && (!mark.atSha || mark.atSha === snapshot.headSha);
  };

  const bootstrap = {
    accessId: session.accessId,
    version,
    pr: {
      ref: session.pr.ref,
      url: session.pr.url,
      // Carried explicitly rather than parsed back out of `ref` in the browser: the host is what
      // makes a permalink point at an Enterprise instance instead of github.com.
      host: session.pr.host,
      owner: session.pr.owner,
      repo: session.pr.repo,
      number: pr.number,
      title: pr.title,
      state: pr.state,
      isDraft: pr.isDraft,
      headRefName: pr.headRefName,
      baseRefName: pr.baseRefName,
      headSha: snapshot.headSha,
      baseSha: snapshot.baseSha,
    },
    counts: snapshot.counts,
    fileCountCapped: snapshot.fileCountCapped,
    // Metadata only. Patches for un-rendered files are fetched per file on demand, so opening a
    // 200-file PR does not ship megabytes of diff into the initial payload.
    files: snapshot.files.map((file, index) => ({
      index,
      path: file.path,
      previousPath: file.previousPath,
      status: file.status,
      additions: file.additions,
      deletions: file.deletions,
      patchAvailability: file.patchAvailability,
      degraded: file.degraded,
      rendered: index < PRERENDER_FILE_COUNT,
      viewed: isViewed(file.path),
      // Computed here because it needs sha256, which `shared/permalink.js` deliberately cannot
      // reach: that module is in the browser bundle. Handing the client the value instead of the
      // recipe also removes any chance of the two disagreeing.
      anchorId: fileAnchorId(file.path),
      hunkCount: file.hunks.length,
    })),
    layout,
    prefs: session.prefs,
    comments: session.comments,
    threads: session.threads,
    replies: session.replies,
    // Existing PR threads, anchored inline where GitHub still places them. Outdated and file-level
    // ones are carried too; the client lists those per file rather than pinning them to a line.
    existing: existingThreads,
    existingResolvedKnown: resolvedStateKnown,
    review: session.review,
    viewed: session.viewed,
    status: session.status,
    // Who stopped it, so a page served after the fact can say which end walked away.
    endedBy: session.endedBy ?? "",
    alerts: session.alerts,
    // The whole transcript, not just the latest note: a conversation the page cannot replay is a
    // conversation the user loses on every reload.
    chat: session.chat,
    findings: session.findings,
  };

  const panels = snapshot.files
    .map((file, index) =>
      filePanelHtml(index, file, {
        rendered: index < PRERENDER_FILE_COUNT,
        viewed: isViewed(file.path),
        layout,
        anchorId: fileAnchorId(file.path),
      }),
    )
    .join("");

  return `<!doctype html>
<html lang="en"${theme === "system" ? "" : ` data-theme="${theme}"`}>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<link rel="stylesheet" href="/assets/prc.css">
<link rel="stylesheet" href="/assets/prc-hl.css">
</head>
<body class="prc">
<a class="prc-skip" href="#prcFiles">Skip to changed files</a>

<header class="prc-header" data-prc-chrome>
  <h1 class="prc-pr-title">${escapeHtml(pr.title)} <span class="prc-pr-num">#${pr.number}</span></h1>
  <span class="prc-state">${escapeHtml(pr.state)}</span>
  <span class="prc-refs"><code>${escapeHtml(pr.baseRefName)}</code> &larr; <code>${escapeHtml(pr.headRefName)}</code></span>
  <span class="prc-spacer"></span>
  <div class="prc-presence" id="prcPresence" data-state="waiting" role="status" aria-live="polite">
    <span class="prc-presence-dot" aria-hidden="true"></span><span id="prcPresenceLabel">No agent</span>
  </div>
</header>

<div class="prc-toolbar" data-prc-chrome>
  <button class="prc-btn prc-btn-quiet" id="prcToggleTree" type="button" aria-expanded="true"
    aria-controls="prcTree" title="Show or hide the file tree (t)">&#9776; Files</button>
  <span class="prc-counts">${snapshot.counts.files} files changed &middot;
    <ins>+${snapshot.counts.additions}</ins> <del>&minus;${snapshot.counts.deletions}</del></span>
  <span class="prc-spacer"></span>
  <div class="prc-segmented" role="group" aria-label="Diff layout">
    <button class="prc-seg" type="button" data-act="layout" data-layout="unified"
      aria-pressed="${layout === "unified"}">Unified</button>
    <button class="prc-seg" type="button" data-act="layout" data-layout="split"
      aria-pressed="${layout === "split"}">Split</button>
  </div>
  <!-- Rendered with the saved choice already applied, and with a word rather than only an icon: the
       three states are system / light / dark, and a lone sun cannot say which of the three is on. -->
  <button class="prc-btn prc-btn-quiet prc-theme" id="prcTheme" type="button"
    data-theme-choice="${escapeHtml(theme)}" title="Theme: ${escapeHtml(theme)} — click to change"
    aria-label="Theme: ${escapeHtml(theme)}"><span class="prc-theme-label">${escapeHtml(themeLabel)}</span></button>
  <button class="prc-btn prc-btn-quiet" id="prcShortcuts" type="button" title="Keyboard shortcuts (?)">?</button>
  <a class="prc-link" href="${escapeHtml(session.pr.url)}" target="_blank" rel="noreferrer noopener">Open on GitHub</a>
  <!-- Last, on the right: the panel it opens is the right-hand column, so the control sits on the side
       the thing appears. -->
  <button class="prc-btn prc-btn-quiet" id="prcToggleChat" type="button" aria-expanded="false"
    aria-controls="prcChat" title="Show or hide the chat with your agent (g)">&#128172; Chat</button>
</div>

<div class="prc-banner" id="prcPresenceBanner" hidden>
  No agent is listening. Run <code>pr-review-canvas poll ${escapeHtml(session.pr.ref)}</code> in your agent session.
</div>
<!-- Stays on screen for the rest of the page's life: an ended session accepts nothing, and a message
     that says so has to outlast the click that caused it. Rendered here rather than built in the
     client so an already-ended session says so before the bundle loads. -->
<div class="prc-banner prc-banner-attention" id="prcEndedBanner"${session.status === "ended" ? "" : " hidden"}>
  This review has ended. Your drafts are kept — reopen it with
  <code>pr-review-canvas ${escapeHtml(session.pr.ref)} --reopen</code>.
</div>
<div class="prc-banner prc-banner-attention" id="prcSubmitBanner" hidden></div>
<!-- Says that a reply arrived, never what it said: the transcript is the one place a message is
     rendered, and a second copy here would be raw markdown next to a formatted one. -->
<div class="prc-banner prc-banner-agent" id="prcChatNotice" hidden></div>
<!-- Session alerts: the PR was merged or closed, or GitHub cannot be reached. Their own strip rather
     than a toast, because every one of them means something about this review has stopped working and
     a message that disappears after six seconds is the wrong shape for that. -->
<div class="prc-banner prc-banner-alert" id="prcAlerts" hidden role="alert"></div>

<main class="prc-layout" data-tree="open" data-chat="closed">
  <nav class="prc-tree" id="prcTree" data-prc-chrome aria-label="Changed files">
    <div class="prc-tree-head">
      <input type="search" id="prcTreeFilter" class="prc-tree-filter" placeholder="Filter files (t)"
        aria-label="Filter changed files" autocomplete="off" spellcheck="false">
    </div>
    <!-- Every draft in one place. Above the file list because it is the reviewer's own work in
         progress, and because the thing they most often want is "take me back to what I wrote". -->
    <section class="prc-drafts" id="prcDrafts" aria-label="Your drafted comments" hidden>
      <button class="prc-drafts-head" id="prcDraftsToggle" type="button" aria-expanded="true"
        aria-controls="prcDraftsList"><span class="prc-drafts-caret" aria-hidden="true">▼</span>
        <span id="prcDraftsCount"></span></button>
      <ul class="prc-drafts-list" id="prcDraftsList"></ul>
    </section>
    <section class="prc-findings" id="prcFindings" aria-label="Agent findings" hidden>
      <div class="prc-findings-head"><span id="prcFindingsCount"></span></div>
      <div class="prc-findings-list" id="prcFindingsList"></div>
    </section>
    <div class="prc-tree-body" id="prcTreeBody"></div>
    <div class="prc-tree-foot" id="prcTreeProgress"></div>
  </nav>
  <div class="prc-files" id="prcFiles">${panels}</div>
  <!-- The chat panel. Separate from a question on a line because it carries no anchor: it is for what
       a diff has no single home for — where to start, whether a change is intentional. Collapsed by
       default so it never takes width from the diff until it is asked for. -->
  <aside class="prc-chat" id="prcChat" data-prc-chrome aria-label="Chat with your agent" hidden>
    <div class="prc-chat-head">
      <strong>Ask your agent</strong>
      <span class="prc-spacer"></span>
      <button class="prc-btn prc-btn-quiet" id="prcChatClose" type="button" title="Hide the chat (g)">&times;</button>
    </div>
    <div class="prc-chat-log" id="prcChatLog" role="log" aria-live="polite"></div>
    <div class="prc-chat-foot">
      <textarea class="prc-chat-text" id="prcChatText" rows="3" placeholder="Ask about this pull request…"
        aria-label="Message to your agent"></textarea>
      <div class="prc-chat-actions">
        <span class="prc-chat-hint" id="prcChatHint"></span>
        <button class="prc-btn prc-btn-primary" id="prcChatSend" type="button">Send</button>
      </div>
    </div>
  </aside>
</main>

<footer class="prc-reviewbar" data-prc-chrome>
  <span id="prcReviewBarSummary">No drafted comments</span>
  <button class="prc-btn prc-btn-primary" id="prcOpenSubmit" type="button">Review changes</button>
  <!-- Far right, and pushed there by a margin rather than by moving anything else: the last thing in
       the footer is the last thing you do. Ending the session tells the agent to stop waiting, which is
       a different act from closing the tab — so it is quiet, kept clear of Submit, and confirmed. -->
  <button class="prc-btn prc-btn-quiet prc-reviewbar-end" id="prcEnd" type="button"
    title="End this review session">End review</button>
</footer>

<div class="prc-actionbar" id="prcActionBar" hidden role="toolbar" aria-label="Actions for the selected line" data-prc-chrome></div>

<dialog class="prc-dialog" id="prcSubmitDialog" data-prc-chrome>
  <form method="dialog" id="prcSubmitForm">
    <h2>Submit review</h2>
    <p id="prcSubmitCount"></p>
    <label class="prc-field"><span>Summary</span>
      <textarea id="prcSummary" rows="4" placeholder="Overall notes for the author"></textarea></label>
    <fieldset class="prc-verdicts">
      <legend>Verdict</legend>
      <label><input type="radio" name="verdict" value="COMMENT" checked> Comment</label>
      <label><input type="radio" name="verdict" value="APPROVE"> Approve</label>
      <label><input type="radio" name="verdict" value="REQUEST_CHANGES"> Request changes</label>
    </fieldset>
    <p class="prc-dialog-note" id="prcSubmitNote"></p>
    <div class="prc-dialog-actions">
      <button type="button" class="prc-btn" id="prcSubmitCancel">Cancel</button>
      <button type="button" class="prc-btn prc-btn-primary" id="prcSubmitConfirm">Submit</button>
    </div>
  </form>
</dialog>

<dialog class="prc-dialog" id="prcShortcutsDialog" data-prc-chrome>
  <h2>Keyboard shortcuts</h2>
  <dl class="prc-keys">
    <dt><kbd>j</kbd> / <kbd>k</kbd></dt><dd>Next / previous line</dd>
    <dt><kbd>Shift</kbd> + <kbd>J</kbd> / <kbd>K</kbd></dt><dd>Grow the selection by a line</dd>
    <dt><kbd>n</kbd> / <kbd>p</kbd></dt><dd>Next / previous file</dd>
    <dt><kbd>[</kbd> / <kbd>]</kbd></dt><dd>Previous / next hunk</dd>
    <dt><kbd>c</kbd></dt><dd>Comment on the current line</dd>
    <dt><kbd>a</kbd></dt><dd>Ask the agent about the current line</dd>
    <dt><kbd>y</kbd></dt><dd>Copy a permanent link to the current line</dd>
    <dt><kbd>v</kbd></dt><dd>Mark the current file viewed</dd>
    <dt><kbd>t</kbd></dt><dd>Filter files</dd>
    <dt><kbd>g</kbd></dt><dd>Show or hide the chat with your agent</dd>
    <dt><kbd>d</kbd> / <kbd>Shift</kbd> + <kbd>D</kbd></dt><dd>Next / previous comment you drafted</dd>
    <dt><kbd>Cmd</kbd>/<kbd>Ctrl</kbd> + <kbd>Enter</kbd></dt><dd>Send what you are writing</dd>
    <dt><kbd>Esc</kbd></dt><dd>Close the innermost thing that is open</dd>
    <dt><kbd>?</kbd></dt><dd>This list</dd>
  </dl>
  <p class="prc-dialog-note">
    To comment on several lines, drag down the line numbers — or click one, then
    <kbd>Shift</kbd>-click another. A selection that reaches past the end of a hunk is trimmed there,
    because GitHub only accepts a range that lies inside the diff.
  </p>
  <div class="prc-dialog-actions">
    <button type="button" class="prc-btn" id="prcShortcutsClose">Close</button>
  </div>
</dialog>

<!-- One dialog for every diagram on the page, filled with a clone when it is opened. A dialog per figure
     would mean one hidden copy of every diagram in the document from the moment it rendered. -->
<dialog class="prc-dialog prc-zoom" id="prcDiagramDialog" data-prc-chrome aria-label="Diagram, enlarged">
  <div class="prc-zoom-head">
    <span class="prc-zoom-title" id="prcDiagramTitle">Diagram</span>
    <span class="prc-spacer"></span>
    <button type="button" class="prc-btn prc-btn-quiet" id="prcDiagramClose" title="Close (Esc)">&times;</button>
  </div>
  <!-- The second class is the palette the figure uses too. Without it the enlarged copy arrives carrying
       mermaid's class names and no rules for them, which renders as black on black. -->
  <div class="prc-zoom-body prc-mermaid" id="prcDiagramZoom"></div>
</dialog>

<!-- Confirmed rather than immediate, because the agent is waiting on the other end of this and being
     told to stop is not something to trigger by a mis-click. It says what survives, so the answer to
     "have I just lost my review?" is on screen at the moment the question is asked. -->
<dialog class="prc-dialog" id="prcEndDialog" data-prc-chrome>
  <h2>End this review?</h2>
  <p>
    Your agent stops waiting and the canvas accepts nothing further. Nothing is posted to GitHub, and
    nothing is deleted: every draft, question and reply stays on disk.
  </p>
  <p class="prc-dialog-note">
    Reopen it later with <code>pr-review-canvas ${escapeHtml(session.pr.ref)} --reopen</code>. The local
    server keeps running for other reviews — <code>pr-review-canvas stop</code> shuts it down.
  </p>
  <div class="prc-dialog-actions">
    <button type="button" class="prc-btn" id="prcEndCancel">Keep reviewing</button>
    <button type="button" class="prc-btn prc-btn-primary" id="prcEndConfirm">End review</button>
  </div>
</dialog>

<div class="prc-toasts" id="prcToasts"></div>
<div class="prc-sr" id="prcLive" role="status" aria-live="polite"></div>

<script id="prc-bootstrap" type="application/json">${jsonScript(bootstrap)}</script>
<script src="${escapeHtml(clientScript)}"></script>
</body>
</html>`;
}

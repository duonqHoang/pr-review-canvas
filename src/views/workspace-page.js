import { escapeHtml } from "../shared/escape.js";
import { THEMES } from "./page.js";

/**
 * The workspace is a control plane, never a second diff renderer. It links to the existing canvases
 * so anchors, drafts and submission gates remain owned by exactly one PR session.
 *
 * @param {{ workspace: import("../workspace-store.js").ReviewWorkspace, version: string, theme?: string, syncTheme?: boolean }} input
 */
export function renderWorkspacePage({ workspace, version, theme = "system", syncTheme = false }) {
  const themeChoice = THEMES.includes(theme) ? theme : "system";
  const themeLabel = { system: "Auto", light: "Light", dark: "Dark" }[themeChoice] ?? "Auto";
  const bootstrap = JSON.stringify({ accessId: workspace.accessId, version, theme: themeChoice, syncTheme }).replace(
    /</g,
    "\\u003c",
  );
  return `<!doctype html>
<html lang="en"${themeChoice === "system" ? "" : ` data-theme="${themeChoice}"`}>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(workspace.name)} · PR review workspace</title>
<link rel="stylesheet" href="/assets/prc.css">
</head>
<body class="prc prc-workspace">
<a class="prc-skip" href="#prcWorkspaceMain">Skip to review queue</a>
<header class="prc-header prc-workspace-header">
  <span class="prc-workspace-mark" aria-hidden="true">PR</span>
  <div class="prc-workspace-identity">
    <span class="prc-workspace-eyebrow">Review workspace</span>
    <h1 class="prc-pr-title">${escapeHtml(workspace.name)}</h1>
  </div>
  <span class="prc-spacer"></span>
  <button class="prc-btn prc-btn-quiet prc-theme" id="prcWorkspaceTheme" type="button"
    data-theme-choice="${themeChoice}" title="Theme: ${themeChoice} — click to change"
    aria-label="Theme: ${themeChoice}"><span class="prc-theme-label">${themeLabel}</span></button>
  <span class="prc-presence" id="prcWorkspacePresence" data-state="working" role="status" aria-live="polite"><span class="prc-presence-dot" aria-hidden="true"></span><span>Connecting</span></span>
</header>
<main class="prc-workspace-main" id="prcWorkspaceMain">
  <section class="prc-workspace-hero" aria-labelledby="prcWorkspaceQueueTitle">
    <div>
      <p class="prc-workspace-kicker">Co-review control plane</p>
      <h2 id="prcWorkspaceQueueTitle">Review queue</h2>
      <p class="prc-workspace-lede">Prioritize pull requests, track unresolved work, and jump into each focused review canvas.</p>
    </div>
    <div class="prc-workspace-actions">
      <button class="prc-btn prc-btn-quiet" id="prcWorkspaceRefresh" type="button">Refresh dashboard</button>
      <button class="prc-btn prc-btn-quiet" id="prcWorkspaceRefreshPrs" type="button">Refresh all PRs</button>
    </div>
  </section>
  <section class="prc-workspace-summary" id="prcWorkspaceSummary" aria-label="Workspace overview" aria-live="polite">
    <p class="prc-workspace-loading">Loading workspace overview…</p>
  </section>
  <section aria-labelledby="prcWorkspacePrsTitle">
    <div class="prc-workspace-section-head">
      <div><p class="prc-workspace-kicker">Ordered by priority</p><h2 id="prcWorkspacePrsTitle">Pull requests</h2></div>
    </div>
    <div class="prc-workspace-grid" id="prcWorkspaceGrid"></div>
  </section>
  <div class="prc-workspace-context-grid">
    <section class="prc-workspace-context" id="prcWorkspaceRelationsSection" hidden>
      <p class="prc-workspace-kicker">Review order</p><h2>Relationships</h2>
      <div class="prc-workspace-relations" id="prcWorkspaceRelations"></div>
    </section>
    <section class="prc-workspace-context" id="prcWorkspaceOverlapSection" hidden>
      <p class="prc-workspace-kicker">Shared surface area</p><h2>Cross-PR overlap</h2>
      <div class="prc-workspace-overlaps" id="prcWorkspaceOverlaps"></div>
    </section>
  </div>
</main>
<script id="prc-workspace-bootstrap" type="application/json">${bootstrap}</script>
<script src="/assets/prc-workspace.js" defer></script>
</body>
</html>`;
}

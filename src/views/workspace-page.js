import { escapeHtml } from "../shared/escape.js";

/**
 * The workspace is a control plane, never a second diff renderer. It links to the existing canvases
 * so anchors, drafts and submission gates remain owned by exactly one PR session.
 *
 * @param {{ workspace: import("../workspace-store.js").ReviewWorkspace, version: string }} input
 */
export function renderWorkspacePage({ workspace, version }) {
  const bootstrap = JSON.stringify({ accessId: workspace.accessId, version }).replace(/</g, "\\u003c");
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(workspace.name)} · PR review workspace</title>
<link rel="stylesheet" href="/assets/prc.css">
</head>
<body class="prc prc-workspace">
<header class="prc-header">
  <h1 class="prc-pr-title">${escapeHtml(workspace.name)}</h1>
  <span class="prc-state">Review workspace</span>
  <span class="prc-spacer"></span>
  <span class="prc-presence" id="prcWorkspacePresence" data-state="waiting"><span class="prc-presence-dot"></span><span>Loading</span></span>
</header>
<main class="prc-workspace-main">
  <section class="prc-workspace-summary" id="prcWorkspaceSummary" aria-live="polite"></section>
  <section>
    <div class="prc-workspace-section-head"><h2>Pull requests</h2>
      <button class="prc-btn prc-btn-quiet" id="prcWorkspaceRefresh" type="button">Refresh dashboard</button>
      <button class="prc-btn" id="prcWorkspaceRefreshPrs" type="button">Refresh all PRs</button>
    </div>
    <div class="prc-workspace-grid" id="prcWorkspaceGrid"></div>
  </section>
  <section id="prcWorkspaceRelationsSection" hidden>
    <h2>Relationships</h2>
    <div class="prc-workspace-relations" id="prcWorkspaceRelations"></div>
  </section>
  <section id="prcWorkspaceOverlapSection" hidden>
    <h2>Cross-PR overlap</h2>
    <div class="prc-workspace-overlaps" id="prcWorkspaceOverlaps"></div>
  </section>
</main>
<script id="prc-workspace-bootstrap" type="application/json">${bootstrap}</script>
<script src="/assets/prc-workspace.js" defer></script>
</body>
</html>`;
}

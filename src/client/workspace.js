/**
 * Workspace dashboard client. It intentionally renders summaries only; entering a PR follows its
 * random-access canvas URL, preserving the existing per-session security and correctness boundary.
 */

const bootstrap = JSON.parse(document.getElementById("prc-workspace-bootstrap")?.textContent ?? "{}");
const accessId = String(bootstrap.accessId ?? "");
const api = `/api/ui/w/${encodeURIComponent(accessId)}`;
/** @type {any} */
let latest = null;

/** @param {string} id */
const el = (id) => document.getElementById(id);

/** @param {string} value */
function text(value) {
  return document.createTextNode(value);
}

/** @param {any} data */
function render(data) {
  latest = data;
  const members = Array.isArray(data.members) ? data.members : [];
  const totals = data.totals ?? {};
  const summary = el("prcWorkspaceSummary");
  if (summary) {
    summary.textContent = `${members.length} PR${members.length === 1 ? "" : "s"} · ${totals.openQuestions ?? 0} open questions · ${totals.openFindings ?? 0} open findings · ${totals.draftComments ?? 0} drafts`;
  }

  const grid = el("prcWorkspaceGrid");
  if (grid) {
    grid.replaceChildren();
    for (const member of members) grid.append(memberCard(member));
    if (!members.length) {
      const empty = document.createElement("p");
      empty.className = "prc-workspace-empty";
      empty.append(text("This workspace is empty. Add a PR with pr-review-canvas workspace add."));
      grid.append(empty);
    }
  }
  renderRelations(data.relations ?? [], members);
  renderOverlaps(data.overlaps ?? [], members);
}

/** @param {any} member */
function memberCard(member) {
  const card = document.createElement("article");
  card.className = "prc-workspace-card";
  card.dataset.status = member.status;

  const head = document.createElement("div");
  head.className = "prc-workspace-card-head";
  const title = document.createElement("a");
  title.className = "prc-workspace-card-title";
  title.href = member.canvasUrl;
  title.append(text(member.title ? `${member.title} · ${member.ref}` : member.ref));
  const priority = document.createElement("span");
  priority.className = "prc-chip";
  priority.append(text(`P${member.priority}`));
  const earlier = priorityButton("↑", member.key, Math.max(1, member.priority - 1), "Raise priority");
  const later = priorityButton("↓", member.key, member.priority + 1, "Lower priority");
  head.append(title, priority, earlier, later);

  const meta = document.createElement("div");
  meta.className = "prc-workspace-card-meta";
  meta.append(
    text(
      `${member.status}${member.headMoved ? " · new head" : ""}${member.alerts ? ` · ${member.alerts} alerts` : ""}`,
    ),
  );
  if (member.risk?.critical || member.risk?.high) {
    meta.append(text(` · ${member.risk.critical ?? 0} critical / ${member.risk.high ?? 0} high risk`));
  }
  if (member.staleFindings) meta.append(text(` · ${member.staleFindings} stale findings`));

  const progress = document.createElement("progress");
  progress.max = Math.max(1, member.files ?? 0);
  progress.value = Math.min(progress.max, member.viewedFiles ?? 0);
  progress.setAttribute("aria-label", `${member.viewedFiles ?? 0} of ${member.files ?? 0} files viewed`);

  const counts = document.createElement("div");
  counts.className = "prc-workspace-card-counts";
  counts.append(
    count("files viewed", `${member.viewedFiles ?? 0}/${member.files ?? 0}`),
    count("questions", member.openQuestions ?? 0),
    count("findings", member.openFindings ?? 0),
    count("drafts", member.draftComments ?? 0),
  );

  const next = document.createElement("p");
  next.className = "prc-workspace-next";
  next.append(text(member.nextAction));
  card.append(head, meta, progress, counts, next);
  return card;
}

/** @param {string} label @param {string} key @param {number} priority @param {string} title */
function priorityButton(label, key, priority, title) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "prc-btn prc-btn-quiet prc-workspace-priority";
  button.dataset.key = key;
  button.dataset.priority = String(priority);
  button.title = title;
  button.setAttribute("aria-label", title);
  button.append(text(label));
  return button;
}

/** @param {string} label @param {string | number} value */
function count(label, value) {
  const item = document.createElement("span");
  const strong = document.createElement("strong");
  strong.append(text(String(value)));
  item.append(strong, text(` ${label}`));
  return item;
}

/** @param {any[]} relations @param {any[]} members */
function renderRelations(relations, members) {
  const section = el("prcWorkspaceRelationsSection");
  const host = el("prcWorkspaceRelations");
  if (!section || !host) return;
  section.hidden = relations.length === 0;
  host.replaceChildren();
  const refs = new Map(members.map((member) => [member.key, member.ref]));
  for (const relation of relations) {
    const row = document.createElement("div");
    row.className = "prc-workspace-relation";
    row.append(
      text(`${refs.get(relation.from) ?? relation.from} ${relation.kind} ${refs.get(relation.to) ?? relation.to}`),
    );
    host.append(row);
  }
}

/** @param {any[]} overlaps @param {any[]} members */
function renderOverlaps(overlaps, members) {
  const section = el("prcWorkspaceOverlapSection");
  const host = el("prcWorkspaceOverlaps");
  if (!section || !host) return;
  section.hidden = overlaps.length === 0;
  host.replaceChildren();
  const refs = new Map(members.map((member) => [member.key, member.ref]));
  for (const overlap of overlaps.slice(0, 100)) {
    const row = document.createElement("div");
    row.className = "prc-workspace-overlap";
    row.append(
      text(`${overlap.path} · ${overlap.sessions.map((/** @type {string} */ key) => refs.get(key) ?? key).join(", ")}`),
    );
    host.append(row);
  }
}

async function load() {
  const response = await fetch(api, { headers: { accept: "application/json" } });
  if (!response.ok) throw new Error(`dashboard request failed (${response.status})`);
  render(await response.json());
}

el("prcWorkspaceRefresh")?.addEventListener("click", () => load().catch(showError));
el("prcWorkspaceRefreshPrs")?.addEventListener("click", async () => {
  const button = /** @type {HTMLButtonElement | null} */ (el("prcWorkspaceRefreshPrs"));
  if (button) button.disabled = true;
  const summary = el("prcWorkspaceSummary");
  if (summary) summary.textContent = "Refreshing every pull request…";
  try {
    const response = await fetch(`${api}/refresh`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    if (!response.ok) throw new Error(`workspace refresh failed (${response.status})`);
    const result = await response.json();
    render(result.summary);
    const failed = result.results.filter((/** @type {any} */ item) => item.status === "failed").length;
    if (summary && failed) summary.append(text(` · ${failed} PR refresh failed; its session was left intact.`));
  } catch (error) {
    showError(error);
  } finally {
    if (button) button.disabled = false;
  }
});
el("prcWorkspaceGrid")?.addEventListener("click", async (event) => {
  const target = /** @type {Element | null} */ (event.target);
  const button = target?.closest(".prc-workspace-priority");
  if (!button) return;
  try {
    const response = await fetch(
      `${api}/members/${encodeURIComponent(button.getAttribute("data-key") ?? "")}/priority`,
      {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ priority: Number(button.getAttribute("data-priority")) }),
      },
    );
    if (!response.ok) throw new Error(`priority update failed (${response.status})`);
    render(await response.json());
  } catch (error) {
    showError(error);
    if (latest) render(latest);
  }
});

/** @param {unknown} error */
function showError(error) {
  const summary = el("prcWorkspaceSummary");
  if (summary) summary.textContent = String(error instanceof Error ? error.message : error);
}

const source = new EventSource(`/workspace-events/${encodeURIComponent(accessId)}`);
source.addEventListener("workspace-changed", () => load().catch(showError));
source.addEventListener("state-sync", (event) => render(JSON.parse(/** @type {MessageEvent} */ (event).data)));
source.addEventListener("open", () => {
  const presence = el("prcWorkspacePresence");
  if (presence) presence.textContent = "Live";
});
source.addEventListener("error", () => {
  const presence = el("prcWorkspacePresence");
  if (presence) presence.textContent = "Reconnecting";
});

load().catch(showError);

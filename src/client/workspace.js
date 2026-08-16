/**
 * Workspace dashboard client. It intentionally renders summaries only; entering a PR follows its
 * random-access canvas URL, preserving the existing per-session security and correctness boundary.
 */

const bootstrap = JSON.parse(document.getElementById("prc-workspace-bootstrap")?.textContent ?? "{}");
const accessId = String(bootstrap.accessId ?? "");
const api = `/api/ui/w/${encodeURIComponent(accessId)}`;
const themes = ["system", "light", "dark"];
/** @type {any} */
let latest = null;

/** @param {string} id */
const el = (id) => document.getElementById(id);

/** @param {string} value */
function text(value) {
  return document.createTextNode(value);
}

/** @param {string} theme */
function applyTheme(theme) {
  const choice = themes.includes(theme) ? theme : "system";
  if (choice === "system") document.documentElement.removeAttribute("data-theme");
  else document.documentElement.setAttribute("data-theme", choice);
  const button = el("prcWorkspaceTheme");
  if (button) {
    const label = { system: "Auto", light: "Light", dark: "Dark" }[choice] ?? "Auto";
    button.dataset.themeChoice = choice;
    button.setAttribute("title", `Theme: ${choice} — click to change`);
    button.setAttribute("aria-label", `Theme: ${choice}`);
    const face = button.querySelector(".prc-theme-label");
    if (face) face.textContent = label;
  }
  return choice;
}

/** @param {string} theme */
function saveTheme(theme) {
  const choice = applyTheme(theme);
  return fetch(`${api}/prefs`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ theme: choice }),
  });
}

/** @param {any} data */
function render(data) {
  latest = data;
  const members = Array.isArray(data.members) ? data.members : [];
  const totals = data.totals ?? {};
  const summary = el("prcWorkspaceSummary");
  if (summary) {
    summary.classList.remove("prc-workspace-summary-error");
    summary.replaceChildren(
      summaryStat("Pull requests", members.length, "in this workspace", "neutral"),
      summaryStat("Open questions", totals.openQuestions ?? 0, "waiting for the agent", "attention"),
      summaryStat("Open findings", totals.openFindings ?? 0, "need a decision", "attention"),
      summaryStat("Draft comments", totals.draftComments ?? 0, "saved, not submitted", "attention"),
    );
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
  const ref = document.createElement("span");
  ref.className = "prc-workspace-card-ref";
  ref.append(text(member.ref));
  const titleText = document.createElement("span");
  titleText.append(text(member.title || member.ref));
  title.append(ref, titleText);
  const priorityControls = document.createElement("div");
  priorityControls.className = "prc-workspace-priority-controls";
  priorityControls.setAttribute("aria-label", `Priority ${member.priority}`);
  const priority = document.createElement("span");
  priority.className = "prc-chip";
  priority.append(text(`P${member.priority}`));
  const earlier = priorityButton("↑", member.key, Math.max(1, member.priority - 1), "Move earlier");
  const later = priorityButton("↓", member.key, member.priority + 1, "Move later");
  priorityControls.append(priority, earlier, later);
  head.append(title, priorityControls);

  const meta = document.createElement("div");
  meta.className = "prc-workspace-card-meta";
  meta.append(metaBadge(member.status, "status"));
  if (member.headMoved) meta.append(metaBadge("New head", "attention"));
  if (member.alerts) meta.append(metaBadge(`${member.alerts} alerts`, "danger"));
  if (member.risk?.critical || member.risk?.high) {
    meta.append(metaBadge(`${member.risk.critical ?? 0} critical / ${member.risk.high ?? 0} high risk`, "danger"));
  }
  if (member.staleFindings) meta.append(metaBadge(`${member.staleFindings} stale findings`, "attention"));

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
  const nextLabel = document.createElement("strong");
  nextLabel.append(text("Next: "));
  next.append(nextLabel, text(member.nextAction));
  const continueLink = document.createElement("a");
  continueLink.className = "prc-btn prc-btn-primary prc-workspace-continue";
  continueLink.href = member.canvasUrl;
  continueLink.append(
    text(member.alerts || member.openQuestions || member.openFindings ? "Resolve next action" : "Continue review"),
  );
  card.append(head, next, meta, progress, counts, continueLink);
  return card;
}

/** @param {string} label @param {string | number} value @param {string} hint @param {string} tone */
function summaryStat(label, value, hint, tone) {
  const item = document.createElement("div");
  item.className = "prc-workspace-stat";
  item.dataset.tone = Number(value) > 0 ? tone : "quiet";
  const number = document.createElement("strong");
  number.append(text(String(value)));
  const name = document.createElement("span");
  name.append(text(label));
  const detail = document.createElement("small");
  detail.append(text(hint));
  item.append(number, name, detail);
  return item;
}

/** @param {string} label @param {string} tone */
function metaBadge(label, tone) {
  const badge = document.createElement("span");
  badge.className = "prc-workspace-badge";
  badge.dataset.tone = tone;
  badge.append(text(label));
  return badge;
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
el("prcWorkspaceTheme")?.addEventListener("click", () => {
  const current = String(el("prcWorkspaceTheme")?.dataset.themeChoice ?? "system");
  const next = themes[(themes.indexOf(current) + 1) % themes.length];
  saveTheme(next).catch(() => {});
});
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
  if (summary) {
    summary.classList.add("prc-workspace-summary-error");
    summary.textContent = `Could not update the workspace. ${String(error instanceof Error ? error.message : error)}`;
  }
}

/** @param {string} state @param {string} label */
function setPresence(state, label) {
  const presence = el("prcWorkspacePresence");
  if (!presence) return;
  presence.dataset.state = state;
  const dot = document.createElement("span");
  dot.className = "prc-presence-dot";
  dot.setAttribute("aria-hidden", "true");
  presence.replaceChildren(dot, text(label));
}

const source = new EventSource(`/workspace-events/${encodeURIComponent(accessId)}`);
source.addEventListener("workspace-changed", () => load().catch(showError));
source.addEventListener("state-sync", (event) => render(JSON.parse(/** @type {MessageEvent} */ (event).data)));
source.addEventListener("open", () => setPresence("listening", "Live updates"));
source.addEventListener("error", () => setPresence("working", "Reconnecting"));

if (bootstrap.syncTheme) saveTheme(String(bootstrap.theme ?? "system")).catch(() => {});
load().catch(showError);

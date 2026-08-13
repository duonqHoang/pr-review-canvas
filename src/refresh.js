import { canAutoAccept, describeDrift, reanchor } from "./anchor/drift.js";
import { fetchExistingThreads } from "./gh-threads.js";
import { newId } from "./session-store.js";
import { buildSnapshot, diffSnapshots } from "./snapshot.js";

/**
 * Refresh: re-fetch the PR and work out what that did to the review in progress.
 *
 * Two properties hold whatever happens here.
 *
 * **Nothing is ever deleted.** A draft whose anchor cannot be found is marked `stale`, which takes
 * it out of the next submission and puts it in front of the user; it is not removed, and its text is
 * not touched. The reviewer's prose exists nowhere else.
 *
 * **A draft comment is never silently moved.** Only two outcomes apply themselves: an anchor that
 * did not move at all, and a file that was renamed under an otherwise identical anchor. Every other
 * match is an inference, and an inference has to be signed off by the person whose name goes on the
 * review.
 *
 * Q&A threads are treated less strictly on purpose — see the `drift:apply` case in session-store.js.
 *
 * A successful fetch here is also the only thing that retracts a recoverable alert: `gh-auth-failed`
 * and `snapshot-fetch-failed` describe conditions rather than events, so they have to end when the
 * condition does, or the banner outlives the problem.
 */

/**
 * @typedef {object} RefreshSummary
 * @property {{ old: string, new: string, changed: boolean }} head
 * @property {{ changedPaths: string[], removedPaths: string[] }} files
 * @property {Record<import("./anchor/drift.js").DriftStatus, number>} driftCounts
 * @property {Array<{ id: string, path: string, line: number | null, status: string, detail: string }>} stale
 * @property {Array<{ id: string, path: string, line: number | null, from: number | null, to: number | null }>} moved
 * @property {import("./session-store.js").SessionAlert[]} alerts newly raised, if any
 * @property {boolean} threadsRefreshed
 */

/** @returns {Record<import("./anchor/drift.js").DriftStatus, number>} */
function emptyCounts() {
  return { unchanged: 0, moved: 0, ambiguous: 0, orphaned: 0, "file-gone": 0, "file-degraded": 0 };
}

/**
 * A PR state that means the review can no longer land. Raised as an alert because it is one of the
 * few things worth interrupting the agent for: every draft in the session has just become unpostable.
 *
 * @param {string} state
 * @returns {string | null}
 */
export function alertForPrState(state) {
  const value = String(state ?? "").toUpperCase();
  if (value === "MERGED") return "pr-merged";
  if (value === "CLOSED") return "pr-closed";
  return null;
}

/**
 * Which alert a failed fetch deserves, if any.
 *
 * Only two failures are worth waking an agent for. A lost `gh` login stops everything, including the
 * submit at the end, so the agent must stop promising one. A snapshot fetch that failed means the
 * diff on screen is stale in a way the user cannot see. A timeout or a rate limit is neither: it is
 * transient, the drafts are unaffected, and the next attempt is seconds away — reporting those as
 * alerts would train everyone to ignore the channel.
 *
 * @param {unknown} error
 * @returns {"gh-auth-failed" | "snapshot-fetch-failed" | null}
 */
export function alertForFetchError(error) {
  const code = String(/** @type {{ code?: unknown }} */ (error)?.code ?? "");
  if (code === "AUTH_ERROR") return "gh-auth-failed";
  if (code === "RATE_LIMITED") return null;
  return "snapshot-fetch-failed";
}

/**
 * Raise an alert unless one of the same kind is already on the session.
 *
 * Deduplicating by kind — not by "kind not yet delivered" — is what keeps the channel usable. An
 * expired `gh` token makes *every* request fail, so per-failure alerts would hand the agent the same
 * news dozens of times, and an agent that learns to skim alerts is an agent that misses the one that
 * mattered. The list is instead treated as the session's current trouble: `clearAlerts` removes an
 * entry once the condition it describes has gone away.
 *
 * @param {import("./session-store.js").SessionStore} store
 * @param {import("./session-store.js").Session} session
 * @param {string} kind
 * @param {string} detail
 * @returns {Promise<import("./session-store.js").SessionAlert | null>}
 */
export async function raiseAlert(store, session, kind, detail) {
  if (session.alerts.some((alert) => alert.kind === kind)) return null;
  const at = new Date().toISOString();
  /** @type {import("./session-store.js").SessionAlert} */
  const alert = { id: newId("al"), kind, detail, at, deliveredAt: null };
  await store.mutate(session.key, { op: "alert:add", at, payload: { alert } });
  return alert;
}

/** Kinds that describe a condition that can end, so a success has to retract them. */
export const RECOVERABLE_ALERTS = ["gh-auth-failed", "snapshot-fetch-failed"];

/**
 * Retract alerts whose condition has resolved.
 *
 * Without this the banner outlives the problem: a user re-runs `gh auth login`, everything works
 * again, and the page still says GitHub cannot be reached.
 *
 * @param {import("./session-store.js").SessionStore} store
 * @param {import("./session-store.js").Session} session
 * @param {string[]} [kinds]
 */
export async function clearAlerts(store, session, kinds = RECOVERABLE_ALERTS) {
  if (!session.alerts.some((alert) => kinds.includes(alert.kind))) return;
  await store.mutate(session.key, { op: "alert:clear", at: new Date().toISOString(), payload: { kinds } });
}

/**
 * @param {object} input
 * @param {import("./session-store.js").SessionStore} input.store
 * @param {import("./session-store.js").Session} input.session
 * @param {import("./snapshot.js").Snapshot | null} [input.previous] the snapshot on disk, for the
 *   changed-path report; absent just means the report is empty
 * @param {typeof buildSnapshot} [input.buildSnapshotImpl]
 * @param {typeof fetchExistingThreads | null} [input.fetchThreadsImpl] pass null to skip
 * @param {() => string} [input.now]
 * @returns {Promise<{ summary: RefreshSummary, snapshot: import("./snapshot.js").Snapshot,
 *   session: import("./session-store.js").Session }>}
 */
export async function refreshSession({
  store,
  session,
  previous,
  buildSnapshotImpl = buildSnapshot,
  fetchThreadsImpl = fetchExistingThreads,
  now = () => new Date().toISOString(),
}) {
  const ref = {
    host: session.pr.host,
    owner: session.pr.owner,
    repo: session.pr.repo,
    number: session.pr.number,
  };

  const snapshot = await buildSnapshotImpl(ref);
  // The fetch worked, so whatever was stopping it before is over. Retracting here rather than at the
  // end means a re-anchor that throws still clears a stale "GitHub is unreachable" banner.
  await clearAlerts(store, session);

  // Written before the re-anchor is recorded: a crash in between leaves the new diff on disk with
  // the old anchors, which is the state the next refresh already knows how to fix. The reverse order
  // would leave anchors pointing into a diff nobody has.
  await store.saveSnapshot(session.key, snapshot);

  let threadsRefreshed = false;
  if (fetchThreadsImpl) {
    try {
      await store.saveThreads(session.key, await fetchThreadsImpl(ref));
      threadsRefreshed = true;
    } catch {
      // Existing threads are context, not the review surface. A failure here must not cost the user
      // the re-anchor they asked for.
    }
  }

  const results = reanchorEverything(session, snapshot);
  const at = now();

  // Read out everything the report needs BEFORE committing. `store.load` returns the live session
  // object and the reducer mutates it in place, so after the commit `session.snapshotHeadSha` is the
  // new head and an auto-accepted comment's anchor is already the new anchor — a summary built from
  // it would report that nothing moved.
  const previousHead = session.snapshotHeadSha;
  /** @type {Map<string, { path: string, line: number | null, hasSuggestion: boolean }>} */
  const before = new Map(
    session.comments.map((comment) => [
      comment.id,
      {
        path: comment.anchor.path,
        line: comment.anchor.kind === "file" ? null : comment.anchor.line,
        hasSuggestion: Boolean(comment.suggestion),
      },
    ]),
  );

  const updated = await store.mutate(session.key, {
    op: "drift:apply",
    at,
    payload: { headSha: snapshot.headSha, comments: results.comments, threads: results.threads },
  });

  /** @type {import("./session-store.js").SessionAlert[]} */
  const alerts = [];
  const stateAlert = alertForPrState(snapshot.pr.state);
  // Raised once per session. Re-raising `pr-merged` on every refresh would wake the agent again for
  // a fact that has not changed since the last time it was told.
  if (stateAlert && !updated.alerts.some((alert) => alert.kind === stateAlert)) {
    const alert = {
      id: newId("al"),
      kind: stateAlert,
      detail: `${session.pr.ref} is ${snapshot.pr.state.toLowerCase()}`,
      at,
      deliveredAt: null,
    };
    await store.mutate(session.key, { op: "alert:add", at, payload: { alert } });
    alerts.push(alert);
  }

  const comparison = previous
    ? diffSnapshots(previous, snapshot)
    : { changedPaths: [], removedPaths: [], headChanged: previous === undefined };

  const counts = emptyCounts();
  /** @type {RefreshSummary["stale"]} */
  const stale = [];
  /** @type {RefreshSummary["moved"]} */
  const moved = [];
  for (const [id, result] of Object.entries(results.comments)) {
    counts[result.status] += 1;
    const was = before.get(id);
    const line = was?.line ?? null;
    const to = result.proposedAnchor && result.proposedAnchor.kind !== "file" ? result.proposedAnchor.line : null;
    if (result.status === "unchanged") continue;
    if (result.proposedAnchor) {
      moved.push({ id, path: result.proposedAnchor.path, line, from: line, to });
    }
    // Applied on its own means there is nothing for the user to do, so it is reported as a move and
    // not as something needing a decision.
    if (canAutoAccept(result, { hasSuggestion: was?.hasSuggestion })) continue;
    stale.push({ id, path: was?.path ?? "", line, status: result.status, detail: describeDrift(result) });
  }

  return {
    snapshot,
    session: await store.load(session.key).then((loaded) => loaded ?? updated),
    summary: {
      head: { old: previousHead, new: snapshot.headSha, changed: previousHead !== snapshot.headSha },
      files: { changedPaths: comparison.changedPaths, removedPaths: comparison.removedPaths },
      driftCounts: counts,
      stale,
      moved,
      alerts,
      threadsRefreshed,
    },
  };
}

/**
 * Re-anchor every drafted comment and every Q&A thread against a fresh snapshot.
 *
 * @param {import("./session-store.js").Session} session
 * @param {import("./anchor/drift.js").DiffLike} snapshot
 * @returns {{ comments: Record<string, import("./anchor/drift.js").DriftResult>,
 *   threads: Record<string, import("./anchor/drift.js").DriftResult> }}
 */
export function reanchorEverything(session, snapshot) {
  /** @type {Record<string, import("./anchor/drift.js").DriftResult>} */
  const comments = {};
  for (const comment of session.comments) {
    // A submitted comment lives on GitHub now; re-anchoring it locally would change nothing there
    // and would make an immutable record look editable.
    if (comment.state === "submitted") continue;
    comments[comment.id] = reanchor(comment.anchor, snapshot);
  }

  /** @type {Record<string, import("./anchor/drift.js").DriftResult>} */
  const threads = {};
  for (const thread of session.threads) {
    if (thread.status === "dismissed") continue;
    threads[thread.id] = reanchor(thread.anchor, snapshot);
  }
  return { comments, threads };
}

process.env.PR_REVIEW_CANVAS_HOST = "127.0.0.1";
process.env.PR_REVIEW_CANVAS_LINK_HOST = "127.0.0.1";

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { buildFingerprint, lineAt } from "../src/anchor/anchor.js";
import { buildSuggestion } from "../src/anchor/suggestion.js";
import { AxiError } from "../src/axi.js";
import { alertAdvice, createPollOutput, createRefreshOutput } from "../src/cli.js";
import { parseFileEntry } from "../src/diff/parse-patch.js";
import { alertForFetchError, alertForPrState } from "../src/refresh.js";
import { serve } from "../src/server.js";
import { newAccessId, newId, SessionStore } from "../src/session-store.js";

/**
 * Refresh over real HTTP, with the PR fetch injected.
 *
 * The interesting assertions are all about restraint: a draft is held out of a submission rather than
 * moved, its text is never altered, and the destination of a move comes from stored state rather than
 * from the request. The `gh` calls are seams, but the store, the journal, the reducer, the routes and
 * the arming path are all the real thing.
 */

const REF = { host: "github.com", owner: "o", repo: "r", number: 1 };
const HEAD_1 = "a".repeat(40);
const HEAD_2 = "c".repeat(40);
const KEY = "0123456789abcdef";
const FILE = "src/retry.ts";

const PATCH_1 = [
  "@@ -10,5 +10,6 @@ function retry(fn) {",
  "   let delay = base;",
  "   const jitter = random();",
  "+  log(delay);",
  "   delay = delay * jitter;",
  "   return delay;",
  " }",
].join("\n");

/** The same file after the author inserts two lines above the anchored one. */
const PATCH_2 = [
  "@@ -10,5 +10,8 @@ function retry(fn) {",
  "   let delay = base;",
  "   const jitter = random();",
  "+  assertFinite(base);",
  "+  assertFinite(jitter);",
  "+  log(delay);",
  "   delay = delay * jitter;",
  "   return delay;",
  " }",
].join("\n");

/** The same file with the anchored line rewritten, so nothing can be matched. */
const PATCH_GONE = PATCH_1.replace("+  log(delay);", "+  metrics.record(delay);");

/**
 * @param {string} patch
 * @param {string} headSha
 * @param {string} [state]
 * @param {string} [filename]
 */
function snapshotOf(patch, headSha, state = "OPEN", filename = FILE) {
  const file = parseFileEntry(
    /** @type {any} */ ({
      filename,
      status: filename === FILE ? "modified" : "renamed",
      previous_filename: filename === FILE ? undefined : FILE,
      additions: 3,
      deletions: 0,
      changes: 3,
      patch,
      sha: "b10b",
    }),
  );
  return {
    ref: REF,
    pr: {
      number: 1,
      title: "t",
      state,
      isDraft: false,
      headRefName: "h",
      baseRefName: "b",
      headSha,
      baseSha: "b".repeat(40),
      authorLogin: "a",
      url: "https://github.com/o/r/pull/1",
      changedFiles: 1,
      additions: 3,
      deletions: 0,
    },
    files: [file],
    byPath: new Map([[file.path, file]]),
    headSha,
    baseSha: "b".repeat(40),
    fetchedAt: new Date().toISOString(),
    fileCountCapped: false,
    counts: { files: 1, additions: 3, deletions: 0, binary: 0, withheld: 0, degraded: 0 },
  };
}

/**
 * A drafted comment on new line 12 of the first snapshot, built through the real anchor path so its
 * fingerprint is the one production would have stored.
 *
 * @param {any} snapshot
 * @param {{ suggestion?: boolean, range?: boolean }} [options]
 */
function draftOn(snapshot, options = {}) {
  const file = snapshot.byPath.get(FILE);
  const endLine = lineAt(file, "RIGHT", 12);
  assert.ok(endLine, "line 12 must be commentable");
  /** @type {any} */
  const anchor = {
    kind: "line",
    path: FILE,
    side: "RIGHT",
    line: 12,
    fingerprint: buildFingerprint({ file, endLine, headSha: snapshot.headSha }),
  };
  /** @type {any} */
  const comment = {
    id: newId("c"),
    anchor,
    body: "This needs a unit test.",
    fromThreadId: null,
    state: "draft",
    staleReason: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  if (options.suggestion) {
    const built = buildSuggestion({ file, side: "RIGHT", line: 12, replacementLines: ["  log(delay, jitter);"] });
    assert.ok(!("error" in built), "the suggestion fixture must build");
    comment.suggestion = built.suggestion;
  }
  return comment;
}

/**
 * @param {(ctx: any) => Promise<void>} body
 * @param {object} [options]
 * @param {any} [options.nextSnapshot] what the refresh fetch returns
 * @param {any} [options.comment]
 * @param {any} [options.thread]
 * @param {unknown} [options.fetchError] make the snapshot fetch throw this instead
 * @param {unknown} [options.headError] make the head check throw this instead
 */
async function withSession(body, options = {}) {
  const dir = await mkdtemp(path.join(tmpdir(), "prc-refresh-"));
  const store = new SessionStore({ env: { ...process.env, PR_REVIEW_CANVAS_STATE_DIR: dir } });
  const first = snapshotOf(PATCH_1, HEAD_1);
  const next = options.nextSnapshot ?? snapshotOf(PATCH_2, HEAD_2);

  const accessId = newAccessId();
  await store.upsert({
    ref: /** @type {any} */ (REF),
    key: KEY,
    accessId,
    url: `http://127.0.0.1/review/${accessId}`,
    displayRef: "o/r#1",
    headSha: HEAD_1,
  });
  await store.saveSnapshot(KEY, /** @type {any} */ (first));

  const comment = options.comment === undefined ? draftOn(first) : options.comment;
  if (comment) await store.mutate(KEY, { op: "comment:add", at: new Date().toISOString(), payload: { comment } });
  if (options.thread) {
    await store.mutate(KEY, { op: "thread:add", at: new Date().toISOString(), payload: { thread: options.thread } });
  }

  let fetches = 0;
  const server = await serve({
    port: 0,
    version: "9.9.9-test",
    idleTimeoutMs: null,
    store,
    seams: {
      buildSnapshotImpl: async () => {
        fetches += 1;
        if (options.fetchError) throw options.fetchError;
        return /** @type {any} */ (next);
      },
      // Existing threads are a separate fetch that must not be able to fail the refresh; skipped
      // here so the tests speak only about drift.
      fetchThreadsImpl: null,
      fetchPullRequestImpl: async () => {
        if (options.headError) throw options.headError;
        return /** @type {any} */ (next.pr);
      },
    },
  });
  const base = `http://127.0.0.1:${server.port}`;
  /** @param {string} suffix @param {RequestInit} [init] */
  const ui = (suffix, init = {}) =>
    fetch(`${base}/api/ui/s/${accessId}${suffix}`, {
      ...init,
      headers: { "content-type": "application/json", origin: base, .../** @type {any} */ (init.headers ?? {}) },
    });

  try {
    await body({ base, accessId, store, ui, comment, first, next, fetchCount: () => fetches });
  } finally {
    await server.close();
    await rm(dir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------

test("a push is reported by the head check without touching anything", async () => {
  await withSession(async ({ ui, store }) => {
    const response = await ui("/head");
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.changed, true);
    assert.equal(body.headSha, HEAD_2);
    assert.equal(body.snapshotHeadSha, HEAD_1);

    // Reporting is not acting: the session still describes the old commit and the draft is untouched.
    const session = await store.load(KEY);
    assert.equal(session?.snapshotHeadSha, HEAD_1);
    assert.equal(session?.comments[0].state, "draft");
  });
});

test("the head check is throttled, so a polling tab does not spend one gh call per poll", async () => {
  await withSession(async ({ ui, fetchCount }) => {
    const first = await (await ui("/head")).json();
    const second = await (await ui("/head")).json();
    assert.equal(first.stale, false);
    assert.equal(second.stale, true, "the second answer came from the cache");
    assert.equal(second.headSha, first.headSha);
    assert.equal(fetchCount(), 0, "a head check never builds a snapshot");
  });
});

test("refresh proposes a move and holds the comment out of the review until it is accepted", async () => {
  await withSession(async ({ ui, store, comment }) => {
    const summary = await (await ui("/refresh", { method: "POST" })).json();
    assert.equal(summary.head.changed, true);
    assert.equal(summary.head.new, HEAD_2);
    assert.equal(summary.stale.length, 1);
    assert.equal(summary.stale[0].status, "moved");

    const session = await store.load(KEY);
    const saved = session?.comments[0];
    assert.equal(saved?.state, "stale", "held out of any submission");
    assert.equal(saved?.driftStatus, "moved");
    // The user's anchor is left exactly as they made it, and their text is untouched.
    assert.equal(saved?.anchor.kind === "line" && saved.anchor.line, 12);
    assert.equal(saved?.body, comment.body);
    assert.equal(saved?.proposedAnchor?.kind === "line" && saved.proposedAnchor.line, 14);

    // Arming now sees no drafts at all, which is the point of `stale`.
    const armed = await ui("/submit/arm", { method: "POST", body: JSON.stringify({ verdict: "COMMENT", body: "s" }) });
    assert.equal(armed.status, 200);
    assert.equal((await armed.json()).comments, 0);
  });
});

test("accepting a proposal moves the comment and puts it back in the review", async () => {
  await withSession(async ({ ui, store, comment }) => {
    await ui("/refresh", { method: "POST" });
    const accepted = await ui(`/comments/${comment.id}/drift/accept`, { method: "POST" });
    assert.equal(accepted.status, 200);

    const session = await store.load(KEY);
    const saved = session?.comments[0];
    assert.equal(saved?.state, "draft");
    assert.equal(saved?.anchor.kind === "line" && saved.anchor.line, 14);
    assert.equal(saved?.proposedAnchor, undefined, "the proposal is consumed, not left lying around");
    assert.equal(saved?.driftStatus, undefined);
    assert.equal(saved?.staleReason, null);
    // The fingerprint is rebuilt at the new head, so the next refresh does not re-report the move.
    assert.equal(saved?.anchor.kind === "line" && saved.anchor.fingerprint.headSha, HEAD_2);

    const armed = await ui("/submit/arm", { method: "POST", body: JSON.stringify({ verdict: "COMMENT", body: "s" }) });
    assert.equal((await armed.json()).comments, 1);
  });
});

test("declining a proposal leaves the comment where it was, and out of the review", async () => {
  await withSession(async ({ ui, store, comment }) => {
    await ui("/refresh", { method: "POST" });
    const response = await ui(`/comments/${comment.id}/drift/dismiss`, { method: "POST" });
    assert.equal(response.status, 200);

    const session = await store.load(KEY);
    const saved = session?.comments[0];
    assert.equal(saved?.state, "stale", "declining a move does not make it submittable");
    assert.equal(saved?.anchor.kind === "line" && saved.anchor.line, 12);
    assert.equal(saved?.proposedAnchor, undefined);
    assert.ok(saved?.staleReason, "the reason survives so the strip still explains itself");
  });
});

test("a comment whose line is gone is marked stale with no proposal at all", async () => {
  await withSession(
    async ({ ui, store }) => {
      const summary = await (await ui("/refresh", { method: "POST" })).json();
      assert.equal(summary.stale.length, 1);
      assert.equal(summary.stale[0].status, "orphaned");
      assert.equal(summary.moved.length, 0);

      const saved = (await store.load(KEY))?.comments[0];
      assert.equal(saved?.state, "stale");
      assert.equal(saved?.proposedAnchor, undefined);
      // Nothing to accept means the only routes forward are rewriting or deleting it — both the
      // user's call. Accepting must refuse rather than invent a destination.
      const refused = await ui(`/comments/${saved?.id}/drift/accept`, { method: "POST" });
      assert.equal(refused.status, 409);
    },
    { nextSnapshot: snapshotOf(PATCH_GONE, HEAD_2) },
  );
});

test("a rename is applied on its own, because a pure rename is the one certain move", async () => {
  await withSession(
    async ({ ui, store }) => {
      const summary = await (await ui("/refresh", { method: "POST" })).json();
      assert.equal(summary.stale.length, 0, "nothing needs a decision");

      const saved = (await store.load(KEY))?.comments[0];
      assert.equal(saved?.state, "draft");
      assert.equal(saved?.anchor.path, "src/retry-with-jitter.ts");
      assert.equal(saved?.anchor.kind === "line" && saved.anchor.line, 12);
    },
    { nextSnapshot: snapshotOf(PATCH_1, HEAD_2, "OPEN", "src/retry-with-jitter.ts") },
  );
});

test("a renamed file carrying a suggestion still needs a human", async () => {
  const first = snapshotOf(PATCH_1, HEAD_1);
  await withSession(
    async ({ ui, store }) => {
      await ui("/refresh", { method: "POST" });
      const saved = (await store.load(KEY))?.comments[0];
      // Same certainty as the previous test, opposite outcome: a suggestion rewrites code, so it is
      // never re-pointed without someone looking.
      assert.equal(saved?.state, "stale");
      assert.equal(saved?.proposedAnchor?.path, "src/retry-with-jitter.ts");
    },
    {
      comment: draftOn(first, { suggestion: true }),
      nextSnapshot: snapshotOf(PATCH_1, HEAD_2, "OPEN", "src/retry-with-jitter.ts"),
    },
  );
});

test("accepting a proposal rebuilds a suggestion's base lines rather than carrying the old ones", async () => {
  const first = snapshotOf(PATCH_1, HEAD_1);
  await withSession(
    async ({ ui, store }) => {
      const before = (await store.load(KEY))?.comments[0];
      const baseHashBefore = before?.suggestion?.baseHash;
      await ui("/refresh", { method: "POST" });
      const response = await ui(`/comments/${before?.id}/drift/accept`, { method: "POST" });
      assert.equal(response.status, 200);

      const saved = (await store.load(KEY))?.comments[0];
      assert.equal(saved?.state, "draft");
      assert.equal(saved?.anchor.kind === "line" && saved.anchor.line, 14);
      // The replacement text is the user's and must survive verbatim; the base is derived from the
      // file and must be re-derived, or the suggestion would apply against lines that moved.
      assert.deepEqual(saved?.suggestion?.replacementLines, ["  log(delay, jitter);"]);
      assert.deepEqual(saved?.suggestion?.baseLines, ["  log(delay);"]);
      assert.equal(saved?.suggestion?.baseHash, baseHashBefore, "same base text at the new line");
    },
    { comment: draftOn(first, { suggestion: true }) },
  );
});

test("the browser cannot name where a comment moves to", async () => {
  await withSession(async ({ ui, store, comment }) => {
    await ui("/refresh", { method: "POST" });
    // A body naming a line is simply ignored: the destination comes from the stored proposal, so no
    // request from the page can put a comment somewhere the drift cascade never sanctioned.
    await ui(`/comments/${comment.id}/drift/accept`, {
      method: "POST",
      body: JSON.stringify({ anchor: { kind: "line", path: FILE, side: "RIGHT", line: 999 } }),
    });
    const saved = (await store.load(KEY))?.comments[0];
    assert.equal(saved?.anchor.kind === "line" && saved.anchor.line, 14);
  });
});

test("a merged PR raises an alert once, and the alert is delivered to the agent exactly once", async () => {
  await withSession(
    async ({ ui, store, base }) => {
      const summary = await (await ui("/refresh", { method: "POST" })).json();
      assert.deepEqual(
        summary.alerts.map((/** @type {any} */ alert) => alert.kind),
        ["pr-merged"],
      );

      // A second refresh must not re-raise it: the fact has not changed since the agent was told.
      const again = await (await ui("/refresh", { method: "POST" })).json();
      assert.deepEqual(again.alerts, []);
      assert.equal((await store.load(KEY))?.alerts.length, 1);

      // The agent's poll returns it without blocking, and then stops returning it — an alert that
      // kept coming back would turn every long-poll into an instant return forever.
      const first = await (await fetch(`${base}/api/agent/poll?key=${KEY}&timeoutMs=0`)).json();
      assert.equal(first.status, "work");
      assert.deepEqual(
        first.alerts.map((/** @type {any} */ alert) => alert.kind),
        ["pr-merged"],
      );
      const second = await (await fetch(`${base}/api/agent/poll?key=${KEY}&timeoutMs=0`)).json();
      assert.equal(second.status, "waiting");

      // The browser keeps seeing it, because it is the only place the user learns about it.
      const hydrated = await (await ui("")).json();
      assert.equal(hydrated.session.alerts.length, 1);
    },
    { nextSnapshot: snapshotOf(PATCH_1, HEAD_2, "MERGED") },
  );
});

test("a question follows a merely-probable move that a comment would not", async () => {
  const first = snapshotOf(PATCH_1, HEAD_1);
  const file = first.byPath.get(FILE);
  const endLine = lineAt(/** @type {any} */ (file), "RIGHT", 12);
  const thread = {
    id: newId("q"),
    anchor: {
      kind: "line",
      path: FILE,
      side: "RIGHT",
      line: 12,
      fingerprint: buildFingerprint({
        file: /** @type {any} */ (file),
        endLine: /** @type {any} */ (endLine),
        headSha: HEAD_1,
      }),
    },
    messages: [{ role: "user", text: "why?", at: new Date().toISOString() }],
    status: "open",
    promotedCommentId: null,
    createdAt: new Date().toISOString(),
  };
  await withSession(
    async ({ ui, store }) => {
      await ui("/refresh", { method: "POST" });
      const saved = (await store.load(KEY))?.threads[0];
      // Nothing is posted from a question, so the cost of following a probable match is a card a few
      // lines off — not a review comment on code the reviewer never read.
      assert.equal(saved?.anchor.kind === "line" && saved.anchor.line, 14);
      assert.equal(saved?.driftStatus, undefined);
    },
    { comment: null, thread },
  );
});

test("refresh needs no drafts at all and still records the new head", async () => {
  await withSession(
    async ({ ui, store }) => {
      const summary = await (await ui("/refresh", { method: "POST" })).json();
      assert.equal(summary.head.changed, true);
      assert.deepEqual(summary.stale, []);
      assert.equal((await store.load(KEY))?.snapshotHeadSha, HEAD_2);
    },
    { comment: null },
  );
});

test("the agent's refresh and the browser's do the same work", async () => {
  await withSession(async ({ base, store, comment }) => {
    const response = await fetch(`${base}/api/agent/sessions/${KEY}/refresh`, { method: "POST" });
    assert.equal(response.status, 200);
    const summary = await response.json();
    assert.equal(summary.stale.length, 1);
    const saved = (await store.load(KEY))?.comments.find((/** @type {any} */ c) => c.id === comment.id);
    assert.equal(saved?.state, "stale");
    assert.equal(saved?.proposedAnchor?.kind === "line" && saved.proposedAnchor.line, 14);
  });
});

test("refresh refuses a cross-origin request like every other mutation", async () => {
  await withSession(async ({ base, accessId }) => {
    const response = await fetch(`${base}/api/ui/s/${accessId}/refresh`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: "http://evil.example" },
    });
    assert.equal(response.status, 403);
  });
});

// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------

test("alertForPrState only fires on the two states that end a review", () => {
  assert.equal(alertForPrState("MERGED"), "pr-merged");
  assert.equal(alertForPrState("CLOSED"), "pr-closed");
  assert.equal(alertForPrState("OPEN"), null);
  assert.equal(alertForPrState(""), null);
});

test("the refresh output tells the agent not to re-anchor anything itself", () => {
  const output = /** @type {any} */ (
    createRefreshOutput(/** @type {any} */ (REF), {
      head: { old: HEAD_1, new: HEAD_2, changed: true },
      files: { changedPaths: [FILE], removedPaths: [] },
      driftCounts: { unchanged: 2, moved: 1, ambiguous: 0, orphaned: 1, "file-gone": 0, "file-degraded": 0 },
      stale: [
        { id: "c_1", path: FILE, line: 12, status: "moved", detail: "moved (90% confident)" },
        { id: "c_2", path: FILE, line: 40, status: "orphaned", detail: "the anchored code is no longer in the diff" },
      ],
      moved: [{ id: "c_1", path: FILE, line: 12, from: 12, to: 14 }],
      alerts: [],
      threadsRefreshed: true,
    })
  );
  assert.equal(output.drafts.needs_review, 2);
  assert.deepEqual(
    output.stale.map((/** @type {any} */ entry) => entry.at),
    [`${FILE}:12`, `${FILE}:40`],
  );
  assert.match(output.next_step, /Do NOT re-anchor or rewrite anything yourself/);
});

test("an unchanged head with clean anchors says so plainly", () => {
  const output = /** @type {any} */ (
    createRefreshOutput(/** @type {any} */ (REF), {
      head: { old: HEAD_1, new: HEAD_1, changed: false },
      files: { changedPaths: [], removedPaths: [] },
      driftCounts: { unchanged: 3, moved: 0, ambiguous: 0, orphaned: 0, "file-gone": 0, "file-degraded": 0 },
      stale: [],
      moved: [],
      alerts: [],
      threadsRefreshed: true,
    })
  );
  assert.equal(output.stale, undefined);
  assert.match(output.next_step, /Nothing moved/);
});

// ---------------------------------------------------------------------------
// Failures that are worth waking an agent for, and ones that are not
// ---------------------------------------------------------------------------

test("a lost gh login raises an alert from the head check alone", async () => {
  await withSession(
    async ({ ui, store, base }) => {
      const response = await ui("/head");
      // Not knowing the head is not an error: the page is fine, the diff is just possibly stale.
      assert.equal(response.status, 200);
      assert.equal((await response.json()).headSha, null);

      const alerts = /** @type {any[]} */ ((await store.load(KEY))?.alerts ?? []);
      assert.deepEqual(
        alerts.map((/** @type {any} */ alert) => alert.kind),
        ["gh-auth-failed"],
      );
      assert.match(String(alerts[0].detail), /gh auth login/);

      // And the agent hears about it, because the same failure will stop the submit at the end.
      const poll = await (await fetch(`${base}/api/agent/poll?key=${KEY}&timeoutMs=0`)).json();
      assert.equal(poll.status, "work");
      assert.equal(poll.alerts[0].kind, "gh-auth-failed");
    },
    { headError: new AxiError("GitHub CLI is not authenticated", "AUTH_ERROR", ["Run `gh auth login`"]) },
  );
});

test("a rate limit raises nothing, because it is transient and the drafts are fine", async () => {
  await withSession(
    async ({ ui, store }) => {
      assert.equal((await ui("/head")).status, 200);
      const failed = await ui("/refresh", { method: "POST" });
      assert.equal(failed.status, 500, "the refresh still fails loudly to its caller");
      // No alert: an agent that learns to skim this channel is an agent that misses the one that
      // mattered, and a limit that resets in a minute does not belong in it.
      assert.deepEqual((await store.load(KEY))?.alerts, []);
    },
    {
      headError: new AxiError("rate limited", "RATE_LIMITED", []),
      fetchError: new AxiError("rate limited", "RATE_LIMITED", []),
    },
  );
});

test("a failed re-fetch is raised once and retracted by the next success", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "prc-refresh-alerts-"));
  const store = new SessionStore({ env: { ...process.env, PR_REVIEW_CANVAS_STATE_DIR: dir } });
  const first = snapshotOf(PATCH_1, HEAD_1);
  const accessId = newAccessId();
  await store.upsert({
    ref: /** @type {any} */ (REF),
    key: KEY,
    accessId,
    url: `http://127.0.0.1/review/${accessId}`,
    displayRef: "o/r#1",
    headSha: HEAD_1,
  });
  await store.saveSnapshot(KEY, /** @type {any} */ (first));

  let failing = true;
  const server = await serve({
    port: 0,
    version: "9.9.9-test",
    idleTimeoutMs: null,
    store,
    seams: {
      buildSnapshotImpl: async () => {
        if (failing) throw new Error("network is down");
        return /** @type {any} */ (snapshotOf(PATCH_2, HEAD_2));
      },
      fetchThreadsImpl: null,
      fetchPullRequestImpl: async () => /** @type {any} */ (snapshotOf(PATCH_2, HEAD_2).pr),
    },
  });
  const base = `http://127.0.0.1:${server.port}`;
  const refresh = () =>
    fetch(`http://127.0.0.1:${server.port}/api/ui/s/${accessId}/refresh`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: base },
    });

  try {
    assert.equal((await refresh()).status, 500);
    assert.equal((await refresh()).status, 500);
    // Twice failed, once raised: every request fails while the network is down, and one alert per
    // failure would bury the agent in identical news.
    assert.deepEqual(
      (await store.load(KEY))?.alerts.map((alert) => alert.kind),
      ["snapshot-fetch-failed"],
    );

    failing = false;
    assert.equal((await refresh()).status, 200);
    // Retracted, not merely marked delivered: the banner must not outlive the problem.
    assert.deepEqual((await store.load(KEY))?.alerts, []);
  } finally {
    await server.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("alertForFetchError separates the two failures worth reporting from the rest", () => {
  assert.equal(alertForFetchError(new AxiError("x", "AUTH_ERROR", [])), "gh-auth-failed");
  assert.equal(alertForFetchError(new AxiError("x", "RATE_LIMITED", [])), null);
  assert.equal(alertForFetchError(new Error("socket hang up")), "snapshot-fetch-failed");
});

test("alertAdvice tells the agent to stop rather than to work around it", () => {
  assert.match(alertAdvice([{ kind: "pr-merged", detail: "" }]), /do not submit/);
  assert.match(alertAdvice([{ kind: "gh-auth-failed", detail: "" }]), /gh auth login/);
  assert.match(alertAdvice([{ kind: "snapshot-fetch-failed", detail: "" }]), /out of date/);
  // An unknown kind still produces advice rather than an empty string, because a poll that reported
  // an alert with no guidance would read as a bug in the tool.
  assert.match(alertAdvice([{ kind: "something-new", detail: "" }]), /verbatim/);
});

// ---------------------------------------------------------------------------
// A submit request that can no longer be carried out
// ---------------------------------------------------------------------------

test("cancelling an arming also withdraws the queued submit request", async () => {
  await withSession(async ({ ui, store, base }) => {
    const armed = await ui("/submit/arm", { method: "POST", body: JSON.stringify({ verdict: "COMMENT", body: "s" }) });
    assert.equal(armed.status, 200);
    assert.equal(
      (await store.load(KEY))?.work.filter((/** @type {any} */ item) => item.kind === "submit_requested").length,
      1,
    );

    await ui("/submit/cancel", { method: "POST" });
    // Clearing only `session.submit` used to leave the work item on disk, so a later poll handed the
    // agent an instruction with a null token — which it would carry out and then report as the user's
    // review having been rejected.
    assert.deepEqual((await store.load(KEY))?.work, []);

    const poll = await (await fetch(`${base}/api/agent/poll?key=${KEY}&timeoutMs=0`)).json();
    assert.equal(poll.status, "waiting");
  });
});

test("a submit request whose token was lost is withdrawn rather than handed over", async () => {
  await withSession(async ({ ui, store, base }) => {
    await ui("/submit/arm", { method: "POST", body: JSON.stringify({ verdict: "COMMENT", body: "s" }) });

    // What a server restart between the click and the poll leaves: the work item is durable, the raw
    // token is not — it lives only in memory, on purpose, so no live token is ever written to disk.
    // Simulated by draining the token the same way a delivery does.
    const first = await (await fetch(`${base}/api/agent/poll?key=${KEY}&timeoutMs=0`)).json();
    assert.equal(typeof first.token, "string");
    await store.mutate(KEY, {
      op: "work:add",
      at: new Date().toISOString(),
      payload: { item: { uid: "w_replay", kind: "submit_requested", at: new Date().toISOString() } },
    });

    const second = await (await fetch(`${base}/api/agent/poll?key=${KEY}&timeoutMs=0`)).json();
    assert.equal(second.status, "work");
    assert.equal(second.token, undefined);
    assert.equal(second.submitStale, true);
    assert.deepEqual(second.work, [], "an unusable instruction is dropped, not delivered");

    const output = /** @type {any} */ (createPollOutput(/** @type {any} */ (REF), second));
    assert.equal(output.submit.status, "stale");
    assert.match(output.next_step, /click Submit again/);
    assert.match(output.next_step, /Nothing was posted and no drafts were lost/);
  });
});

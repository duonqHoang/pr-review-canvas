import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { fetchReviewThreads, flattenPages } from "../src/gh-fetch.js";
import {
  fetchExistingThreads,
  mergeThreads,
  placementFor,
  summarizeThreads,
  threadsByPath,
} from "../src/gh-threads.js";

/**
 * Existing threads come from two APIs that disagree about what a thread is, so these tests are about
 * the join being right — and about the degraded path, because GraphQL is the half that fails.
 *
 * The `pr-14003` fixture is a recorded `cli/cli` pull request chosen because it has all three shapes
 * that matter at once: threaded replies, resolved threads, and comments whose `line` has gone null
 * because the code moved. Re-record with:
 *   gh api --paginate --slurp "repos/cli/cli/pulls/14003/comments?per_page=100&sort=created&direction=asc"
 *   gh api graphql -f query='…reviewThreads…'
 */

const here = path.dirname(fileURLToPath(import.meta.url));
/** @param {string} name */
const raw = (name) => JSON.parse(readFileSync(path.join(here, "fixtures", "live", name), "utf8"));
/** @param {string} name */
const live = (name) => flattenPages(raw(name));

/** @type {import("../src/gh-fetch.js").GhReviewComment[]} */
const comments200 = live("pr-200.comments.json");
/** @type {import("../src/gh-fetch.js").GhReviewComment[]} */
const comments14003 = live("pr-14003.comments.json");

/**
 * The recorded GraphQL response, parsed by the real `fetchReviewThreads` rather than re-mapped here.
 * Testing the fixture through the production parser is the only way the fixture proves anything about
 * the code that will actually read it.
 */
const threads14003 = await fetchReviewThreads(/** @type {any} */ ({ owner: "cli", repo: "cli", number: 14003 }), {
  ghJsonImpl: async () => raw("pr-14003.threads.json"),
});

test("the recorded PR has replies, resolved threads and outdated comments", () => {
  assert.equal(comments14003.length, 7);
  assert.equal(
    comments14003.filter((comment) => comment.in_reply_to_id != null).length,
    2,
    "the fixture must contain threaded replies",
  );
  assert.equal(comments14003.filter((comment) => comment.line == null).length, 2, "…and outdated comments");
  assert.equal(threads14003.length, 5);
  assert.equal(threads14003.filter((thread) => thread.isResolved).length, 5);
  assert.equal(threads14003.filter((thread) => thread.isOutdated).length, 2);
  // Every GraphQL thread must expose the REST id the join depends on.
  for (const thread of threads14003) assert.ok(thread.rootCommentId != null, `${thread.id} has no rootCommentId`);
});

test("replies join onto their root comment, not into threads of their own", () => {
  const threads = mergeThreads({ comments: comments14003, reviewThreads: threads14003 });
  const roots = new Set(comments14003.filter((c) => c.in_reply_to_id == null).map((c) => Number(c.id)));
  // One thread per root comment, and every reply landed inside one.
  assert.equal(threads.length, roots.size);
  assert.equal(threads.length, 5);
  const grouped = threads.reduce((total, thread) => total + thread.comments.length, 0);
  assert.equal(grouped, comments14003.length);
  for (const thread of threads) assert.ok(roots.has(thread.rootCommentId));
  // Two threads hold two comments each, matching what GraphQL reported.
  assert.equal(threads.filter((thread) => thread.comments.length === 2).length, 2);
});

test("the GraphQL join lands on the right thread, not just the right count", () => {
  const threads = mergeThreads({ comments: comments14003, reviewThreads: threads14003 });
  for (const thread of threads) {
    const state = threads14003.find((candidate) => Number(candidate.rootCommentId) === thread.rootCommentId);
    assert.ok(state, `no GraphQL state joined for root ${thread.rootCommentId}`);
    assert.equal(thread.id, state.id);
    assert.equal(thread.isResolved, state.isResolved);
    assert.equal(thread.isOutdated, state.isOutdated);
    assert.equal(thread.resolvedStateKnown, true);
    // The two APIs must also agree about where the thread is.
    assert.equal(thread.path, state.path);
  }
});

test("every outdated thread in the real fixture is kept out of the inline placement", () => {
  const threads = mergeThreads({ comments: comments14003, reviewThreads: threads14003 });
  const outdated = threads.filter((thread) => thread.isOutdated);
  assert.equal(outdated.length, 2);
  for (const thread of outdated) {
    assert.equal(placementFor(thread).placement, "file-list");
    // The original position is retained, so the UI can still say where it used to be.
    assert.ok(thread.originalLine != null || thread.diffHunk.length > 0);
  }
});

test("comments inside a thread are oldest first", () => {
  for (const thread of mergeThreads({ comments: comments14003, reviewThreads: threads14003 })) {
    const dates = thread.comments.map((comment) => comment.createdAt);
    assert.deepEqual(dates, [...dates].sort(), `thread ${thread.id} is out of order`);
  }
});

test("GraphQL supplies resolved and outdated; without it they are reported as unknown", () => {
  const root = comments200.find((comment) => comment.in_reply_to_id == null);
  assert.ok(root);
  const withState = mergeThreads({
    comments: [root],
    reviewThreads: [
      {
        id: "PRRT_kwabc",
        isResolved: true,
        isOutdated: false,
        isCollapsed: true,
        path: root.path,
        line: root.line ?? null,
        startLine: null,
        diffSide: "RIGHT",
        rootCommentId: Number(root.id),
      },
    ],
  });
  assert.equal(withState[0].id, "PRRT_kwabc");
  assert.equal(withState[0].isResolved, true);
  assert.equal(withState[0].resolvedStateKnown, true);

  // GraphQL unavailable: the thread still renders, and the flag is explicitly *not* claimed.
  const degraded = mergeThreads({ comments: [root], reviewThreads: [], graphqlAvailable: false });
  assert.equal(degraded[0].id, `rest:${root.id}`);
  assert.equal(degraded[0].isResolved, false);
  assert.equal(degraded[0].resolvedStateKnown, false);
});

test("`line: null` with an original_line means outdated, even with no GraphQL", () => {
  /** @type {any} */
  const outdated = {
    id: 9001,
    path: "src/a.js",
    body: "this moved",
    line: null,
    original_line: 42,
    side: "RIGHT",
    diff_hunk: "@@ -40,3 +40,3 @@",
    created_at: "2026-01-01T00:00:00Z",
    user: { login: "someone" },
  };
  const [thread] = mergeThreads({ comments: [outdated], graphqlAvailable: false });
  assert.equal(thread.isOutdated, true);
  assert.equal(thread.line, null);
  assert.equal(thread.originalLine, 42);
  // And it is not placed inline: there is no line on the current diff that is honestly its anchor.
  assert.deepEqual(placementFor(thread), { placement: "file-list", reason: "outdated" });
});

test("GraphQL wins on outdated when it is available, since it is the authority", () => {
  /** @type {any} */
  const root = {
    id: 1,
    path: "src/a.js",
    body: "x",
    line: 10,
    original_line: 10,
    side: "RIGHT",
    created_at: "2026-01-01T00:00:00Z",
    user: { login: "u" },
  };
  const [thread] = mergeThreads({
    comments: [root],
    reviewThreads: [
      {
        id: "T1",
        isResolved: false,
        isOutdated: true,
        isCollapsed: false,
        path: "src/a.js",
        line: 10,
        startLine: null,
        diffSide: "RIGHT",
        rootCommentId: 1,
      },
    ],
  });
  // REST would have said "in the diff"; GraphQL says the thread is outdated, and it knows.
  assert.equal(thread.isOutdated, true);
});

test("a file-level thread is listed per file, never pinned to a line", () => {
  /** @type {any} */
  const fileComment = {
    id: 5,
    path: "src/a.js",
    body: "whole file",
    subject_type: "file",
    created_at: "2026-01-01T00:00:00Z",
    user: { login: "u" },
  };
  const [thread] = mergeThreads({ comments: [fileComment] });
  assert.equal(thread.subjectType, "file");
  assert.deepEqual(placementFor(thread), { placement: "file-list", reason: "file-level" });
});

test("an in-diff thread is placed inline at its current line and side", () => {
  /** @type {any} */
  const root = {
    id: 7,
    path: "src/a.js",
    body: "here",
    line: 12,
    side: "LEFT",
    original_line: 9,
    created_at: "2026-01-01T00:00:00Z",
    user: { login: "u" },
  };
  const [thread] = mergeThreads({ comments: [root] });
  assert.deepEqual(placementFor(thread), { placement: "inline", line: 12, side: "LEFT" });
});

test("threads group by path and summarize by state", () => {
  const threads = mergeThreads({ comments: [...comments200, ...comments14003], reviewThreads: threads14003 });
  const byPath = threadsByPath(threads);
  for (const [filePath, list] of byPath) {
    for (const thread of list) assert.equal(thread.path, filePath);
  }
  const summary = summarizeThreads(threads);
  assert.equal(summary.total, threads.length);
  assert.equal(summary.resolved + summary.unresolved, summary.total);
});

test("a GraphQL failure degrades to REST instead of losing every thread", async () => {
  const result = await fetchExistingThreads(
    /** @type {any} */ ({ host: "github.com", owner: "o", repo: "r", number: 1 }),
    {
      fetchLineCommentsImpl: async () => comments200,
      fetchReviewThreadsImpl: async () => {
        throw new Error("GraphQL: Resource not accessible by integration");
      },
      now: () => "2026-01-01T00:00:00.000Z",
    },
  );
  assert.equal(result.graphqlAvailable, false);
  assert.match(String(result.graphqlError), /not accessible/);
  assert.ok(result.threads.length > 0, "threads must survive a GraphQL failure");
  for (const thread of result.threads) assert.equal(thread.resolvedStateKnown, false);
});

test("a REST failure is fatal, because there is nothing left to show", async () => {
  await assert.rejects(
    () =>
      fetchExistingThreads(/** @type {any} */ ({ host: "github.com", owner: "o", repo: "r", number: 1 }), {
        fetchLineCommentsImpl: async () => {
          throw new Error("rate limited");
        },
        fetchReviewThreadsImpl: async () => [],
      }),
    /rate limited/,
  );
});

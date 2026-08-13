process.env.PR_REVIEW_CANVAS_HOST = "127.0.0.1";
process.env.PR_REVIEW_CANVAS_LINK_HOST = "127.0.0.1";

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { hashBaseLines } from "../src/anchor/suggestion.js";
import { parseFileEntry } from "../src/diff/parse-patch.js";
import { serve } from "../src/server.js";
import { newAccessId, SessionStore, submitDigest } from "../src/session-store.js";

/**
 * The suggestion and promote routes over real HTTP.
 *
 * The synthetic diff below is deliberately tiny and hand-checked, because these tests are about
 * *which* lines a suggestion claims to replace — a property that a large recorded fixture would
 * make harder, not easier, to verify by eye.
 */

const REF = { host: "github.com", owner: "o", repo: "r", number: 1 };
const HEAD = "a".repeat(40);
const KEY = "0123456789abcdef";

/** GitHub refuses a COMMENT review with no body, so every arm that is meant to succeed carries one. */
const SUMMARY = "Overall notes for the author.";

/**
 * ```
 *   1  const a = 1;      context, RIGHT 1
 *   2  const b = 2;      context, RIGHT 2
 *   -  const c = 3;      deletion, LEFT 3
 *   3  const c = 33;     addition, RIGHT 3
 *   4  const d = 4;      addition, RIGHT 4
 *   5  end;              context, RIGHT 5
 * ```
 */
const PATCH = [
  "@@ -1,4 +1,5 @@",
  " const a = 1;",
  " const b = 2;",
  "-const c = 3;",
  "+const c = 33;",
  "+const d = 4;",
  " end;",
].join("\n");

/** @param {(ctx: any) => Promise<void>} body */
async function withSession(body) {
  const dir = await mkdtemp(path.join(tmpdir(), "prc-sg-"));
  const store = new SessionStore({ env: { ...process.env, PR_REVIEW_CANVAS_STATE_DIR: dir } });
  const file = parseFileEntry(
    /** @type {any} */ ({
      filename: "src/a.js",
      status: "modified",
      additions: 2,
      deletions: 1,
      changes: 3,
      patch: PATCH,
      sha: "b10b",
    }),
  );
  const snapshot = {
    ref: REF,
    pr: {
      number: 1,
      title: "t",
      state: "OPEN",
      isDraft: false,
      headRefName: "h",
      baseRefName: "b",
      headSha: HEAD,
      baseSha: "b".repeat(40),
      authorLogin: "a",
      url: "https://github.com/o/r/pull/1",
      changedFiles: 1,
      additions: 2,
      deletions: 1,
      mergeable: "MERGEABLE",
      merged: false,
    },
    files: [file],
    byPath: new Map([[file.path, file]]),
    headSha: HEAD,
    baseSha: "b".repeat(40),
    fetchedAt: new Date().toISOString(),
    fileCountCapped: false,
    counts: { files: 1, additions: 2, deletions: 1, binary: 0, withheld: 0, degraded: 0 },
  };

  const accessId = newAccessId();
  await store.upsert({
    ref: /** @type {any} */ (REF),
    key: KEY,
    accessId,
    url: `http://127.0.0.1/review/${accessId}`,
    displayRef: "o/r#1",
    headSha: HEAD,
  });
  await store.saveSnapshot(KEY, /** @type {any} */ (snapshot));

  const server = await serve({ port: 0, version: "9.9.9-test", idleTimeoutMs: null, store });
  const base = `http://127.0.0.1:${server.port}`;
  /**
   * @param {string} suffix
   * @param {RequestInit} [init]
   */
  const ui = (suffix, init = {}) =>
    fetch(`${base}/api/ui/s/${accessId}${suffix}`, {
      ...init,
      headers: {
        "content-type": "application/json",
        origin: base,
        .../** @type {Record<string, string>} */ (init.headers ?? {}),
      },
    });
  /**
   * @param {string} suffix
   * @param {unknown} [payload]
   */
  const agent = (suffix, payload) =>
    fetch(`${base}${suffix}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload ?? {}),
    });

  try {
    await body({ base, accessId, key: KEY, store, ui, agent, snapshot });
  } finally {
    await server.close();
    await rm(dir, { recursive: true, force: true });
  }
}

test("the suggestion base reports the lines that would be replaced", async () => {
  await withSession(async ({ ui }) => {
    const single = await (await ui("/suggestion-base/0?line=3")).json();
    assert.deepEqual(single.lines, ["const c = 33;"]);
    assert.equal(single.eol, "LF");
    assert.equal(single.noNewlineAtEof, false);

    const range = await (await ui("/suggestion-base/0?line=4&startLine=3")).json();
    assert.deepEqual(range.lines, ["const c = 33;", "const d = 4;"]);

    // Line 3 on the LEFT side is the deletion; a suggestion cannot replace it, and the base
    // endpoint is RIGHT-only by construction.
    const outside = await ui("/suggestion-base/0?line=99");
    assert.equal(outside.status, 422);
    assert.match((await outside.json()).error, /not all part of the diff/);
  });
});

test("a drafted suggestion is built on the server, never taken from the request", async () => {
  await withSession(async ({ ui, store, key }) => {
    const created = await ui("/comments", {
      method: "POST",
      body: JSON.stringify({
        fileIndex: 0,
        side: "RIGHT",
        line: 4,
        startLine: 3,
        body: "swap these two",
        // A client claiming a different base must not be believed: the hash is the safety check.
        suggestion: { replacementLines: ["const c = 4;"], baseHash: "sha256:deadbeef", baseLines: ["lies"] },
      }),
    });
    assert.equal(created.status, 200);
    const { comment } = await created.json();
    assert.deepEqual(comment.suggestion.replacementLines, ["const c = 4;"]);
    // Recomputed from the diff, not echoed back.
    assert.deepEqual(comment.suggestion.baseLines, ["const c = 33;", "const d = 4;"]);
    assert.equal(comment.suggestion.baseHash, hashBaseLines(["const c = 33;", "const d = 4;"]));
    assert.equal(comment.anchor.startLine, 3);
    assert.equal(comment.anchor.line, 4);

    const session = await store.load(key);
    assert.equal(session?.comments.length, 1);
  });
});

test("a suggestion on a deletion is refused, because there is nothing to replace", async () => {
  await withSession(async ({ ui }) => {
    const response = await ui("/comments", {
      method: "POST",
      body: JSON.stringify({
        fileIndex: 0,
        side: "LEFT",
        line: 3,
        body: "this line is wrong",
        suggestion: { replacementLines: ["const c = 4;"] },
      }),
    });
    assert.equal(response.status, 422);
    const error = await response.json();
    assert.equal(error.reason, "suggestion-side-not-right");
    assert.match(error.error, /new side of the diff/);
  });
});

test("an empty replacement is accepted and means deletion", async () => {
  await withSession(async ({ ui }) => {
    const created = await ui("/comments", {
      method: "POST",
      body: JSON.stringify({
        fileIndex: 0,
        side: "RIGHT",
        line: 4,
        body: "drop this",
        suggestion: { replacementLines: [] },
      }),
    });
    assert.equal(created.status, 200);
    assert.deepEqual((await created.json()).comment.suggestion.replacementLines, []);
  });
});

test("the armed payload carries the rendered fence, and the digest matches it", async () => {
  await withSession(async ({ ui, base, key }) => {
    await ui("/comments", {
      method: "POST",
      body: JSON.stringify({
        fileIndex: 0,
        side: "RIGHT",
        line: 3,
        body: "rename it",
        suggestion: { replacementLines: ["const renamed = 33;"] },
      }),
    });
    assert.equal(
      (await ui("/submit/arm", { method: "POST", body: JSON.stringify({ verdict: "COMMENT", body: SUMMARY }) })).status,
      200,
    );

    const polled = await (await fetch(`${base}/api/agent/poll?key=${key}&timeoutMs=500`)).json();
    const token = polled.token;
    assert.ok(token, "the poll must hand the token to the agent");

    const claim = await (
      await fetch(`${base}/api/agent/sessions/${key}/submit/claim`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token, dryRun: true }),
      })
    ).json();

    assert.equal(claim.comments.length, 1);
    assert.equal(claim.comments[0].body, "rename it\n\n```suggestion\nconst renamed = 33;\n```");
    assert.equal(claim.comments[0].line, 3);
    assert.equal(claim.comments[0].side, "RIGHT");
    // The digest is over the payload that will actually be posted, fence included.
    assert.equal(claim.digest, submitDigest({ verdict: "COMMENT", body: SUMMARY, comments: claim.comments }));
  });
});

test("removing a suggestion leaves a plain comment behind", async () => {
  await withSession(async ({ ui, store, key }) => {
    const { comment } = await (
      await ui("/comments", {
        method: "POST",
        body: JSON.stringify({
          fileIndex: 0,
          side: "RIGHT",
          line: 3,
          body: "hmm",
          suggestion: { replacementLines: ["x"] },
        }),
      })
    ).json();

    const updated = await ui(`/comments/${comment.id}`, {
      method: "PATCH",
      body: JSON.stringify({ body: "just a note now", suggestion: null }),
    });
    assert.equal(updated.status, 200);

    store.invalidate(key);
    const session = await store.load(key);
    const stored = session?.comments[0];
    assert.equal(stored?.body, "just a note now");
    // Deleted, not left as an undefined key that reappears differently after a reload.
    assert.equal("suggestion" in /** @type {object} */ (stored), false);
  });
});

test("moving a suggestion's range moves the anchor with it", async () => {
  await withSession(async ({ ui, store, key }) => {
    const { comment } = await (
      await ui("/comments", {
        method: "POST",
        body: JSON.stringify({
          fileIndex: 0,
          side: "RIGHT",
          line: 3,
          body: "hmm",
          suggestion: { replacementLines: ["x"] },
        }),
      })
    ).json();
    assert.equal(comment.anchor.startLine, undefined);

    const moved = await ui(`/comments/${comment.id}`, {
      method: "PATCH",
      body: JSON.stringify({ suggestion: { line: 4, startLine: 3, replacementLines: ["x", "y"] } }),
    });
    assert.equal(moved.status, 200);

    store.invalidate(key);
    const stored = (await store.load(key))?.comments[0];
    assert.equal(stored?.anchor.kind === "line" && stored.anchor.startLine, 3);
    assert.equal(stored?.anchor.kind === "line" && stored.anchor.line, 4);
    // The hash moved with the anchor; a stale hash here is how a suggestion edits the wrong lines.
    assert.equal(stored?.suggestion?.baseHash, hashBaseLines(["const c = 33;", "const d = 4;"]));
  });
});

test("a range move that leaves the diff is refused and changes nothing", async () => {
  await withSession(async ({ ui, store, key }) => {
    const { comment } = await (
      await ui("/comments", {
        method: "POST",
        body: JSON.stringify({ fileIndex: 0, side: "RIGHT", line: 3, body: "hmm", suggestion: {} }),
      })
    ).json();

    const moved = await ui(`/comments/${comment.id}`, {
      method: "PATCH",
      body: JSON.stringify({ suggestion: { line: 900, startLine: 3 } }),
    });
    assert.equal(moved.status, 422);

    store.invalidate(key);
    const stored = (await store.load(key))?.comments[0];
    assert.equal(stored?.anchor.kind === "line" && stored.anchor.line, 3);
    assert.equal(stored?.suggestion?.baseHash, hashBaseLines(["const c = 33;"]));
  });
});

test("promoting an answered question marks the thread and links the comment", async () => {
  await withSession(async ({ ui, agent, store, key }) => {
    const asked = await (
      await ui("/questions", {
        method: "POST",
        body: JSON.stringify({ fileIndex: 0, side: "RIGHT", line: 3, body: "why 33?" }),
      })
    ).json();
    await agent(`/api/agent/sessions/${key}/answer`, {
      threadId: asked.thread.id,
      text: "Because the old value was wrong.",
    });

    // The body is the user's, always. Nothing on the server posts agent text the user did not send.
    const promoted = await ui("/comments", {
      method: "POST",
      body: JSON.stringify({
        fileIndex: 0,
        side: "RIGHT",
        line: 3,
        body: "The old value was wrong — worth a note in the changelog.",
        fromThreadId: asked.thread.id,
      }),
    });
    assert.equal(promoted.status, 200);
    const { comment } = await promoted.json();
    assert.equal(comment.fromThreadId, asked.thread.id);

    store.invalidate(key);
    const session = await store.load(key);
    const thread = session?.threads[0];
    assert.equal(thread?.status, "promoted");
    assert.equal(thread?.promotedCommentId, comment.id);
  });
});

test("an unknown fromThreadId does not invent a thread", async () => {
  await withSession(async ({ ui, store, key }) => {
    const created = await ui("/comments", {
      method: "POST",
      body: JSON.stringify({ fileIndex: 0, side: "RIGHT", line: 3, body: "note", fromThreadId: "q_nope" }),
    });
    assert.equal(created.status, 200);
    store.invalidate(key);
    const session = await store.load(key);
    assert.equal(session?.threads.length, 0);
    assert.equal(session?.comments[0].fromThreadId, "q_nope");
  });
});

test("a COMMENT review with no summary is refused before a token exists", async () => {
  await withSession(async ({ ui, store, key }) => {
    await ui("/comments", {
      method: "POST",
      body: JSON.stringify({ fileIndex: 0, side: "RIGHT", line: 3, body: "needs work" }),
    });

    const response = await ui("/submit/arm", {
      method: "POST",
      body: JSON.stringify({ verdict: "COMMENT", body: "" }),
    });
    // 422 to the browser, which is the only place with a summary box to put the caret in. Found live:
    // arming used to succeed, the CLI then refused the payload, and because claiming consumes the token
    // before the payload is built, the single use was burnt on a request that could never be posted —
    // leaving the arming live, the Submit button disabled, and nothing saying why.
    assert.equal(response.status, 422);
    const body = await response.json();
    assert.match(body.error, /needs a summary/);
    assert.equal(body.field, "body");

    store.invalidate(key);
    const session = await store.load(key);
    assert.equal(session?.submit.tokenHash, null, "a token was minted for a payload that cannot be posted");
    assert.equal(session?.work.length, 0, "the agent was woken for a submission that cannot happen");
  });
});

test("whitespace is not a summary", async () => {
  await withSession(async ({ ui }) => {
    const response = await ui("/submit/arm", {
      method: "POST",
      body: JSON.stringify({ verdict: "REQUEST_CHANGES", body: "   \n\t " }),
    });
    assert.equal(response.status, 422);
    assert.match((await response.json()).error, /Request changes review needs a summary/);
  });
});

test("APPROVE needs no summary", async () => {
  await withSession(async ({ ui, store, key }) => {
    // GitHub accepts an approval with an empty body, and requiring one here would invent a rule the
    // API does not have.
    const response = await ui("/submit/arm", {
      method: "POST",
      body: JSON.stringify({ verdict: "APPROVE", body: "" }),
    });
    assert.equal(response.status, 200);
    store.invalidate(key);
    assert.ok((await store.load(key))?.submit.tokenHash);
  });
});

test("an arming the agent never collected can be cancelled", async () => {
  await withSession(async ({ ui, base, store, key }) => {
    await ui("/comments", {
      method: "POST",
      body: JSON.stringify({ fileIndex: 0, side: "RIGHT", line: 3, body: "note" }),
    });
    assert.equal(
      (await ui("/submit/arm", { method: "POST", body: JSON.stringify({ verdict: "COMMENT", body: SUMMARY }) })).status,
      200,
    );

    // The agent polls and receives the token — then, in this scenario, loses it.
    const polled = await (await fetch(`${base}/api/agent/poll?key=${key}&timeoutMs=500`)).json();
    const token = polled.token;
    assert.ok(token);

    assert.equal((await ui("/submit/cancel", { method: "POST" })).status, 200);

    // The arming is gone: the token that was handed out no longer works, so a delayed agent cannot
    // post a review the user has stopped waiting for.
    const claim = await fetch(`${base}/api/agent/sessions/${key}/submit/claim`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token }),
    });
    assert.equal(claim.status, 409);
    assert.equal((await claim.json()).reason, "not-armed");

    // Drafts survive: cancelling stops a submission, it does not discard review text.
    store.invalidate(key);
    const session = await store.load(key);
    assert.equal(session?.comments.length, 1);
    assert.equal(session?.comments[0].state, "draft");
  });
});

test("re-arming after a cancel works, and mints a different token", async () => {
  await withSession(async ({ ui, base, key }) => {
    await ui("/comments", {
      method: "POST",
      body: JSON.stringify({ fileIndex: 0, side: "RIGHT", line: 3, body: "note" }),
    });
    await ui("/submit/arm", { method: "POST", body: JSON.stringify({ verdict: "COMMENT", body: SUMMARY }) });
    const first = (await (await fetch(`${base}/api/agent/poll?key=${key}&timeoutMs=500`)).json()).token;
    await ui("/submit/cancel", { method: "POST" });

    await ui("/submit/arm", { method: "POST", body: JSON.stringify({ verdict: "APPROVE" }) });
    const second = (await (await fetch(`${base}/api/agent/poll?key=${key}&timeoutMs=500`)).json()).token;
    assert.ok(second);
    assert.notEqual(second, first);

    const claim = await fetch(`${base}/api/agent/sessions/${key}/submit/claim`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: second, dryRun: true }),
    });
    assert.equal(claim.status, 200);
    assert.equal((await claim.json()).verdict, "APPROVE");
  });
});

test("a reply can only be queued against a thread that exists", async () => {
  await withSession(async ({ ui, store, key }) => {
    const unknown = await ui("/replies", {
      method: "POST",
      body: JSON.stringify({ threadId: "PRRT_nope", body: "hello" }),
    });
    assert.equal(unknown.status, 404);

    await store.saveThreads(key, {
      threads: [
        /** @type {any} */ ({
          id: "T1",
          rootCommentId: 555,
          path: "src/a.js",
          side: "RIGHT",
          line: 3,
          startLine: null,
          originalLine: 3,
          originalStartLine: null,
          diffHunk: "@@ -1,4 +1,5 @@",
          isResolved: false,
          isOutdated: false,
          resolvedStateKnown: true,
          subjectType: "line",
          comments: [
            {
              id: 555,
              author: "someone",
              body: "why?",
              createdAt: "2026-01-01T00:00:00Z",
              url: "",
              association: "MEMBER",
            },
          ],
        }),
      ],
      fetchedAt: new Date().toISOString(),
      graphqlAvailable: true,
      graphqlError: null,
    });

    const empty = await ui("/replies", { method: "POST", body: JSON.stringify({ threadId: "T1", body: "  " }) });
    assert.equal(empty.status, 422);

    const queued = await ui("/replies", { method: "POST", body: JSON.stringify({ threadId: "T1", body: "because" }) });
    assert.equal(queued.status, 200);
    const { reply } = await queued.json();
    // Addressed to the thread's FIRST comment: GitHub has no notion of replying to a reply.
    assert.equal(reply.inReplyToCommentId, 555);
    assert.equal(reply.state, "draft");
    assert.equal(reply.path, "src/a.js");
  });
});

test("queued replies ride in the same digest but travel as their own list", async () => {
  await withSession(async ({ ui, base, store, key }) => {
    await store.saveThreads(key, {
      threads: [
        /** @type {any} */ ({
          id: "T1",
          rootCommentId: 777,
          path: "src/a.js",
          side: "RIGHT",
          line: 3,
          startLine: null,
          originalLine: 3,
          originalStartLine: null,
          diffHunk: "",
          isResolved: false,
          isOutdated: false,
          resolvedStateKnown: true,
          subjectType: "line",
          comments: [{ id: 777, author: "u", body: "q", createdAt: "2026-01-01T00:00:00Z", url: "", association: "" }],
        }),
      ],
      fetchedAt: new Date().toISOString(),
      graphqlAvailable: true,
      graphqlError: null,
    });
    await ui("/comments", {
      method: "POST",
      body: JSON.stringify({ fileIndex: 0, side: "RIGHT", line: 3, body: "a comment" }),
    });
    await ui("/replies", { method: "POST", body: JSON.stringify({ threadId: "T1", body: "a reply" }) });

    const armed = await (
      await ui("/submit/arm", { method: "POST", body: JSON.stringify({ verdict: "COMMENT", body: SUMMARY }) })
    ).json();
    assert.equal(armed.comments, 1);
    assert.equal(armed.replies, 1);

    const token = (await (await fetch(`${base}/api/agent/poll?key=${key}&timeoutMs=500`)).json()).token;
    const claim = await (
      await fetch(`${base}/api/agent/sessions/${key}/submit/claim`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token, dryRun: true }),
      })
    ).json();

    // Separate lists, because they are separate POSTs with different atomicity.
    assert.equal(claim.comments.length, 1);
    assert.equal(claim.replies.length, 1);
    assert.equal(claim.replies[0].inReplyTo, 777);
    // The digest covers the reply too: it was approved in the same click, so altering it afterwards
    // must invalidate the token.
    assert.equal(
      claim.digest,
      submitDigest({
        verdict: "COMMENT",
        body: SUMMARY,
        comments: claim.comments,
        replies: [{ inReplyToCommentId: 777, body: "a reply" }],
      }),
    );
    assert.notEqual(
      claim.digest,
      submitDigest({ verdict: "COMMENT", body: SUMMARY, comments: claim.comments, replies: [] }),
    );
  });
});

test("reply outcomes are recorded per reply, not as one status", async () => {
  await withSession(async ({ ui, agent, store, key }) => {
    await store.saveThreads(key, {
      threads: [
        /** @type {any} */ ({
          id: "T1",
          rootCommentId: 1,
          path: "src/a.js",
          side: "RIGHT",
          line: 3,
          startLine: null,
          originalLine: 3,
          originalStartLine: null,
          diffHunk: "",
          isResolved: false,
          isOutdated: false,
          resolvedStateKnown: true,
          subjectType: "line",
          comments: [{ id: 1, author: "u", body: "q", createdAt: "2026-01-01T00:00:00Z", url: "", association: "" }],
        }),
      ],
      fetchedAt: new Date().toISOString(),
      graphqlAvailable: true,
      graphqlError: null,
    });
    const first = (
      await (await ui("/replies", { method: "POST", body: JSON.stringify({ threadId: "T1", body: "one" }) })).json()
    ).reply;
    const second = (
      await (await ui("/replies", { method: "POST", body: JSON.stringify({ threadId: "T1", body: "two" }) })).json()
    ).reply;

    await agent(`/api/agent/sessions/${key}/submit/result`, {
      review: { state: "COMMENTED", html_url: "https://github.com/o/r/pull/1#r1" },
      posted: [{ id: first.id, url: "https://github.com/o/r/pull/1#r99" }],
      failed: [{ id: second.id, error: "422 Unprocessable Entity" }],
    });

    store.invalidate(key);
    const session = await store.load(key);
    const stored = Object.fromEntries(
      (session?.replies ?? []).map((/** @type {import("../src/session-store.js").DraftReply} */ reply) => [
        reply.id,
        reply,
      ]),
    );
    assert.equal(stored[first.id].state, "posted");
    assert.equal(stored[first.id].url, "https://github.com/o/r/pull/1#r99");
    // A failure is not silently retried and not merged into the success: the one that went out is
    // already live on the PR and cannot be taken back.
    assert.equal(stored[second.id].state, "failed");
    assert.match(stored[second.id].error, /422/);
  });
});

test("a posted reply can neither be edited nor removed", async () => {
  await withSession(async ({ ui, store, key }) => {
    await store.saveThreads(key, {
      threads: [
        /** @type {any} */ ({
          id: "T1",
          rootCommentId: 1,
          path: "src/a.js",
          side: "RIGHT",
          line: 3,
          startLine: null,
          originalLine: 3,
          originalStartLine: null,
          diffHunk: "",
          isResolved: false,
          isOutdated: false,
          resolvedStateKnown: true,
          subjectType: "line",
          comments: [{ id: 1, author: "u", body: "q", createdAt: "2026-01-01T00:00:00Z", url: "", association: "" }],
        }),
      ],
      fetchedAt: new Date().toISOString(),
      graphqlAvailable: true,
      graphqlError: null,
    });
    const { reply } = await (
      await ui("/replies", { method: "POST", body: JSON.stringify({ threadId: "T1", body: "one" }) })
    ).json();
    await store.mutate(key, {
      op: "reply:update",
      at: new Date().toISOString(),
      payload: { id: reply.id, patch: { state: "posted" } },
    });

    assert.equal(
      (await ui(`/replies/${reply.id}`, { method: "PATCH", body: JSON.stringify({ body: "x" }) })).status,
      409,
    );
    assert.equal((await ui(`/replies/${reply.id}`, { method: "DELETE" })).status, 409);
  });
});

test("a submitted comment cannot be edited", async () => {
  await withSession(async ({ ui, store, key }) => {
    const { comment } = await (
      await ui("/comments", {
        method: "POST",
        body: JSON.stringify({ fileIndex: 0, side: "RIGHT", line: 3, body: "note" }),
      })
    ).json();
    await store.mutate(key, {
      op: "comment:update",
      at: new Date().toISOString(),
      payload: { id: comment.id, patch: { state: "submitted" } },
    });

    const response = await ui(`/comments/${comment.id}`, { method: "PATCH", body: JSON.stringify({ body: "edited" }) });
    assert.equal(response.status, 409);
  });
});

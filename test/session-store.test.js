import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, readdir, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { readJsonl, writeJsonAtomic } from "../src/atomic-json.js";
import {
  applyOp,
  emptySession,
  hashToken,
  newId,
  SESSION_SCHEMA_VERSION,
  SessionStore,
  submitDigest,
  tokenMatches,
} from "../src/session-store.js";

const REF = { host: "github.com", owner: "o", repo: "r", number: 7 };
const KEY = "0123456789abcdef";

/** @param {(ctx: { store: SessionStore, dir: string }) => Promise<void>} body */
async function withStore(body) {
  const dir = await mkdtemp(path.join(tmpdir(), "prc-store-"));
  const store = new SessionStore({ env: { PR_REVIEW_CANVAS_STATE_DIR: dir } });
  try {
    await body({ store, dir });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** @param {SessionStore} store */
async function seed(store) {
  return store.upsert({
    ref: REF,
    key: KEY,
    accessId: "access-1",
    url: "https://github.com/o/r/pull/7",
    displayRef: "o/r#7",
    headSha: "sha-head",
  });
}

/** @param {Partial<import("../src/session-store.js").DraftComment>} [overrides] */
function draft(overrides = {}) {
  return {
    id: newId("c"),
    anchor: {
      kind: /** @type {const} */ ("line"),
      path: "src/a.js",
      side: /** @type {const} */ ("RIGHT"),
      line: 10,
      fingerprint: {
        rawText: "const a = 1;",
        textHash: "aaaa",
        beforeHash: "bbbb",
        afterHash: "cccc",
        hunkHeader: "",
        blobSha: null,
        headSha: "sha-head",
      },
    },
    body: "needs a null check",
    fromThreadId: null,
    state: /** @type {const} */ ("draft"),
    staleReason: null,
    createdAt: "2026-08-04T00:00:00.000Z",
    updatedAt: "2026-08-04T00:00:00.000Z",
    ...overrides,
  };
}

test("a session round-trips through disk", async () => {
  await withStore(async ({ store }) => {
    await seed(store);
    store.invalidate();
    const loaded = await store.load(KEY);
    assert.ok(loaded);
    assert.equal(loaded.pr.ref, "o/r#7");
    assert.equal(loaded.accessId, "access-1");
    assert.equal(loaded.snapshotHeadSha, "sha-head");
    assert.equal(loaded.version, SESSION_SCHEMA_VERSION);
  });
});

test("load returns null for a session that was never written", async () => {
  await withStore(async ({ store }) => {
    assert.equal(await store.load("ffffffffffffffff"), null);
  });
});

test("every mutation appends exactly one journal record before the fold cache is rewritten", async () => {
  await withStore(async ({ store }) => {
    await seed(store);
    await store.mutate(KEY, { op: "comment:add", at: "2026-08-04T00:00:01.000Z", payload: { comment: draft() } });
    const journal = await readJsonl(store.paths(KEY).journal);
    assert.equal(journal.length, 2, "one op for the upsert, one for the comment");
    assert.deepEqual(
      journal.map((/** @type {any} */ entry) => entry.seq),
      [1, 2],
    );
  });
});

// ---------------------------------------------------------------------------
// The property the whole journal design exists for.
// ---------------------------------------------------------------------------

test("a crash between the journal append and the fold rewrite loses nothing", async () => {
  await withStore(async ({ store, dir }) => {
    await seed(store);
    const comment = draft({ body: "thirty minutes of prose" });

    // Simulate the crash window precisely: the journal record is durable, `session.json` is not
    // yet updated. This is the exact state a power loss mid-commit leaves behind.
    const { journal, session: sessionFile } = store.paths(KEY);
    const before = await store.load(KEY);
    assert.ok(before);
    await writeFile(
      journal,
      `${(await readFile(journal, "utf8")).trimEnd()}\n${JSON.stringify({
        seq: before.seq + 1,
        at: "2026-08-04T00:00:05.000Z",
        op: "comment:add",
        payload: { comment },
      })}\n`,
      "utf8",
    );

    // A fresh store, as after a restart.
    const reopened = new SessionStore({ env: { PR_REVIEW_CANVAS_STATE_DIR: dir } });
    const recovered = await reopened.load(KEY);
    assert.ok(recovered);
    assert.equal(recovered.comments.length, 1, "the un-folded op must be replayed");
    assert.equal(recovered.comments[0].body, "thirty minutes of prose");
    assert.equal(recovered.seq, before.seq + 1);

    // And the fold cache on disk is still the older one — proving recovery came from the journal.
    const stored = JSON.parse(await readFile(sessionFile, "utf8"));
    assert.equal(stored.comments.length, 0);
  });
});

test("a missing fold cache is fully recoverable from the journal alone", async () => {
  await withStore(async ({ store, dir }) => {
    await seed(store);
    await store.mutate(KEY, { op: "comment:add", at: "2026-08-04T00:00:01.000Z", payload: { comment: draft() } });
    await store.mutate(KEY, {
      op: "review:set",
      at: "2026-08-04T00:00:02.000Z",
      payload: { verdict: "REQUEST_CHANGES", body: "see comments" },
    });

    await rm(store.paths(KEY).session, { force: true });

    const reopened = new SessionStore({ env: { PR_REVIEW_CANVAS_STATE_DIR: dir } });
    const recovered = await reopened.load(KEY);
    assert.ok(recovered);
    assert.equal(recovered.comments.length, 1);
    assert.equal(recovered.review.verdict, "REQUEST_CHANGES");
    assert.equal(recovered.pr.ref, "o/r#7");
  });
});

test("a truncated final journal line is dropped, not treated as corruption", async () => {
  await withStore(async ({ store, dir }) => {
    await seed(store);
    const { journal } = store.paths(KEY);
    await writeFile(journal, `${(await readFile(journal, "utf8")).trimEnd()}\n{"seq":2,"op":"comment:a`, "utf8");
    const reopened = new SessionStore({ env: { PR_REVIEW_CANVAS_STATE_DIR: dir } });
    const recovered = await reopened.load(KEY);
    assert.ok(recovered, "a torn tail is what a crash mid-append looks like; it must not be fatal");
    assert.equal(recovered.comments.length, 0);
  });
});

test("a crash between the temp write and the rename leaves the previous state intact", async () => {
  await withStore(async ({ store, dir }) => {
    await seed(store);
    await store.mutate(KEY, { op: "comment:add", at: "2026-08-04T00:00:01.000Z", payload: { comment: draft() } });

    // Exactly what a kill inside `writeJsonAtomic` leaves behind: a complete temp file that was
    // never renamed. This is the failure atomicity exists to make survivable, so the assertion is
    // that the *old* file still describes reality and the orphan is invisible.
    const { session: sessionFile, base } = store.paths(KEY);
    const orphan = `${sessionFile}.${process.pid}.${Date.now()}.deadbeef.tmp`;
    await writeFile(orphan, JSON.stringify({ version: 1, seq: 99, key: KEY, comments: [] }), "utf8");

    const reopened = new SessionStore({ env: { PR_REVIEW_CANVAS_STATE_DIR: dir } });
    const recovered = await reopened.load(KEY);
    assert.ok(recovered);
    assert.equal(recovered.comments.length, 1, "the half-finished write must not be read as state");
    assert.equal(recovered.seq, 2);

    // A later mutation still succeeds despite the orphan sitting beside its target.
    await reopened.mutate(KEY, { op: "comment:add", at: "2026-08-04T00:00:02.000Z", payload: { comment: draft() } });
    assert.equal((await reopened.load(KEY))?.comments.length, 2);
    assert.ok((await readdir(base)).includes(path.basename(orphan)), "nothing deleted it mid-session");
  });
});

test("stale temp files are swept, and a fresh one is left alone", async () => {
  await withStore(async ({ store, dir }) => {
    await seed(store);
    const { session: sessionFile } = store.paths(KEY);
    const old = `${sessionFile}.1.1.aaaaaa.tmp`;
    const fresh = `${sessionFile}.2.2.bbbbbb.tmp`;
    await writeFile(old, "{}", "utf8");
    await writeFile(fresh, "{}", "utf8");
    // Backdated well past the cutoff. Age is the safety margin: an atomic write takes milliseconds,
    // so anything this old cannot belong to a live writer — including one in another process.
    const ancient = new Date(Date.now() - 3 * 60 * 60_000);
    await utimes(old, ancient, ancient);

    const removed = await store.sweepTempFiles();
    assert.deepEqual(removed, [old]);
    assert.equal(existsSync(old), false);
    assert.equal(existsSync(fresh), true, "a temp file that may still be being written is untouched");

    // And sweeping an empty state directory is a no-op rather than an error.
    const empty = new SessionStore({ env: { PR_REVIEW_CANVAS_STATE_DIR: path.join(dir, "nope") } });
    assert.deepEqual(await empty.sweepTempFiles(), []);
  });
});

test("an unparseable fold cache falls back to the journal instead of losing the drafts", async () => {
  await withStore(async ({ store, dir }) => {
    await seed(store);
    await store.mutate(KEY, {
      op: "comment:add",
      at: "2026-08-04T00:00:01.000Z",
      payload: { comment: draft({ body: "still here" }) },
    });

    // Truncated mid-JSON. Atomic writes make this unlikely from our own code, but a full disk, a
    // helpful editor or a filesystem repair can all produce it, and the journal is the answer.
    const { session: sessionFile } = store.paths(KEY);
    const text = await readFile(sessionFile, "utf8");
    await writeFile(sessionFile, text.slice(0, Math.floor(text.length / 2)), "utf8");

    const reopened = new SessionStore({ env: { PR_REVIEW_CANVAS_STATE_DIR: dir } });
    const recovered = await reopened.load(KEY);
    assert.ok(recovered);
    assert.equal(recovered.comments.at(-1)?.body, "still here");
    assert.equal(recovered.pr.ref, "o/r#7");
  });
});

test("a drift decision replays from the journal exactly as it was applied", async () => {
  await withStore(async ({ store, dir }) => {
    await seed(store);
    const comment = draft({ body: "the reviewer wrote this" });
    await store.mutate(KEY, { op: "comment:add", at: "2026-08-04T00:00:01.000Z", payload: { comment } });

    const proposed = { ...comment.anchor, line: 14 };
    const live = await store.mutate(KEY, {
      op: "drift:apply",
      at: "2026-08-04T00:00:02.000Z",
      payload: {
        headSha: "sha-two",
        comments: { [comment.id]: { status: "moved", confidence: 0.9, how: "unique-text", proposedAnchor: proposed } },
      },
    });
    assert.equal(live.comments[0].state, "stale");

    // The reducer is the only writer, so replay and live mutation are the same function. This pins
    // that for the ops added with drift — a `stale` flag that failed to replay would put a comment
    // the user never re-approved back into a submission after a restart.
    const reopened = new SessionStore({ env: { PR_REVIEW_CANVAS_STATE_DIR: dir } });
    reopened.invalidate();
    await rm(reopened.paths(KEY).session, { force: true });
    const recovered = await reopened.load(KEY);
    assert.equal(recovered?.comments[0].state, "stale");
    assert.equal(recovered?.comments[0].driftStatus, "moved");
    assert.equal(
      recovered?.comments[0].proposedAnchor?.kind === "line" && recovered.comments[0].proposedAnchor.line,
      14,
    );
    assert.equal(recovered?.comments[0].body, "the reviewer wrote this");
    assert.equal(recovered?.snapshotHeadSha, "sha-two");
  });
});

test("a session written by a newer schema is refused rather than silently truncated", async () => {
  await withStore(async ({ store, dir }) => {
    await seed(store);
    const { session: sessionFile } = store.paths(KEY);
    const stored = JSON.parse(await readFile(sessionFile, "utf8"));
    stored.version = SESSION_SCHEMA_VERSION + 1;
    stored.somethingWeDoNotUnderstand = { drafts: ["would be dropped"] };
    await writeJsonAtomic(sessionFile, stored);

    const reopened = new SessionStore({ env: { PR_REVIEW_CANVAS_STATE_DIR: dir } });
    await assert.rejects(() => reopened.load(KEY), /newer version/);
  });
});

test("a failed submit leaves the drafts as drafts", () => {
  // This used to be unconditional, and the consequence was worse than it looks: a submitted comment
  // can no longer be edited or deleted, so a 422 turned every draft into a read-only record of a
  // review that does not exist, recoverable only by editing the journal by hand. Found by a real 422
  // on a real pull request.
  const session = emptySession(KEY, "a");
  session.comments.push(
    /** @type {any} */ ({
      id: "c1",
      anchor: { kind: "line", path: "a.js", side: "RIGHT", line: 1 },
      body: "x",
      state: "draft",
    }),
  );
  session.submit.commentIds = ["c1"];

  const failed = applyOp(session, {
    op: "submit:result",
    at: "2026-08-04T00:00:00.000Z",
    payload: { result: { error: "GitHub rejected the review as invalid (422)" } },
  });
  assert.equal(failed.comments[0].state, "draft", "a failed submit must not claim the comment was posted");
  assert.ok(failed.submit.result, "the failure itself is still recorded, so the attempt stays auditable");
});

test("a successful submit marks only the comments that were armed", () => {
  const session = emptySession(KEY, "a");
  session.comments.push(
    /** @type {any} */ ({
      id: "c1",
      anchor: { kind: "line", path: "a.js", side: "RIGHT", line: 1 },
      body: "x",
      state: "draft",
    }),
    /** @type {any} */ ({
      id: "c2",
      anchor: { kind: "line", path: "a.js", side: "RIGHT", line: 2 },
      body: "y",
      state: "draft",
    }),
  );
  session.submit.commentIds = ["c1"];

  const done = applyOp(session, {
    op: "submit:result",
    at: "2026-08-04T00:00:00.000Z",
    payload: { result: { review: { id: 1, state: "COMMENTED", html_url: "u" } } },
  });
  assert.equal(done.comments[0].state, "submitted");
  assert.equal(done.comments[1].state, "draft", "a comment drafted after arming was not part of that review");
});

test("an unknown op is skipped so a downgrade still loads the drafts", async () => {
  const session = emptySession(KEY, "a");
  const after = applyOp(session, { op: "something:from-the-future", at: "2026-08-04T00:00:00.000Z", payload: {} });
  assert.equal(after.comments.length, 0);
  assert.equal(after.updatedAt, "2026-08-04T00:00:00.000Z");
});

test("each session gets its own directory", async () => {
  await withStore(async ({ store }) => {
    await seed(store);
    await store.upsert({
      ref: { ...REF, number: 8 },
      key: "fedcba9876543210",
      accessId: "access-2",
      url: "https://github.com/o/r/pull/8",
      displayRef: "o/r#8",
    });
    assert.notEqual(store.dir(KEY), store.dir("fedcba9876543210"));
    // Destroying one must not disturb the other.
    await store.destroy(KEY);
    assert.equal(await store.load(KEY), null);
    assert.ok(await store.load("fedcba9876543210"));
  });
});

test("reopening clears an end without clearing drafts", async () => {
  await withStore(async ({ store }) => {
    await seed(store);
    await store.mutate(KEY, { op: "comment:add", at: "t1", payload: { comment: draft() } });
    await store.mutate(KEY, { op: "session:end", at: "t2", payload: { endedBy: "user" } });
    let session = await store.load(KEY);
    assert.equal(session?.status, "ended");
    assert.equal(session?.endedBy, "user");

    session = await store.upsert({
      ref: REF,
      key: KEY,
      accessId: "access-2",
      url: "https://github.com/o/r/pull/7",
      displayRef: "o/r#7",
      reopen: true,
    });
    assert.equal(session.status, "open");
    assert.equal(session.endedBy, null);
    assert.equal(session.comments.length, 1, "drafts survive a reopen");
  });
});

// ---------------------------------------------------------------------------
// takeWork
// ---------------------------------------------------------------------------

test("takeWork reports waiting, drains once, then reports waiting again", async () => {
  await withStore(async ({ store }) => {
    await seed(store);
    assert.deepEqual(await store.takeWork(KEY), { status: "waiting" });

    await store.mutate(KEY, {
      op: "work:add",
      at: "t1",
      payload: { item: { uid: "w1", kind: "question", at: "t1", ref: "q1" } },
    });
    const first = await store.takeWork(KEY);
    assert.equal(first.status, "work");
    assert.equal(first.status === "work" && first.work.length, 1);

    assert.deepEqual(await store.takeWork(KEY), { status: "waiting" });
  });
});

test("takeWork reports missing for an unknown session", async () => {
  await withStore(async ({ store }) => {
    assert.deepEqual(await store.takeWork("ffffffffffffffff"), { status: "missing" });
  });
});

test("work queued before an end is delivered once, and only then does the session read as ended", async () => {
  await withStore(async ({ store }) => {
    await seed(store);
    await store.mutate(KEY, {
      op: "work:add",
      at: "t1",
      payload: { item: { uid: "w1", kind: "message", at: "t1" } },
    });
    await store.mutate(KEY, { op: "session:end", at: "t2", payload: { endedBy: "user" } });

    const delivered = await store.takeWork(KEY);
    assert.equal(delivered.status, "work");
    assert.equal(delivered.status === "work" && delivered.sessionEnded, true);

    assert.deepEqual(await store.takeWork(KEY), { status: "ended", endedBy: "user" });
  });
});

test("concurrent mutations on one key are serialized and none are lost", async () => {
  await withStore(async ({ store }) => {
    await seed(store);
    await Promise.all(
      Array.from({ length: 20 }, (_unused, i) =>
        store.mutate(KEY, { op: "comment:add", at: `t${i}`, payload: { comment: draft({ id: `c${i}` }) } }),
      ),
    );
    const session = await store.load(KEY);
    assert.equal(session?.comments.length, 20);
    const journal = await readJsonl(store.paths(KEY).journal);
    // 1 upsert + 20 comments, with strictly increasing sequence numbers.
    assert.equal(journal.length, 21);
    const seqs = journal.map((/** @type {any} */ entry) => entry.seq);
    assert.deepEqual(
      seqs,
      [...seqs].sort((a, b) => a - b),
    );
    assert.equal(new Set(seqs).size, seqs.length, "sequence numbers must be unique");
  });
});

test("mutations on different keys do not block each other's ordering", async () => {
  await withStore(async ({ store }) => {
    const keyB = "fedcba9876543210";
    await seed(store);
    await store.upsert({ ref: { ...REF, number: 8 }, key: keyB, accessId: "b", url: "u", displayRef: "o/r#8" });
    await Promise.all([
      store.mutate(KEY, { op: "comment:add", at: "t", payload: { comment: draft({ id: "a1" }) } }),
      store.mutate(keyB, { op: "comment:add", at: "t", payload: { comment: draft({ id: "b1" }) } }),
    ]);
    assert.equal((await store.load(KEY))?.comments[0].id, "a1");
    assert.equal((await store.load(keyB))?.comments[0].id, "b1");
  });
});

// ---------------------------------------------------------------------------
// The submit token: the mechanism that makes the human the gate.
// ---------------------------------------------------------------------------

const PAYLOAD = {
  verdict: "COMMENT",
  body: "looks good overall",
  comments: [{ path: "src/a.js", body: "nit", line: 10, side: /** @type {const} */ ("RIGHT") }],
};

test("armSubmit returns a token and stores only its hash", async () => {
  await withStore(async ({ store }) => {
    await seed(store);
    const digest = submitDigest(PAYLOAD);
    const { token } = await store.armSubmit(KEY, {
      verdict: "COMMENT",
      body: PAYLOAD.body,
      commentIds: ["c1"],
      digest,
      headSha: "sha-head",
    });
    const session = await store.load(KEY);
    assert.ok(token.length > 20);
    assert.equal(session?.submit.tokenHash, hashToken(token));
    assert.notEqual(session?.submit.tokenHash, token, "the raw token must never be persisted");
    assert.equal(session?.submit.digest, digest);
  });
});

test("a dry-run claim verifies the token without consuming it", async () => {
  await withStore(async ({ store }) => {
    await seed(store);
    const { token } = await store.armSubmit(KEY, {
      verdict: "COMMENT",
      body: "",
      commentIds: [],
      digest: submitDigest(PAYLOAD),
      headSha: "sha-head",
    });
    // Burning the single use to print a preview would leave the real submit unable to proceed.
    assert.equal((await store.claimSubmit(KEY, token, { dryRun: true })).ok, true);
    assert.equal((await store.claimSubmit(KEY, token, { dryRun: true })).ok, true);
    assert.equal((await store.load(KEY))?.submit.consumedAt, null);
    assert.equal((await store.claimSubmit(KEY, token)).ok, true);
    assert.deepEqual(await store.claimSubmit(KEY, token), { ok: false, reason: "already-used" });
  });
});

test("claimSubmit accepts the right token exactly once", async () => {
  await withStore(async ({ store }) => {
    await seed(store);
    const { token } = await store.armSubmit(KEY, {
      verdict: "COMMENT",
      body: "",
      commentIds: [],
      digest: submitDigest(PAYLOAD),
      headSha: "sha-head",
    });
    const first = await store.claimSubmit(KEY, token);
    assert.equal(first.ok, true);
    // Single use is what makes an agent retry loop unable to double-post.
    const second = await store.claimSubmit(KEY, token);
    assert.deepEqual(second, { ok: false, reason: "already-used" });
  });
});

test("claimSubmit rejects a wrong token, an unarmed session and an expired token", async () => {
  await withStore(async ({ store }) => {
    await seed(store);
    assert.deepEqual(await store.claimSubmit(KEY, "anything"), { ok: false, reason: "not-armed" });

    const { token } = await store.armSubmit(KEY, {
      verdict: "COMMENT",
      body: "",
      commentIds: [],
      digest: "sha256:x",
      headSha: "sha-head",
    });
    assert.deepEqual(await store.claimSubmit(KEY, `${token}tampered`), { ok: false, reason: "bad-token" });

    // Expire it by rewriting the stored expiry.
    await store.mutate(KEY, {
      op: "submit:arm",
      at: "t",
      payload: {
        tokenHash: hashToken(token),
        digest: "sha256:x",
        expiresAt: new Date(Date.now() - 1000).toISOString(),
        verdict: "COMMENT",
        body: "",
        commentIds: [],
        headShaAtArm: "sha-head",
      },
    });
    assert.deepEqual(await store.claimSubmit(KEY, token), { ok: false, reason: "expired" });
  });
});

test("recording a submit result marks those comments submitted and keeps an audit copy", async () => {
  await withStore(async ({ store }) => {
    await seed(store);
    const one = draft({ id: "c1" });
    const two = draft({ id: "c2" });
    await store.mutate(KEY, { op: "comment:add", at: "t", payload: { comment: one } });
    await store.mutate(KEY, { op: "comment:add", at: "t", payload: { comment: two } });
    await store.armSubmit(KEY, {
      verdict: "COMMENT",
      body: "",
      commentIds: ["c1"],
      digest: "sha256:x",
      headSha: "sha-head",
    });
    await store.recordSubmitResult(KEY, { review: { id: 1, html_url: "https://example.test/r/1" } });

    const session = await store.load(KEY);
    assert.equal(session?.comments.find((comment) => comment.id === "c1")?.state, "submitted");
    assert.equal(session?.comments.find((comment) => comment.id === "c2")?.state, "draft");
    assert.deepEqual(session?.submit.result, { review: { id: 1, html_url: "https://example.test/r/1" } });
  });
});

test("submitDigest is stable across key order and sensitive to every field a human read", () => {
  const a = submitDigest(PAYLOAD);
  const reordered = submitDigest({
    body: PAYLOAD.body,
    verdict: PAYLOAD.verdict,
    comments: [{ side: "RIGHT", line: 10, body: "nit", path: "src/a.js" }],
  });
  assert.equal(a, reordered, "field order must not change the digest");

  assert.notEqual(a, submitDigest({ ...PAYLOAD, verdict: "APPROVE" }));
  assert.notEqual(a, submitDigest({ ...PAYLOAD, body: "different summary" }));
  assert.notEqual(
    a,
    submitDigest({ ...PAYLOAD, comments: [{ ...PAYLOAD.comments[0], body: "edited after approval" }] }),
  );
  assert.notEqual(a, submitDigest({ ...PAYLOAD, comments: [{ ...PAYLOAD.comments[0], line: 11 }] }));
  assert.notEqual(a, submitDigest({ ...PAYLOAD, comments: [] }));
});

test("tokenMatches is length-safe and rejects near misses", () => {
  const token = "abc123";
  assert.equal(tokenMatches(token, hashToken(token)), true);
  assert.equal(tokenMatches("abc124", hashToken(token)), false);
  assert.equal(tokenMatches(token, "deadbeef"), false, "a short stored hash must not throw");
});

// ---------------------------------------------------------------------------
// Index and snapshot side files
// ---------------------------------------------------------------------------

test("the index lists sessions with counts and never holds draft bodies", async () => {
  await withStore(async ({ store }) => {
    await seed(store);
    await store.mutate(KEY, {
      op: "comment:add",
      at: "t",
      payload: { comment: draft({ body: "secret prose" }) },
    });
    const sessions = await store.listSessions();
    assert.equal(sessions.length, 1);
    const entry = /** @type {any} */ (sessions[0]);
    assert.equal(entry.ref, "o/r#7");
    assert.equal(entry.counts.draftComments, 1);
    assert.equal(JSON.stringify(sessions).includes("secret prose"), false, "the index must stay small");
  });
});

test("agent findings persist separately and never become review comments", async () => {
  await withStore(async ({ store }) => {
    await seed(store);
    const finding = {
      id: "f_1",
      title: "Unchecked fallback",
      body: "The fallback bypasses validation.",
      severity: /** @type {const} */ ("high"),
      confidence: 0.8,
      anchor: { path: "src/a.js", side: /** @type {const} */ ("RIGHT"), line: 10 },
      headSha: "sha-head",
      status: /** @type {const} */ ("open"),
      createdAt: "t1",
      updatedAt: "t1",
    };
    await store.mutate(KEY, { op: "finding:add", at: "t1", payload: { finding } });
    await store.mutate(KEY, {
      op: "finding:status",
      at: "t2",
      payload: { id: finding.id, status: "acknowledged" },
    });
    store.invalidate();
    const loaded = await store.load(KEY);
    assert.equal(loaded?.findings[0].status, "acknowledged");
    assert.deepEqual(loaded?.comments, []);
    assert.equal(JSON.stringify(loaded?.review).includes(finding.body), false);
  });
});

test("a snapshot survives a round trip and its path index is rebuilt", async () => {
  await withStore(async ({ store }) => {
    await seed(store);
    /** @type {any} */
    const snapshot = {
      ref: REF,
      pr: { number: 7 },
      files: [{ path: "src/a.js", hunks: [] }],
      byPath: new Map([["src/a.js", { path: "src/a.js" }]]),
      headSha: "sha-head",
      baseSha: "sha-base",
      fetchedAt: "t",
      fileCountCapped: false,
      counts: { files: 1, additions: 0, deletions: 0, binary: 0, withheld: 0, degraded: 0 },
    };
    await store.saveSnapshot(KEY, snapshot);
    const loaded = await store.loadSnapshot(KEY);
    assert.ok(loaded);
    assert.equal(loaded.headSha, "sha-head");
    assert.ok(loaded.byPath instanceof Map, "byPath is a Map and must be rebuilt, not serialized");
    assert.equal(loaded.byPath.get("src/a.js")?.path, "src/a.js");
  });
});

test("writing a snapshot does not rewrite the session file", async () => {
  await withStore(async ({ store }) => {
    await seed(store);
    const before = await readFile(store.paths(KEY).session, "utf8");
    await store.saveSnapshot(KEY, /** @type {any} */ ({ files: [], byPath: new Map(), counts: {} }));
    const after = await readFile(store.paths(KEY).session, "utf8");
    assert.equal(before, after, "a multi-megabyte snapshot write must not touch the drafts file");
  });
});

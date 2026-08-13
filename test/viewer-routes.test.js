process.env.PR_REVIEW_CANVAS_HOST = "127.0.0.1";
process.env.PR_REVIEW_CANVAS_LINK_HOST = "127.0.0.1";

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { parseFileEntry } from "../src/diff/parse-patch.js";
import { writeCachedBlob } from "../src/expand.js";
import { gitRaw, showFromAnyClone } from "../src/local-git.js";
import { layoutFrom, sanitizePrefs } from "../src/server-routes.js";
import { serve } from "../src/server.js";
import { newAccessId, SessionStore } from "../src/session-store.js";

/**
 * The viewer routes over real HTTP: expand-context, preferences, layout and Viewed.
 *
 * The blob cache is seeded before each expand test so nothing here spawns `gh`. That is not a way of
 * dodging the network — it is the same cache the real path writes on its first read, so these tests
 * exercise the branch that runs for every expansion after the first.
 */

const REF = { host: "github.com", owner: "o", repo: "r", number: 1 };
const HEAD = "a".repeat(40);
const KEY = "0123456789abcdef";
const FILE_PATH = "src/server.js";

/**
 * Two hunks with a real gap: new lines 10..13 and 41..44 are in the diff, and 14..40 are not.
 */
const PATCH = [
  "@@ -10,3 +10,4 @@ function a() {",
  "   const a = 1;",
  "+  const b = 2;",
  "   const c = 3;",
  "   return a;",
  "@@ -40,3 +41,4 @@ function z() {",
  "   const x = 1;",
  "+  const y = 2;",
  "   const w = 3;",
  "   return x;",
].join("\n");

/** 50 lines, so the file genuinely ends somewhere. */
const CONTENT = `${Array.from({ length: 50 }, (_, index) => `line ${index + 1}`).join("\n")}\n`;

/**
 * @param {(ctx: any) => Promise<void>} body
 * @param {{ degraded?: boolean, seedBlob?: boolean }} [options]
 */
async function withSession(body, options = {}) {
  const dir = await mkdtemp(path.join(tmpdir(), "prc-vr-"));
  const store = new SessionStore({ env: { ...process.env, PR_REVIEW_CANVAS_STATE_DIR: dir } });
  const file = parseFileEntry(
    /** @type {any} */ ({
      filename: FILE_PATH,
      status: "modified",
      additions: 2,
      deletions: 0,
      changes: 2,
      patch: PATCH,
      sha: "b10b",
    }),
  );
  if (options.degraded) file.degraded = true;
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
      deletions: 0,
      mergeable: "MERGEABLE",
      merged: false,
    },
    files: [file],
    byPath: new Map([[file.path, file]]),
    headSha: HEAD,
    baseSha: "b".repeat(40),
    fetchedAt: new Date().toISOString(),
    fileCountCapped: false,
    counts: { files: 1, additions: 2, deletions: 0, binary: 0, withheld: 0, degraded: 0 },
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
  if (options.seedBlob !== false) await writeCachedBlob(store.paths(KEY).blobs, HEAD, FILE_PATH, CONTENT);

  const server = await serve({ port: 0, version: "9.9.9-test", idleTimeoutMs: null, store });
  const base = `http://127.0.0.1:${server.port}`;
  /** @param {string} suffix @param {RequestInit} [init] */
  const ui = (suffix, init = {}) =>
    fetch(`${base}/api/ui/s/${accessId}${suffix}`, {
      ...init,
      headers: {
        "content-type": "application/json",
        origin: base,
        .../** @type {Record<string, string>} */ (init.headers ?? {}),
      },
    });
  /** @param {string} suffix @param {unknown} payload @param {string} [method] */
  const crossOrigin = (suffix, payload, method = "POST") =>
    fetch(`${base}/api/ui/s/${accessId}${suffix}`, {
      method,
      headers: { "content-type": "application/json", origin: "http://evil.example" },
      body: JSON.stringify(payload),
    });

  try {
    await body({ base, accessId, key: KEY, store, ui, crossOrigin, snapshot });
  } finally {
    await server.close();
    await rm(dir, { recursive: true, force: true });
  }
}

/** @param {string} suffix @param {unknown} payload */
const post = (suffix, payload) => ({ method: "POST", body: JSON.stringify(payload) });

// ---------------------------------------------------------------------------
// Expand
// ---------------------------------------------------------------------------

test("expanding below a hunk returns the hidden lines with both numbers", async () => {
  await withSession(async ({ ui }) => {
    const response = await ui("/expand", post("/expand", { fileIndex: 0, hunkIndex: 0, direction: "after" }));
    assert.equal(response.status, 200);
    const body = await response.json();
    // The first hunk ends at new line 13, so the next hidden line is 14. The old side is one behind,
    // because the hunk added a line.
    assert.equal(body.firstNew, 14);
    assert.deepEqual(body.lines[0], { oldLine: 13, newLine: 14 });
    assert.equal(body.lastNew, 33);
    assert.equal(body.exhausted, false);
    assert.equal(body.source, "cache");
    // The rows are real markup with the content of those lines in them.
    assert.match(body.rows, /line 14/);
    assert.match(body.rows, /data-n="14"/);
  });
});

test("an explicit cursorNew of null means the start of the hunk, not line 0", async () => {
  await withSession(async ({ ui }) => {
    // The exact payload the browser sends on the first click of a hunk. `Number(null)` is 0 and passes
    // `Number.isFinite`, so coercing the value turned "start from the hunk" into "expand above line 0"
    // and found nothing — a button that did nothing at all, on every first click.
    //
    // The earlier tests here omitted the field entirely, which took a different branch and hid the bug.
    // Sending what the client sends is the whole point.
    const body = await (
      await ui("/expand", post("", { fileIndex: 0, hunkIndex: 0, direction: "before", cursorNew: null }))
    ).json();
    assert.equal(body.firstNew, 1, "an explicit null must behave exactly like an omitted field");
    assert.equal(body.lastNew, 9);
    assert.ok(body.rows.length > 0);

    // The same for `after`, and for the other falsy shapes a JSON body can carry.
    for (const cursorNew of [null, undefined, "", false, "12"]) {
      const after = await (
        await ui("/expand", post("", { fileIndex: 0, hunkIndex: 0, direction: "after", cursorNew }))
      ).json();
      assert.equal(after.firstNew, 14, `cursorNew: ${JSON.stringify(cursorNew)} was coerced into a line number`);
    }
    // A real number is still honoured.
    const resumed = await (
      await ui("/expand", post("", { fileIndex: 0, hunkIndex: 0, direction: "after", cursorNew: 20 }))
    ).json();
    assert.equal(resumed.firstNew, 21);
  });
});

test("expanded rows are not commentable, in the HTML the browser will insert", async () => {
  await withSession(async ({ ui }) => {
    const body = await (await ui("/expand", post("", { fileIndex: 0, hunkIndex: 0, direction: "after" }))).json();
    // The whole safety property of expand-context, asserted on the actual payload: no + button, and
    // no cell claiming a side. A comment out here would 422 the entire review.
    assert.equal(body.rows.includes(`data-act="anchor"`), false);
    assert.equal(body.rows.includes(`data-commentable="1"`), false);
    assert.match(body.rows, /prc-line-locked/);
  });
});

test("the cursor advances, and the last chunk before a hunk reports itself exhausted", async () => {
  await withSession(async ({ ui }) => {
    const first = await (await ui("/expand", post("", { fileIndex: 0, hunkIndex: 0, direction: "after" }))).json();
    assert.equal(first.lastNew, 33);
    const second = await (
      await ui("/expand", post("", { fileIndex: 0, hunkIndex: 0, direction: "after", cursorNew: first.lastNew }))
    ).json();
    assert.equal(second.firstNew, 34);
    // The next hunk starts at new line 41, so 40 is the last line there is to show.
    assert.equal(second.lastNew, 40);
    assert.equal(second.exhausted, true);
    const third = await (
      await ui("/expand", post("", { fileIndex: 0, hunkIndex: 0, direction: "after", cursorNew: 40 }))
    ).json();
    assert.equal(third.rows, "");
    assert.equal(third.exhausted, true);
  });
});

test("expanding above the first hunk stops at line 1", async () => {
  await withSession(async ({ ui }) => {
    const body = await (await ui("/expand", post("", { fileIndex: 0, hunkIndex: 0, direction: "before" }))).json();
    assert.equal(body.firstNew, 1);
    assert.equal(body.lastNew, 9);
    // Above the first hunk the two sides have not diverged yet.
    assert.deepEqual(body.lines[0], { oldLine: 1, newLine: 1 });
  });
});

test("expanding past the end of the file stops there rather than erroring", async () => {
  await withSession(async ({ ui }) => {
    const body = await (
      await ui("/expand", post("", { fileIndex: 0, hunkIndex: 1, direction: "after", cursorNew: 44 }))
    ).json();
    // The content is 50 lines; the request asked for 20 from line 45.
    assert.equal(body.lastNew, 50);
    assert.equal(body.exhausted, true);
  });
});

test("split layout is honoured, and the rows have four columns", async () => {
  await withSession(async ({ ui }) => {
    const body = await (
      await ui("/expand", post("", { fileIndex: 0, hunkIndex: 0, direction: "after", layout: "split" }))
    ).json();
    // A context line occupies both columns, so a split row carries the number twice.
    assert.match(body.rows, /prc-line-pair/);
    assert.match(body.rows, /data-mirror="1"/);
  });
});

test("a file whose diff could not be parsed refuses to expand", async () => {
  await withSession(
    async ({ ui }) => {
      const response = await ui("/expand", post("", { fileIndex: 0, hunkIndex: 0, direction: "after" }));
      // Fail closed, the same rule as comment validation: a patch we cannot account for byte-for-byte
      // does not get to imply where its surrounding lines are.
      assert.equal(response.status, 409);
      assert.match((await response.json()).error, /could not be parsed/);
    },
    { degraded: true },
  );
});

test("an unknown file or hunk is a 400, not a crash", async () => {
  await withSession(async ({ ui }) => {
    assert.equal((await ui("/expand", post("", { fileIndex: 99, hunkIndex: 0, direction: "after" }))).status, 400);
    assert.equal((await ui("/expand", post("", { fileIndex: 0, hunkIndex: 99, direction: "after" }))).status, 400);
    assert.equal((await ui("/expand", post("", {}))).status, 400);
  });
});

test("an unrecognised direction is read as `after` rather than refused", async () => {
  await withSession(async ({ ui }) => {
    const body = await (await ui("/expand", post("", { fileIndex: 0, hunkIndex: 0, direction: "sideways" }))).json();
    assert.equal(body.firstNew, 14);
  });
});

// ---------------------------------------------------------------------------
// Preferences and layout
// ---------------------------------------------------------------------------

test("a layout preference is saved and comes back on the session", async () => {
  await withSession(async ({ ui, store, key }) => {
    const response = await ui("/prefs", { method: "PUT", body: JSON.stringify({ prefs: { layout: "split" } }) });
    assert.equal(response.status, 200);
    assert.deepEqual((await response.json()).prefs, { layout: "split" });
    store.invalidate(key);
    assert.equal((await store.load(key))?.prefs.layout, "split");
  });
});

test("preferences are merged, not replaced", async () => {
  await withSession(async ({ ui, store, key }) => {
    await ui("/prefs", { method: "PUT", body: JSON.stringify({ prefs: { layout: "split" } }) });
    await ui("/prefs", { method: "PUT", body: JSON.stringify({ prefs: { wrap: true } }) });
    store.invalidate(key);
    const prefs = (await store.load(key))?.prefs;
    assert.deepEqual(prefs, { layout: "split", wrap: true });
  });
});

test("an unknown preference key is dropped rather than accumulating on disk", async () => {
  await withSession(async ({ ui, store, key }) => {
    await ui("/prefs", { method: "PUT", body: JSON.stringify({ prefs: { nonsense: "x", layout: "split" } }) });
    store.invalidate(key);
    assert.deepEqual((await store.load(key))?.prefs, { layout: "split" });
  });
});

test("the files route renders the layout it is asked for", async () => {
  await withSession(async ({ ui }) => {
    // `<col[ >]` and not `<col`, or `<colgroup` counts as a column too.
    const columns = (/** @type {string} */ html) => (html.match(/<col[ >]/g) ?? []).length;
    const unified = await (await ui("/files/0")).json();
    assert.equal(unified.layout, "unified");
    assert.match(unified.html, /prc-diff-unified/);
    assert.equal(columns(unified.html), 3);

    const split = await (await ui("/files/0?layout=split")).json();
    assert.equal(split.layout, "split");
    assert.match(split.html, /prc-diff-split/);
    assert.equal(columns(split.html), 4);
  });
});

test("an unrecognised layout falls back to unified rather than rendering a broken table", () => {
  // A bad value would otherwise choose a column count, and rows disagreeing with the `<colgroup>`
  // silently shifts every column in the table.
  assert.equal(layoutFrom("split"), "split");
  assert.equal(layoutFrom("unified"), "unified");
  assert.equal(layoutFrom("side-by-side"), "unified");
  assert.equal(layoutFrom(undefined), "unified");
  assert.equal(layoutFrom(["split"]), "unified");
});

test("sanitizePrefs keeps known keys in known shapes", () => {
  assert.deepEqual(sanitizePrefs({ layout: "split", wrap: 1, tabSize: "4" }), {
    layout: "split",
    wrap: false,
    tabSize: 4,
  });
  // Clamped, so a stylesheet cannot be handed a nonsense tab width.
  assert.deepEqual(sanitizePrefs({ tabSize: 999 }), { tabSize: 8 });
  assert.deepEqual(sanitizePrefs({ tabSize: -3 }), { tabSize: 1 });
  assert.deepEqual(sanitizePrefs({ tabSize: "nope" }), { tabSize: 8 });
  assert.deepEqual(sanitizePrefs({}), {});
  assert.deepEqual(sanitizePrefs(null), {});
});

test("ending from the browser records who ended it and tells the tabs", async () => {
  await withSession(async ({ base, accessId, ui, store }) => {
    // The event matters as much as the state: the agent's `end` route has always pushed `ended`, and
    // this one had not, so a review stopped from the toolbar left a second tab still offering a
    // composer for a session no agent was waiting on.
    /** @type {string[]} */
    const events = [];
    const stream = await fetch(`${base}/events/${accessId}`, { headers: { origin: base } });
    const reader = /** @type {ReadableStream<Uint8Array>} */ (stream.body).getReader();
    const decoder = new TextDecoder();
    const collect = (async () => {
      const deadline = Date.now() + 4000;
      while (Date.now() < deadline) {
        const { value, done } = await reader.read();
        if (done) return;
        const text = decoder.decode(value);
        for (const match of text.matchAll(/^event: (.+)$/gm)) events.push(match[1].trim());
        if (events.includes("ended")) return;
      }
    })();

    const response = await ui("/end", { method: "POST" });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { status: "ended" });

    await collect;
    await reader.cancel();
    assert.ok(events.includes("ended"), `no ended event arrived; saw ${JSON.stringify(events)}`);

    const session = await store.load(KEY);
    assert.equal(session?.status, "ended");
    // Recorded, because `open` refuses to resume a session the *user* ended unless asked with
    // `--reopen`, while one the agent ended reopens freely.
    assert.equal(session?.endedBy, "user");
  });
});

test("an unknown theme falls back to system rather than being stamped on the page", () => {
  // The value is written straight into `data-theme` on <html> the next time the page is served. One
  // that matches no rule reads as light, which is the wrong answer for a reviewer whose OS is dark.
  for (const theme of ["system", "light", "dark"]) {
    assert.deepEqual(sanitizePrefs({ theme }), { theme });
  }
  assert.deepEqual(sanitizePrefs({ theme: "solarized" }), { theme: "system" });
  assert.deepEqual(sanitizePrefs({ theme: 7 }), { theme: "system" });
});

// ---------------------------------------------------------------------------
// Viewed
// ---------------------------------------------------------------------------

test("Viewed is recorded with the SHA it was ticked at", async () => {
  await withSession(async ({ ui, store, key }) => {
    await ui("/viewed", { method: "PUT", body: JSON.stringify({ path: FILE_PATH, viewed: true }) });
    store.invalidate(key);
    const mark = (await store.load(key))?.viewed[FILE_PATH];
    // Without the SHA a tick would survive a force-push, claiming the reviewer read a version of the
    // file they never saw.
    assert.equal(mark?.atSha, HEAD);
    assert.ok(Date.parse(String(mark?.at)) > 0);
  });
});

test("un-viewing removes the mark entirely", async () => {
  await withSession(async ({ ui, store, key }) => {
    await ui("/viewed", { method: "PUT", body: JSON.stringify({ path: FILE_PATH, viewed: true }) });
    await ui("/viewed", { method: "PUT", body: JSON.stringify({ path: FILE_PATH, viewed: false }) });
    store.invalidate(key);
    assert.equal((await store.load(key))?.viewed[FILE_PATH], undefined);
  });
});

// ---------------------------------------------------------------------------
// The prefix guard still holds for the new routes
// ---------------------------------------------------------------------------

test("the new mutating routes refuse a cross-origin request", async () => {
  await withSession(async ({ crossOrigin, store, key }) => {
    for (const [suffix, payload, method] of /** @type {Array<[string, unknown, string]>} */ ([
      ["/expand", { fileIndex: 0, hunkIndex: 0, direction: "after" }, "POST"],
      ["/prefs", { prefs: { layout: "split" } }, "PUT"],
      ["/viewed", { path: FILE_PATH, viewed: true }, "PUT"],
    ])) {
      const response = await crossOrigin(suffix, payload, method);
      assert.equal(response.status, 403, `${method} ${suffix} was not refused`);
    }
    // And nothing was written.
    store.invalidate(key);
    const session = await store.load(key);
    assert.deepEqual(session?.prefs, {});
    assert.deepEqual(session?.viewed, {});
  });
});

// ---------------------------------------------------------------------------
// The local-git path, against a real repository
// ---------------------------------------------------------------------------

test("a real local clone answers for a commit it has, and declines one it does not", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "prc-git-"));
  try {
    await gitRaw(["init", "-q", "--initial-branch=main", "."], { cwd: dir });
    await gitRaw(["config", "user.email", "t@example.com"], { cwd: dir });
    await gitRaw(["config", "user.name", "Test"], { cwd: dir });
    const { writeFile } = await import("node:fs/promises");
    await writeFile(path.join(dir, "a.js"), "one\ntwo\n", "utf8");
    await gitRaw(["add", "a.js"], { cwd: dir });
    await gitRaw(["commit", "-q", "-m", "first"], { cwd: dir });
    const head = (await gitRaw(["rev-parse", "HEAD"], { cwd: dir })).stdout.trim();

    const found = await showFromAnyClone([dir], head, "a.js");
    assert.equal(found?.content, "one\ntwo\n");
    assert.equal(found?.repoDir, dir);

    // A commit this clone has never seen: declined, not thrown. Falling back to the API is the
    // normal outcome, because the session belongs to the PR rather than to any checkout.
    assert.equal(await showFromAnyClone([dir], "b".repeat(40), "a.js"), null);
    // A path that does not exist at a commit the clone does have.
    assert.equal(await showFromAnyClone([dir], head, "missing.js"), null);
    // A directory that is not a repository at all.
    assert.equal(await showFromAnyClone([tmpdir()], head, "a.js"), null);
    // And no clones configured is simply "no".
    assert.equal(await showFromAnyClone([], head, "a.js"), null);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

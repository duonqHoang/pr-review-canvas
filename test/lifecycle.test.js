process.env.PR_REVIEW_CANVAS_HOST = "127.0.0.1";
process.env.PR_REVIEW_CANVAS_LINK_HOST = "127.0.0.1";

import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { buildId } from "../src/build-id.js";
import { portCandidates, PORT_LADDER_LENGTH, shouldRestartServer } from "../src/server-control.js";
import { serve } from "../src/server.js";
import { newAccessId, SessionStore } from "../src/session-store.js";

/**
 * Server lifecycle: which port gets used, whether a stale process is detected, and whether a
 * shutdown can lose a write.
 *
 * The last one is the reason this file exists. A review session holds prose that exists nowhere else,
 * so a shutdown that races an in-flight save is not an inconvenience — it is the failure this whole
 * storage design was built to avoid.
 */

const KEY = "0123456789abcdef";
const REF = { host: "github.com", owner: "o", repo: "r", number: 1 };

/** @param {(ctx: { store: SessionStore, dir: string }) => Promise<void>} body */
async function withStore(body) {
  const dir = await mkdtemp(path.join(tmpdir(), "prc-life-"));
  const store = new SessionStore({ env: { ...process.env, PR_REVIEW_CANVAS_STATE_DIR: dir } });
  try {
    await body({ store, dir });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// The port ladder
// ---------------------------------------------------------------------------

test("the ladder tries the recorded port first, then the default, then upwards", () => {
  const candidates = portCandidates({ port: 4391, preferPort: 4393 });
  // Recorded first: a server that ended up on 4393 last time holds live sessions and a browser tab,
  // and starting a second one on a since-freed 4391 would orphan both.
  assert.equal(candidates[0], 4393);
  assert.equal(candidates[1], 4391);
  assert.equal(candidates.length, PORT_LADDER_LENGTH);
  // No duplicates, even though 4393 also falls inside the ladder's range.
  assert.equal(new Set(candidates).size, candidates.length);
});

test("an explicitly named port is the only candidate", () => {
  // A named port is an instruction. Quietly using a different one would leave the user's own
  // configuration silently not in effect.
  assert.deepEqual(portCandidates({ port: 5000, ladder: false }), [5000]);
});

test("port 0 means any free port, so there is nothing to ladder from", () => {
  assert.deepEqual(portCandidates({ port: 0 }), []);
});

test("the chosen port is recorded and read back", async () => {
  await withStore(async ({ store, dir }) => {
    assert.equal(await store.recordedPort(), null);
    await store.recordPort(4393);
    assert.equal(await store.recordedPort(), 4393);

    // Written into the shared index rather than a file of its own, and without disturbing the
    // session entries that live in the same object.
    const accessId = newAccessId();
    await store.upsert({
      ref: /** @type {any} */ (REF),
      key: KEY,
      accessId,
      url: "http://127.0.0.1/review/x",
      displayRef: "o/r#1",
    });
    const index = JSON.parse(await readFile(path.join(dir, "index.json"), "utf8"));
    assert.equal(index.port, 4393);
    assert.equal(index.sessions[KEY].accessId, accessId);
  });
});

test("a nonsense recorded port is ignored rather than dialled", async () => {
  await withStore(async ({ store, dir }) => {
    await writeFile(path.join(dir, "index.json"), JSON.stringify({ version: 1, sessions: {}, port: "banana" }), "utf8");
    assert.equal(await store.recordedPort(), null);
  });
});

// ---------------------------------------------------------------------------
// Detecting a stale server
// ---------------------------------------------------------------------------

test("a server running different code is replaced even when the version matches", async () => {
  const health = { ok: true, app: "pr-review-canvas", version: "1.0.0", build: "aaaaaaaaaaaaaaaa" };
  // The everyday development case: the version cannot change between edits, so on version alone a
  // background process serves code from ten minutes ago and the fix appears not to work.
  assert.equal(shouldRestartServer("1.0.0", health, false, "bbbbbbbbbbbbbbbb"), true);
  assert.equal(shouldRestartServer("1.0.0", health, false, "aaaaaaaaaaaaaaaa"), false);
  // No expected id means the caller does not know its own, so the id is not evidence.
  assert.equal(shouldRestartServer("1.0.0", health, false, ""), false);
  // A version mismatch still decides on its own, regardless of the id.
  assert.equal(shouldRestartServer("2.0.0", health, false, "aaaaaaaaaaaaaaaa"), true);
});

test("a server with no build id at all is treated as stale when one is expected", () => {
  const health = { ok: true, app: "pr-review-canvas", version: "1.0.0" };
  assert.equal(shouldRestartServer("1.0.0", health, false, "aaaaaaaaaaaaaaaa"), true);
});

test("the build id follows content, not timestamps", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "prc-build-"));
  try {
    await writeFile(path.join(dir, "a.js"), "export const a = 1;\n", "utf8");
    await writeFile(path.join(dir, "notes.md"), "not code\n", "utf8");
    const first = await buildId(dir);

    // Rewriting identical bytes moves the mtime and must not change the id: a `git checkout` does
    // exactly that, and an id that flapped on branch switches would restart the server — and close
    // the user's tab — for nothing.
    await writeFile(path.join(dir, "a.js"), "export const a = 1;\n", "utf8");
    assert.equal(await buildId(dir), first);

    // A file the server neither runs nor serves is not part of its identity.
    await writeFile(path.join(dir, "notes.md"), "still not code\n", "utf8");
    assert.equal(await buildId(dir), first);

    await writeFile(path.join(dir, "a.js"), "export const a = 2;\n", "utf8");
    assert.notEqual(await buildId(dir), first);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a missing tree yields an id rather than an error", async () => {
  // A build id is a diagnostic. Refusing to serve /health over one would be worse than a vaguer
  // answer, because /health is how everything else decides whether the server is alive at all.
  assert.match(await buildId(path.join(tmpdir(), "prc-does-not-exist-", String(Date.now()))), /^[0-9a-f]{16}$/);
});

// ---------------------------------------------------------------------------
// Shutdown must not race a write
// ---------------------------------------------------------------------------

test("shutdown waits for an in-flight mutation instead of exiting under it", async () => {
  await withStore(async ({ store }) => {
    await store.upsert({
      ref: /** @type {any} */ (REF),
      key: KEY,
      accessId: newAccessId(),
      url: "http://127.0.0.1/review/x",
      displayRef: "o/r#1",
    });

    const server = await serve({ port: 0, version: "9.9.9-test", idleTimeoutMs: null, store });
    // A mutation that is deliberately still running when the shutdown begins.
    let finished = false;
    const slow = store.runExclusive(KEY, async () => {
      await new Promise((resolve) => setTimeout(resolve, 120));
      await store.commit(KEY, {
        op: "comment:add",
        at: new Date().toISOString(),
        payload: { comment: { id: "c_slow", anchor: { kind: "file", path: "a.js" }, body: "kept", state: "draft" } },
      });
      finished = true;
    });

    await server.close();
    // The close resolved only after the write completed. Without `store.drain()` this assertion
    // fails, and in production the lost write is a comment the user had already typed.
    assert.equal(finished, true, "close() returned while a mutation was still running");
    await slow;

    store.invalidate();
    const reloaded = await store.load(KEY);
    assert.equal(reloaded?.comments.at(-1)?.id, "c_slow");
  });
});

test("drain returns immediately when nothing is in flight", async () => {
  await withStore(async ({ store }) => {
    await store.drain();
    await store.upsert({
      ref: /** @type {any} */ (REF),
      key: KEY,
      accessId: newAccessId(),
      url: "http://127.0.0.1/review/x",
      displayRef: "o/r#1",
    });
    // Settled locks stay in the map, so this is the case where a naive implementation loops forever.
    await store.drain();
  });
});

test("drain also waits for work a settled mutation queued behind it", async () => {
  await withStore(async ({ store }) => {
    const order = /** @type {string[]} */ ([]);
    store.runExclusive(KEY, async () => {
      await new Promise((resolve) => setTimeout(resolve, 30));
      order.push("first");
      // Queued from inside the first operation: the chain grows while `drain` is already awaiting it.
      store.runExclusive(KEY, async () => {
        await new Promise((resolve) => setTimeout(resolve, 30));
        order.push("second");
      });
    });

    await store.drain();
    assert.deepEqual(order, ["first", "second"]);
  });
});

// ---------------------------------------------------------------------------
// A foreign process on the port
// ---------------------------------------------------------------------------

test("a foreign server on the port is stepped over, not argued with", async () => {
  // A plain HTTP server that answers /health with someone else's JSON, which is exactly what the
  // ladder exists for: a review session outlives many other processes' idea of what a port is for.
  const foreign = http.createServer((req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, app: "something-else" }));
  });
  await new Promise((resolve) => foreign.listen(0, "127.0.0.1", () => resolve(undefined)));
  const address = foreign.address();
  const taken = typeof address === "object" && address ? address.port : 0;

  try {
    const { ensureServer } = await import("../src/server-control.js");
    // The ladder starts on the occupied port; the next one is free, and a real server is started
    // there. `entry` is the repository's own bin, so this genuinely spawns the CLI.
    const here = path.dirname(new URL(import.meta.url).pathname);
    const dir = await mkdtemp(path.join(tmpdir(), "prc-ladder-"));
    try {
      /** @type {number[]} */
      const chosen = [];
      const result = await ensureServer({
        baseUrlFor: (port) => `http://127.0.0.1:${port}`,
        host: "127.0.0.1",
        port: taken,
        version: "0.0.0-ladder",
        entry: path.join(here, "..", "bin", "pr-review-canvas.js"),
        logFile: path.join(dir, "server.log"),
        onPortChosen: (port) => {
          chosen.push(port);
        },
      });
      assert.equal(result.started, true);
      assert.notEqual(result.port, taken, "the foreign server was left alone");
      assert.deepEqual(chosen, [result.port], "the chosen port is reported so it can be recorded");

      // And it really is ours, on the port the ladder reported.
      const health = await (await fetch(`${result.baseUrl}/health`)).json();
      assert.equal(health.app, "pr-review-canvas");
      await fetch(`${result.baseUrl}/shutdown`, { method: "POST" });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  } finally {
    // `closeAllConnections` first: `fetchHealth` goes through undici, which keeps the socket alive,
    // and `close()` alone waits for it — long enough to look like a hung test rather than a slow one.
    foreign.closeAllConnections?.();
    await new Promise((resolve) => foreign.close(() => resolve(undefined)));
  }
});

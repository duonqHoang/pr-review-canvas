import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { parseFileEntry } from "../src/diff/parse-patch.js";
import {
  blobCachePath,
  EXPAND_CHUNK_LINES,
  evictBlobs,
  expandedLines,
  expandRange,
  loadFileLines,
  MAX_BLOB_BYTES,
  readCachedBlob,
  writeCachedBlob,
} from "../src/expand.js";
import { isShaLike } from "../src/local-git.js";
import { fixture } from "./fixtures/diffs.js";

/**
 * Expand-context, tested where it actually breaks.
 *
 * Every interesting failure in this feature is an off-by-one: a line shown twice, a line skipped, or
 * an old-side number that is one out and therefore labels the wrong line. None of those throw, and
 * all of them are tedious to spot in a browser — so the arithmetic is separated from the fetching and
 * pinned against hunk headers whose line maths is worked out by hand in the comments.
 */

/** @param {string} name */
const parsed = (name) => parseFileEntry(fixture(name).entry);

// `multi-hunk-gap` is:
//   @@ -10,3 +10,4 @@   old 10..12, new 10..13
//   @@ -40,3 +41,4 @@   old 40..42, new 41..44
// so new 14..40 is hidden between them, and new 1..9 is hidden above.
const GAP = "multi-hunk-gap";

test("above the first hunk, expansion reaches line 1 and no further", () => {
  const file = parsed(GAP);
  const range = expandRange(file, 0, "before", { lineCount: 20 });
  assert.deepEqual(range, { startNew: 1, endNew: 9, oldOffset: 0, boundedByHunk: false });
});

test("above a later hunk, expansion stops at the previous hunk's last line", () => {
  const file = parsed(GAP);
  // The first hunk ends at new line 13, so 14 is the floor. 20 lines back from 40 is 21.
  const first = expandRange(file, 1, "before", { lineCount: 20 });
  assert.deepEqual(first, { startNew: 21, endNew: 40, oldOffset: 1, boundedByHunk: false });
  // The next click closes the gap exactly, and says it hit a hunk rather than the file's edge.
  const second = expandRange(file, 1, "before", { lineCount: 20, cursorNew: 21 });
  assert.deepEqual(second, { startNew: 14, endNew: 20, oldOffset: 1, boundedByHunk: true });
  // And there is nothing left after that.
  assert.equal(expandRange(file, 1, "before", { lineCount: 20, cursorNew: 14 }), null);
});

test("below a hunk, expansion stops before the next hunk", () => {
  const file = parsed(GAP);
  const range = expandRange(file, 0, "after", { lineCount: 20 });
  // The hunk's last new line is 13, so the next hidden line is 14; the next hunk starts at 41.
  assert.deepEqual(range, { startNew: 14, endNew: 33, oldOffset: 1, boundedByHunk: false });
  const rest = expandRange(file, 0, "after", { lineCount: 20, cursorNew: 33 });
  assert.deepEqual(rest, { startNew: 34, endNew: 40, oldOffset: 1, boundedByHunk: true });
  assert.equal(expandRange(file, 0, "after", { lineCount: 20, cursorNew: 40 }), null);
});

test("the old-side offset is taken from the hunk boundary, not guessed", () => {
  const file = parsed(GAP);
  // Before a hunk the sides differ by newStart - oldStart; after it, by the ends. For this file
  // that is 0 above the first hunk and 1 below it, because the hunk adds one line.
  assert.equal(expandRange(file, 0, "before", {})?.oldOffset, 0);
  assert.equal(expandRange(file, 0, "after", {})?.oldOffset, 1);
  // Above the second hunk the offset is already 1; below it, two additions have accumulated.
  assert.equal(expandRange(file, 1, "before", {})?.oldOffset, 1);
  assert.equal(expandRange(file, 1, "after", {})?.oldOffset, 2);
});

test("adjacent hunks leave nothing to expand between them", () => {
  // `adjacent-hunks` is @@ -1,2 +1,3 @@ then @@ -3,2 +4,3 @@: new 1..3 then new 4..6, continuous.
  const file = parsed("adjacent-hunks");
  assert.equal(expandRange(file, 1, "before", {}), null);
  assert.equal(expandRange(file, 0, "after", {}), null);
  // And nothing above a hunk that already starts at line 1.
  assert.equal(expandRange(file, 0, "before", {}), null);
});

test("below the last hunk the ceiling is the file's length, when known", () => {
  const file = parsed(GAP);
  const bounded = expandRange(file, 1, "after", { lineCount: 20, fileLineCount: 50 });
  assert.deepEqual(bounded, { startNew: 45, endNew: 50, oldOffset: 2, boundedByHunk: false });
  // Without the length the range is optimistic and gets truncated by the content instead — the diff
  // genuinely does not say how long the file is.
  const open = expandRange(file, 1, "after", { lineCount: 20 });
  assert.equal(open?.startNew, 45);
  assert.equal(open?.endNew, 64);
});

test("the default chunk is one screenful", () => {
  const file = parsed(GAP);
  const range = expandRange(file, 1, "before", {});
  assert.equal((range?.endNew ?? 0) - (range?.startNew ?? 0) + 1, EXPAND_CHUNK_LINES);
});

test("a request for an unknown hunk expands nothing", () => {
  const file = parsed(GAP);
  assert.equal(expandRange(file, 99, "before", {}), null);
  assert.equal(expandRange(file, -1, "after", {}), null);
});

test("already-expanded rows in the snapshot move the boundary too", () => {
  // The server-rendered path reads `file.expanded`; the browser path sends `cursorNew`. Both have to
  // move the boundary, or a server re-render would repeat lines the client already has.
  const file = parsed(GAP);
  file.expanded["beforeHunk:1"] = /** @type {any} */ ([{ newLine: 30 }]);
  assert.equal(expandRange(file, 1, "before", { lineCount: 5 })?.endNew, 29);
  // An explicit cursor wins, because the browser is the authority on what is on screen.
  assert.equal(expandRange(file, 1, "before", { lineCount: 5, cursorNew: 25 })?.endNew, 24);
});

// ---------------------------------------------------------------------------
// Turning a range into rows
// ---------------------------------------------------------------------------

const CONTENT = Array.from({ length: 12 }, (_, index) => `line ${index + 1}`);

test("expanded lines carry both numbers and are never commentable", () => {
  const rows = expandedLines(CONTENT, { startNew: 3, endNew: 5, oldOffset: 1, boundedByHunk: false }, 0, "before");
  assert.deepEqual(
    rows.map((row) => [row.oldLine, row.newLine, row.text]),
    [
      [2, 3, "line 3"],
      [3, 4, "line 4"],
      [4, 5, "line 5"],
    ],
  );
  for (const row of rows) {
    // This single field is what stops the renderer offering a `+` and the validator certifying the
    // line. A comment out here is a 422 that rejects the whole review batch.
    assert.deepEqual(row.commentableSides, []);
    assert.equal(row.origin, "expanded");
    assert.equal(row.kind, "context");
  }
});

test("row keys are unique across directions and hunks", () => {
  const before = expandedLines(CONTENT, { startNew: 1, endNew: 3, oldOffset: 0, boundedByHunk: false }, 0, "before");
  const after = expandedLines(CONTENT, { startNew: 1, endNew: 3, oldOffset: 0, boundedByHunk: false }, 0, "after");
  const other = expandedLines(CONTENT, { startNew: 1, endNew: 3, oldOffset: 0, boundedByHunk: false }, 1, "before");
  const keys = [...before, ...after, ...other].map((row) => row.key);
  assert.equal(new Set(keys).size, keys.length);
});

test("running past the end of the file stops, rather than inventing lines", () => {
  // The normal outcome of clicking `after` on the last hunk: the diff cannot say where the file ends.
  const rows = expandedLines(CONTENT, { startNew: 11, endNew: 40, oldOffset: 0, boundedByHunk: false }, 0, "after");
  assert.equal(rows.length, 2);
  assert.equal(rows.at(-1)?.newLine, 12);
});

test("an empty line of content is a line, not an absence", () => {
  const rows = expandedLines(
    ["a", "", "c"],
    { startNew: 1, endNew: 3, oldOffset: 0, boundedByHunk: false },
    0,
    "before",
  );
  assert.equal(rows.length, 3);
  assert.equal(rows[1].text, "");
});

// ---------------------------------------------------------------------------
// Content sourcing and the blob cache
// ---------------------------------------------------------------------------

/** @param {(dir: string) => Promise<void>} body */
async function withTempDir(body) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "prc-expand-"));
  try {
    await body(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const REF = { host: "github.com", owner: "o", repo: "r", number: 1 };

test("a local clone is preferred over the API, and the result is cached", async () => {
  await withTempDir(async (dir) => {
    let apiCalls = 0;
    const deps = {
      fetchBlobLinesImpl: async () => {
        apiCalls += 1;
        return ["from api"];
      },
      showFromAnyCloneImpl: async () => ({ content: "from git\nsecond\n", repoDir: "/repo" }),
    };
    const input = { cacheDir: dir, localRepos: ["/repo"], ref: /** @type {any} */ (REF), sha: "abc1234", path: "a.js" };
    const first = await loadFileLines(input, deps);
    assert.deepEqual(first, { lines: ["from git", "second"], source: "local-git" });
    assert.equal(apiCalls, 0, "the API must not be touched when a clone can answer");

    // The second read comes from the cache, so neither git nor the API is consulted again.
    const second = await loadFileLines(input, {
      fetchBlobLinesImpl: async () => {
        throw new Error("the API should not be called");
      },
      showFromAnyCloneImpl: async () => {
        throw new Error("git should not be called");
      },
    });
    assert.deepEqual(second, { lines: ["from git", "second"], source: "cache" });
  });
});

test("with no usable clone the API answers, and that is cached too", async () => {
  await withTempDir(async (dir) => {
    const input = { cacheDir: dir, localRepos: [], ref: /** @type {any} */ (REF), sha: "abc1234", path: "dir/a.js" };
    const result = await loadFileLines(input, {
      fetchBlobLinesImpl: async () => ["one", "two"],
      showFromAnyCloneImpl: async () => null,
    });
    assert.deepEqual(result, { lines: ["one", "two"], source: "api" });
    assert.equal(await readCachedBlob(dir, "abc1234", "dir/a.js"), "one\ntwo\n");
  });
});

test("a failure to read the file is reported, never guessed at", async () => {
  await withTempDir(async (dir) => {
    await assert.rejects(
      loadFileLines(
        { cacheDir: dir, localRepos: [], ref: /** @type {any} */ (REF), sha: "abc1234", path: "a.js" },
        {
          fetchBlobLinesImpl: async () => {
            throw new Error("HTTP 404");
          },
          showFromAnyCloneImpl: async () => null,
        },
      ),
      (error) => {
        // Fabricating context would put a comment affordance next to a line that may not exist.
        assert.match(String(/** @type {Error} */ (error).message), /Could not read a\.js at abc1234/);
        assert.equal(/** @type {any} */ (error).code, "DEPENDENCY_ERROR");
        return true;
      },
    );
  });
});

test("a path with separators becomes one flat cache filename", async () => {
  await withTempDir(async (dir) => {
    // Otherwise a repository path could escape the cache directory, or collide with a directory of
    // its own name.
    const file = blobCachePath(dir, "sha", "a/b/../c.js");
    assert.equal(path.dirname(file), path.join(dir, "sha"));
    assert.equal(path.basename(file), encodeURIComponent("a/b/../c.js"));
    await writeCachedBlob(dir, "sha", "a/b/../c.js", "content\n");
    assert.equal(await readCachedBlob(dir, "sha", "a/b/../c.js"), "content\n");
  });
});

test("two commits of the same path cache separately", async () => {
  await withTempDir(async (dir) => {
    await writeCachedBlob(dir, "aaaaaaa", "a.js", "old\n");
    await writeCachedBlob(dir, "bbbbbbb", "a.js", "new\n");
    assert.equal(await readCachedBlob(dir, "aaaaaaa", "a.js"), "old\n");
    assert.equal(await readCachedBlob(dir, "bbbbbbb", "a.js"), "new\n");
  });
});

test("a blob over the size limit is simply not cached", async () => {
  await withTempDir(async (dir) => {
    const huge = "x".repeat(MAX_BLOB_BYTES + 1);
    await writeCachedBlob(dir, "sha", "big.js", huge);
    assert.equal(await readCachedBlob(dir, "sha", "big.js"), null);
    // And not caching it is not an error: the file is still readable, just not cheaply.
  });
});

test("a missing cache entry reads as null rather than throwing", async () => {
  await withTempDir(async (dir) => {
    assert.equal(await readCachedBlob(dir, "sha", "never-written.js"), null);
    assert.equal(await readCachedBlob(path.join(dir, "nope"), "sha", "a.js"), null);
  });
});

test("eviction drops the least recently used blobs first", async () => {
  await withTempDir(async (dir) => {
    const sha = path.join(dir, "sha");
    await mkdir(sha, { recursive: true });
    for (const name of ["old", "mid", "new"]) await writeFile(path.join(sha, name), "x".repeat(100), "utf8");
    // Ages set explicitly; relying on write order would make this a race.
    const base = Date.now();
    await utimes(path.join(sha, "old"), new Date(base - 30_000), new Date(base - 30_000));
    await utimes(path.join(sha, "mid"), new Date(base - 20_000), new Date(base - 20_000));
    await utimes(path.join(sha, "new"), new Date(base), new Date(base));

    await evictBlobs(dir, 150);
    await assert.rejects(stat(path.join(sha, "old")));
    await assert.rejects(stat(path.join(sha, "mid")));
    assert.equal(await readFile(path.join(sha, "new"), "utf8"), "x".repeat(100));
  });
});

test("eviction on an absent cache directory does nothing quietly", async () => {
  await withTempDir(async (dir) => {
    await evictBlobs(path.join(dir, "missing"), 10);
  });
});

test("only a plain hex object name is accepted as a revision", () => {
  // The SHA is interpolated into a `git show <sha>:<path>` argument, so a ref name could resolve to
  // something else entirely and `..` would turn one revision into a range.
  assert.equal(isShaLike("4b8c3ae"), true);
  assert.equal(isShaLike("36d95a9375c5b166cebdca5fc8879bcdc8db9e0d"), true);
  assert.equal(isShaLike("HEAD"), false);
  assert.equal(isShaLike("main"), false);
  assert.equal(isShaLike("abc..def"), false);
  assert.equal(isShaLike("abc123; rm -rf /"), false);
  assert.equal(isShaLike(""), false);
  assert.equal(isShaLike("abc12"), false, "too short to be an object name");
});

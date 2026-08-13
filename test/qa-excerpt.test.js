import assert from "node:assert/strict";
import test from "node:test";
import { parseFileEntry } from "../src/diff/parse-patch.js";
import {
  buildExcerpt,
  buildQuestionPayload,
  EXCERPT_CONTEXT_LINES,
  EXCERPT_MAX_BYTES,
  EXCERPT_MAX_LINES,
  MAX_LINE_CHARS,
  selectedIndices,
} from "../src/qa-excerpt.js";
import { blobLinkFor, blobPermalink, encodePathForUrl, lineSuffix } from "../src/shared/permalink.js";

/**
 * The excerpt is the only unbounded path from the browser into the agent's context, so these tests
 * are about the caps holding rather than about the prettiness of the output.
 */

/**
 * A file with two hunks, so a range spanning the gap can be exercised.
 *
 * @param {string} patch
 * @param {Partial<import("../src/diff/parse-patch.js").GhFileEntry>} [extra]
 */
function file(patch, extra = {}) {
  return parseFileEntry(
    /** @type {any} */ ({
      filename: "src/paths.js",
      status: "modified",
      additions: 2,
      deletions: 1,
      changes: 3,
      patch,
      sha: "b10b5ha",
      ...extra,
    }),
  );
}

const twoHunks = file(
  [
    "@@ -10,6 +10,7 @@ function bindHost() {",
    " const a = 1;",
    " const b = 2;",
    " const c = 3;",
    "+const added = 4;",
    " const d = 5;",
    " const e = 6;",
    "-const gone = 7;",
    "+const kept = 7;",
    "@@ -40,2 +41,2 @@ function other() {",
    " far away 1",
    "-far away 2",
    "+far away two",
  ].join("\n"),
);

test("the two-hunk fixture parses cleanly, so the rest of the file tests something real", () => {
  assert.deepEqual(twoHunks.diagnostics, []);
  assert.equal(twoHunks.degraded, false);
});

test("selectedIndices ignores commentability, because a question may be asked anywhere", () => {
  const flat = twoHunks.hunks.flatMap((hunk) => hunk.lines);
  // Line 13 on the new side is the added line; 10-12 are context, which `lineAt` would accept for
  // RIGHT anyway. The point is that nothing here consults `commentableSides`.
  const indices = selectedIndices(flat, "RIGHT", 10, 13);
  assert.deepEqual(
    indices.map((index) => flat[index].newLine),
    [10, 11, 12, 13],
  );
  // A deletion has no new-side number and is therefore not selected by a RIGHT range.
  const rightRange = selectedIndices(flat, "RIGHT", 14, 16).map((index) => flat[index].kind);
  assert.ok(!rightRange.includes("del"));
});

test("an excerpt marks the selected lines and keeps the configured context", () => {
  const excerpt = buildExcerpt(twoHunks, { side: "RIGHT", line: 13 });
  assert.equal(excerpt.resolved, true);
  const lines = excerpt.code.split("\n");
  const selected = lines.filter((line) => line.startsWith(">"));
  assert.equal(selected.length, 1);
  assert.match(selected[0], /const added = 4;$/);
  // The added line is 4th in the first hunk, so only 3 lines of leading context exist.
  assert.ok(lines.length <= 1 + 2 * EXCERPT_CONTEXT_LINES);
  assert.equal(excerpt.quote, "const added = 4;");
  assert.equal(excerpt.truncated, false);
});

test("a deletion excerpt shows the old line number, matching its `-` marker", () => {
  // `const gone = 7;` is old line 15: 10-12 are context, the addition consumes no old number,
  // 13-14 are context, and the deletion lands on 15.
  const excerpt = buildExcerpt(twoHunks, { side: "LEFT", line: 15 });
  const selected = excerpt.code.split("\n").filter((line) => line.startsWith(">"));
  assert.equal(selected.length, 1);
  assert.match(selected[0], /^>-\s*15 \| const gone = 7;$/);
});

test("an anchor outside the parsed diff resolves to nothing rather than to invented context", () => {
  const excerpt = buildExcerpt(twoHunks, { side: "RIGHT", line: 9999 });
  assert.deepEqual(excerpt, { resolved: false, code: "", quote: "", rows: 0, truncated: false });
});

test("the row cap holds, and truncating the selection itself is reported", () => {
  const body = Array.from({ length: 200 }, (_, index) => `+line ${index}`);
  const big = file([`@@ -1,0 +1,200 @@`, ...body].join("\n"));
  const excerpt = buildExcerpt(big, { side: "RIGHT", line: 200, startLine: 1 });
  const lines = excerpt.code.split("\n");
  // 40 rows plus at most one elision marker.
  assert.ok(lines.length <= EXCERPT_MAX_LINES + 1, `got ${lines.length} lines`);
  assert.equal(excerpt.truncated, true);
  assert.match(excerpt.code, /selection truncated/);
});

test("the byte cap holds even when every line is wide", () => {
  const wide = "x".repeat(2000);
  const body = Array.from({ length: 30 }, () => `+${wide}`);
  const big = file([`@@ -1,0 +1,30 @@`, ...body].join("\n"));
  const excerpt = buildExcerpt(big, { side: "RIGHT", line: 30, startLine: 1 });
  assert.ok(
    Buffer.byteLength(excerpt.code, "utf8") <= EXCERPT_MAX_BYTES,
    `excerpt was ${Buffer.byteLength(excerpt.code, "utf8")} bytes`,
  );
  assert.equal(excerpt.truncated, true);
  // Per-line clipping is what keeps one pathological minified line from eating the whole budget.
  for (const line of excerpt.code.split("\n")) {
    assert.ok(line.length <= MAX_LINE_CHARS + 32, `line was ${line.length} chars`);
  }
});

test("a multi-byte character is never cut in half by the byte cap", () => {
  // Every line is 4-byte astral text, so the hard truncation branch is the one exercised.
  const wide = "𝔘".repeat(1500);
  const big = file([`@@ -1,0 +1,2 @@`, `+${wide}`, `+${wide}`].join("\n"));
  const excerpt = buildExcerpt(big, { side: "RIGHT", line: 1 });
  assert.ok(Buffer.byteLength(excerpt.code, "utf8") <= EXCERPT_MAX_BYTES);
  assert.ok(!excerpt.code.includes("�"), "the excerpt contains a replacement character");
});

test("a question payload carries the code, a permalink and the question - and nothing else", () => {
  const snapshot = {
    ref: { host: "github.com", owner: "Owner", repo: "Repo", number: 7 },
    headSha: "aaaa111",
    baseSha: "bbbb222",
    files: [twoHunks],
    byPath: new Map([[twoHunks.path, twoHunks]]),
  };
  const payload = buildQuestionPayload({
    snapshot: /** @type {any} */ (snapshot),
    thread: /** @type {any} */ ({
      id: "q_1",
      anchor: { kind: "line", path: "src/paths.js", side: "RIGHT", line: 13 },
      messages: [{ role: "user", text: "Why 4?", at: "2026-01-01T00:00:00.000Z" }],
      status: "open",
    }),
  });

  assert.equal(payload.id, "q_1");
  assert.equal(payload.kind, "question");
  assert.equal(payload.path, "src/paths.js");
  assert.equal(payload.side, "RIGHT");
  assert.equal(payload.lines, "13");
  assert.equal(payload.question, "Why 4?");
  assert.equal(payload.permalink, "https://github.com/Owner/Repo/blob/aaaa111/src/paths.js#L13");
  assert.match(String(payload.code), /const added = 4;/);
  assert.equal(payload.follow_up, undefined);
  assert.deepEqual(
    Object.keys(payload)
      .filter((name) => !name.startsWith("code") && name !== "selected_text")
      .sort(),
    ["id", "kind", "lines", "path", "permalink", "question", "side"],
  );
});

test("a payload for a range reports the range, and a follow-up says so", () => {
  const snapshot = {
    ref: { host: "ghe.example.com", owner: "o", repo: "r", number: 1 },
    headSha: "head",
    baseSha: "base",
    files: [twoHunks],
    byPath: new Map([[twoHunks.path, twoHunks]]),
  };
  const payload = buildQuestionPayload({
    snapshot: /** @type {any} */ (snapshot),
    kind: "question_followup",
    thread: /** @type {any} */ ({
      id: "q_2",
      anchor: { kind: "line", path: "src/paths.js", side: "RIGHT", line: 13, startLine: 11 },
      messages: [
        { role: "user", text: "first", at: "2026-01-01T00:00:00.000Z" },
        { role: "agent", text: "answer", at: "2026-01-01T00:00:01.000Z" },
        { role: "user", text: "and what about b?", at: "2026-01-01T00:00:02.000Z" },
      ],
      status: "open",
    }),
  });
  assert.equal(payload.kind, "question_followup");
  assert.equal(payload.lines, "11-13");
  // The most recent user message is the one being asked, not the first.
  assert.equal(payload.question, "and what about b?");
  assert.equal(payload.follow_up, true);
  assert.equal(payload.permalink, "https://ghe.example.com/o/r/blob/head/src/paths.js#L11-L13");
});

test("an anchor GitHub cannot place is still answerable, with the code marked unavailable", () => {
  const snapshot = {
    ref: { host: "github.com", owner: "o", repo: "r", number: 1 },
    headSha: "head",
    baseSha: "base",
    files: [twoHunks],
    byPath: new Map([[twoHunks.path, twoHunks]]),
  };
  const payload = buildQuestionPayload({
    snapshot: /** @type {any} */ (snapshot),
    thread: /** @type {any} */ ({
      id: "q_3",
      anchor: { kind: "line", path: "src/paths.js", side: "RIGHT", line: 500, outsideDiff: true },
      messages: [{ role: "user", text: "what is here?", at: "2026-01-01T00:00:00.000Z" }],
      status: "open",
    }),
  });
  assert.equal(payload.code, undefined);
  assert.match(String(payload.code_unavailable), /not part of the parsed diff/);
  // The permalink still resolves, so the agent has somewhere to look.
  assert.equal(payload.permalink, "https://github.com/o/r/blob/head/src/paths.js#L500");
});

// ---- permalinks ---------------------------------------------------------

test("a path is percent-encoded per segment, with separators intact", () => {
  assert.equal(encodePathForUrl("src/paths.js"), "src/paths.js");
  assert.equal(encodePathForUrl("dir with space/ünïcode.md"), "dir%20with%20space/%C3%BCn%C3%AFcode.md");
  assert.equal(encodePathForUrl("a/b#c?d.md"), "a/b%23c%3Fd.md");
});

test("blob links use #L only, and a range collapses when both ends match", () => {
  const ref = { host: "github.com", owner: "o", repo: "r" };
  assert.equal(blobPermalink({ ref, sha: "abc", path: "a.md" }), "https://github.com/o/r/blob/abc/a.md");
  assert.equal(blobPermalink({ ref, sha: "abc", path: "a.md", line: 5 }), "https://github.com/o/r/blob/abc/a.md#L5");
  assert.equal(
    blobPermalink({ ref, sha: "abc", path: "a.md", line: 9, startLine: 5 }),
    "https://github.com/o/r/blob/abc/a.md#L5-L9",
  );
  assert.equal(
    blobPermalink({ ref, sha: "abc", path: "a.md", line: 5, startLine: 5 }),
    "https://github.com/o/r/blob/abc/a.md#L5",
  );
});

test("a LEFT blob link changes BOTH the sha and the path - the classic half-fix bug", () => {
  const ref = { host: "github.com", owner: "o", repo: "r" };
  const renamed = { path: "new/name.js", previousPath: "old/name.js" };
  assert.equal(
    blobLinkFor({ ref, headSha: "head", baseSha: "base", file: renamed, side: "LEFT", line: 3 }),
    "https://github.com/o/r/blob/base/old/name.js#L3",
  );
  assert.equal(
    blobLinkFor({ ref, headSha: "head", baseSha: "base", file: renamed, side: "RIGHT", line: 3 }),
    "https://github.com/o/r/blob/head/new/name.js#L3",
  );
});

test("lineSuffix is the files-view form, distinct from the blob form", () => {
  assert.equal(lineSuffix("RIGHT", 42), "R42");
  assert.equal(lineSuffix("LEFT", 17), "L17");
  assert.equal(lineSuffix("RIGHT", 50, 42), "R42-R50");
  assert.equal(lineSuffix("RIGHT", 42, 42), "R42");
});

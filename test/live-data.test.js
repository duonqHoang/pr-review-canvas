import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { buildCommentableIndex, isCommentable, isRangeCommentable } from "../src/diff/index-lines.js";
import { parseDiffHunkWindow, parseFileEntry, parsePatch, serializeHunks } from "../src/diff/parse-patch.js";
import { flattenPages, splitFileLines } from "../src/gh-fetch.js";
import { buildSnapshot } from "../src/snapshot.js";

/**
 * Tests against **recorded real GitHub responses**.
 *
 * These are the highest-leverage tests in the diff layer: they validate the parser against
 * GitHub's own arithmetic rather than against our expectations, and they run entirely offline.
 * Re-record with:
 *   gh api --paginate --slurp "repos/O/R/pulls/N/files?per_page=100"    > pr-N.files.json
 *   gh api --paginate --slurp "repos/O/R/pulls/N/comments?per_page=100" > pr-N.comments.json
 */

const here = path.dirname(fileURLToPath(import.meta.url));
/** @param {string} name */
const live = (name) => JSON.parse(readFileSync(path.join(here, "fixtures", "live", name), "utf8"));

/** @type {import("../src/diff/parse-patch.js").GhFileEntry[]} */
const files219 = flattenPages(live("pr-219.files.json"));
/** @type {import("../src/gh-fetch.js").GhReviewComment[]} */
const comments200 = flattenPages(live("pr-200.comments.json"));
/** @type {import("../src/gh-fetch.js").GhReviewComment[]} */
const comments108 = flattenPages(live("pr-108.comments.json"));

test("the recorded fixtures actually contain data", () => {
  assert.ok(files219.length >= 8, "expected the recorded PR to have several files");
  assert.ok(comments200.length >= 1);
  assert.ok(comments108.length >= 1);
});

test("every file of a real PR parses cleanly, with no diagnostics at all", () => {
  for (const entry of files219) {
    const file = parseFileEntry(entry);
    assert.deepEqual(
      file.diagnostics,
      [],
      `${entry.filename} produced diagnostics: ${JSON.stringify(file.diagnostics)}`,
    );
    assert.equal(file.degraded, false, `${entry.filename} was degraded`);
    assert.equal(file.patchAvailability, "present", `${entry.filename}`);
  }
});

test("every real patch round-trips byte-for-byte", () => {
  for (const entry of files219) {
    const file = parseFileEntry(entry);
    assert.equal(serializeHunks(file.hunks), entry.patch, `round-trip failed for ${entry.filename}`);
  }
});

test("the parsed additions and deletions match the counts GitHub reported", () => {
  // An independent cross-check of the parser's line classification against GitHub's own totals.
  for (const entry of files219) {
    const file = parseFileEntry(entry);
    let additions = 0;
    let deletions = 0;
    for (const hunk of file.hunks) {
      for (const line of hunk.lines) {
        if (line.kind === "add") additions += 1;
        if (line.kind === "del") deletions += 1;
      }
    }
    assert.equal(additions, entry.additions, `${entry.filename}: additions`);
    assert.equal(deletions, entry.deletions, `${entry.filename}: deletions`);
  }
});

// ---------------------------------------------------------------------------
// The `diff_hunk` oracle — our line arithmetic checked against GitHub's own.
//
// Every recorded `diff_hunk` turns out to be a trailing *window* of its hunk (about four lines),
// not the whole thing: GitHub rewrites the header's start numbers to describe the window but
// leaves the counts describing the full hunk. So the oracle is not "index by `position`" — it is
// "walk the window from its declared start and the LAST body line must be the line GitHub says
// the comment is anchored to". That still independently validates cursor advancement across
// context, additions and deletions.
// ---------------------------------------------------------------------------

/** @param {import("../src/gh-fetch.js").GhReviewComment[]} comments */
function oracleCases(comments) {
  return comments.filter(
    (comment) => typeof comment.diff_hunk === "string" && typeof comment.original_line === "number",
  );
}

test("walking a real diff_hunk window lands on exactly the line GitHub reports", () => {
  const cases = [...oracleCases(comments200), ...oracleCases(comments108)];
  assert.ok(cases.length > 0, "expected recorded comments to test the oracle with");

  let checked = 0;
  for (const comment of cases) {
    const { anchoredLine } = parseDiffHunkWindow(/** @type {string} */ (comment.diff_hunk));
    assert.ok(anchoredLine, `comment ${comment.id}: the window produced no anchored line`);

    const side = comment.side ?? "RIGHT";
    const ours = side === "LEFT" ? anchoredLine.oldLine : anchoredLine.newLine;
    assert.equal(
      ours,
      comment.original_line,
      `comment ${comment.id} on ${comment.path}: we computed ${side} line ${ours}, ` +
        `GitHub says ${comment.original_line}`,
    );
    checked += 1;
  }
  assert.equal(checked, cases.length, "every recorded comment must be checked, not skipped");
});

test("the anchored line's kind agrees with the side GitHub chose", () => {
  // A LEFT anchor must be a deletion; a RIGHT anchor must be an addition or context. This is the
  // commentability rule, cross-checked against real data rather than our own fixtures.
  for (const comment of [...oracleCases(comments200), ...oracleCases(comments108)]) {
    const { anchoredLine } = parseDiffHunkWindow(/** @type {string} */ (comment.diff_hunk));
    assert.ok(anchoredLine);
    const side = comment.side ?? "RIGHT";
    if (side === "LEFT") {
      assert.equal(anchoredLine.kind, "del", `comment ${comment.id}`);
    } else {
      assert.ok(anchoredLine.kind === "add" || anchoredLine.kind === "context", `comment ${comment.id}`);
    }
    assert.ok(anchoredLine.commentableSides.includes(side), `comment ${comment.id}: side ${side} must be commentable`);
  }
});

test("a diff_hunk window is never mistaken for a complete patch", () => {
  // The counts in a windowed header describe the full hunk, so parsing one as a patch MUST be
  // rejected. If this ever stops being true, `parseDiffHunkWindow`'s reason to exist is gone —
  // and, worse, some other caller might start trusting a window's counts.
  const windows = oracleCases(comments200).map((comment) => /** @type {string} */ (comment.diff_hunk));
  assert.ok(windows.length > 0);
  let rejected = 0;
  for (const window of windows) {
    const { diagnostics } = parsePatch(window);
    if (diagnostics.some((entry) => entry.fatal)) rejected += 1;
  }
  assert.equal(rejected, windows.length, "every recorded window must be rejected by the strict patch parser");
});

test("a real multi-line comment satisfies GitHub's own range rules", () => {
  const multi = comments200.find((comment) => typeof comment.start_line === "number");
  assert.ok(multi, "expected a recorded multi-line comment");
  // `line` is the LAST line of the range and `start_line` the first — the rule most
  // implementations get backwards.
  assert.ok(/** @type {number} */ (multi.start_line) < /** @type {number} */ (multi.line));
  assert.equal(multi.start_side, multi.side, "both ends of a multi-line comment share a side");
  assert.equal(multi.subject_type, "line");
});

test("a real outdated comment reports a null line but keeps its original anchor", () => {
  const outdated = comments108.find((comment) => comment.line === null);
  assert.ok(outdated, "expected a recorded outdated comment");
  assert.equal(outdated.line, null);
  assert.equal(typeof outdated.original_line, "number", "the original anchor must survive");
  assert.equal(typeof outdated.diff_hunk, "string", "the stored hunk is what the UI renders");
});

test("threads group by in_reply_to_id, falling back to the comment's own id", () => {
  /** @type {Map<number, import("../src/gh-fetch.js").GhReviewComment[]>} */
  const threads = new Map();
  for (const comment of comments200) {
    const root = comment.in_reply_to_id ?? comment.id;
    const bucket = threads.get(root) ?? [];
    bucket.push(comment);
    threads.set(root, bucket);
  }
  assert.ok(threads.size > 0);
  for (const [root, bucket] of threads) {
    assert.ok(
      bucket.some((comment) => comment.id === root || comment.in_reply_to_id === root),
      "every comment in a bucket must belong to its root",
    );
  }
});

// ---------------------------------------------------------------------------
// Snapshot assembly, driven entirely by the recorded fixtures.
// ---------------------------------------------------------------------------

/** @param {Partial<import("../src/gh-fetch.js").PullRequestMeta>} [overrides] */
function meta(overrides = {}) {
  const recorded = live("pr-219.meta.json");
  return {
    number: recorded.number,
    title: recorded.title,
    state: recorded.state,
    isDraft: Boolean(recorded.draft),
    url: recorded.html_url,
    headRefName: recorded.head.ref,
    baseRefName: recorded.base.ref,
    headSha: recorded.head.sha,
    baseSha: recorded.base.sha,
    changedFiles: recorded.changed_files,
    additions: recorded.additions,
    deletions: recorded.deletions,
    authorLogin: "someone",
    ...overrides,
  };
}

const REF = { host: "github.com", owner: "kunchenguid", repo: "lavish-axi", number: 219 };

test("buildSnapshot assembles files, counts and a path index from real data", async () => {
  const snapshot = await buildSnapshot(REF, {
    fetchPullRequestImpl: async () => meta(),
    fetchFilesImpl: async () => files219,
    fetchWholeDiffImpl: async () => {
      throw new Error("the whole diff must not be fetched when every file has a patch");
    },
    now: () => "2026-08-04T00:00:00.000Z",
  });

  assert.equal(snapshot.files.length, files219.length);
  assert.equal(snapshot.headSha, meta().headSha);
  assert.equal(snapshot.fileCountCapped, false);
  assert.equal(snapshot.counts.degraded, 0);
  assert.equal(snapshot.counts.withheld, 0);
  assert.equal(snapshot.counts.files, files219.length);
  for (const entry of files219) {
    assert.ok(snapshot.byPath.has(entry.filename), `${entry.filename} must be indexed by path`);
  }
});

test("buildSnapshot fetches the whole diff only to classify files with no patch", async () => {
  let wholeDiffFetches = 0;
  const withheld = { filename: "assets/logo.png", status: "modified", additions: 0, deletions: 0, changes: 40 };
  const snapshot = await buildSnapshot(REF, {
    fetchPullRequestImpl: async () => meta(),
    fetchFilesImpl: async () => [...files219, withheld],
    fetchWholeDiffImpl: async () => {
      wholeDiffFetches += 1;
      return [
        "diff --git a/assets/logo.png b/assets/logo.png",
        "+++ b/assets/logo.png",
        "Binary files a/x and b/y differ",
      ].join("\n");
    },
  });

  assert.equal(wholeDiffFetches, 1);
  const logo = snapshot.byPath.get("assets/logo.png");
  assert.ok(logo);
  assert.equal(logo.isBinary, true);
  assert.equal(logo.patchAvailability, "absent-binary");
  // A binary file still accepts a file-level comment, but never a line comment.
  assert.equal(logo.fileCommentable, true);
  assert.deepEqual([...buildCommentableIndex(logo).RIGHT.keys()], []);
});

test("a failed whole-diff fetch leaves the file withheld rather than crashing the snapshot", async () => {
  const withheld = { filename: "big.min.js", status: "modified", additions: 0, deletions: 0, changes: 90000 };
  const snapshot = await buildSnapshot(REF, {
    fetchPullRequestImpl: async () => meta(),
    fetchFilesImpl: async () => [withheld],
    fetchWholeDiffImpl: async () => {
      throw new Error("diff too large");
    },
  });
  const file = snapshot.byPath.get("big.min.js");
  assert.ok(file);
  assert.equal(file.patchAvailability, "absent-large");
  // Withheld is the stricter classification: no hunk index means a line comment is a certain 422.
  assert.equal(file.fileCommentable, false);
});

test("real files produce a usable commentable index with sane bounds", () => {
  for (const entry of files219) {
    const file = parseFileEntry(entry);
    const index = buildCommentableIndex(file);
    const rightKeys = [...index.RIGHT.keys()];
    if (rightKeys.length === 0) continue;
    // Every commentable line must sit inside one of the merged intervals, and every interval
    // must be non-empty and ordered.
    for (const [start, end] of index.rightIntervals) {
      assert.ok(start <= end, `${entry.filename}: interval ${start}-${end} is inverted`);
      assert.equal(isCommentable(index, "RIGHT", start), true);
      assert.equal(isCommentable(index, "RIGHT", end), true);
      assert.equal(isRangeCommentable(index, "RIGHT", start, end), true);
    }
    // A range that starts one line before the first interval can never be valid.
    const [firstStart] = index.rightIntervals[0];
    if (firstStart > 0) {
      assert.equal(isRangeCommentable(index, "RIGHT", firstStart - 1, firstStart), false);
    }
  }
});

test("splitFileLines does not invent or drop a trailing line", () => {
  assert.deepEqual(splitFileLines(""), []);
  assert.deepEqual(splitFileLines("a\nb\n"), ["a", "b"]);
  assert.deepEqual(splitFileLines("a\nb"), ["a", "b"]);
  assert.deepEqual(splitFileLines("a\n\n"), ["a", ""]);
  assert.deepEqual(splitFileLines("\n"), [""]);
});

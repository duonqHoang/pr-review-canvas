/**
 * Diff fixtures.
 *
 * Every patch here was captured from real `git diff` output (see the comment on each) and is
 * written with explicit escapes rather than stored in a `.patch` file. That is deliberate: an
 * empty context line is a single space, and a CRLF file's content ends in `\r` — exactly the
 * bytes an editor, a linter, or a `git checkout` with `core.autocrlf` would silently mangle.
 * The whole point of these fixtures is byte-exactness, so they must be immune to that.
 */

/**
 * @typedef {object} DiffFixture
 * @property {string} name
 * @property {string} why what this fixture exists to pin down
 * @property {import("../../src/diff/parse-patch.js").GhFileEntry} entry
 * @property {object} [expect]
 * @property {number} [expect.hunks]
 * @property {boolean} [expect.degraded]
 * @property {import("../../src/diff/model.js").PatchAvailability} [expect.patchAvailability]
 * @property {number[]} [expect.rightCommentable] exact set of commentable RIGHT line numbers
 * @property {number[]} [expect.leftCommentable] exact set of commentable LEFT line numbers
 */

/** @type {DiffFixture[]} */
export const FIXTURES = [
  {
    name: "simple-modified",
    why: "baseline: context, deletion and addition in one hunk",
    entry: {
      filename: "src/retry.ts",
      status: "modified",
      additions: 2,
      deletions: 1,
      changes: 3,
      sha: "aaa0000000000000000000000000000000000001",
      // The counts must reconcile with the body: 2 context + 1 deletion = 3 old lines, and
      // 2 context + 2 additions = 4 new lines.
      patch: [
        "@@ -12,3 +12,4 @@ function retry(fn, opts) {",
        "   let delay = base;",
        "-  delay = delay * 2;",
        "+  delay = delay * jitter(2);",
        "+  log(delay);",
        "   return delay;",
      ].join("\n"),
    },
    expect: {
      hunks: 1,
      degraded: false,
      patchAvailability: "present",
      // 12 context, 13 + 14 additions, 15 context. Old line 13 was deleted.
      rightCommentable: [12, 13, 14, 15],
      leftCommentable: [13],
    },
  },
  {
    name: "omitted-count",
    why: "real git emits `@@ -1 +1 @@` when a range is exactly one line; the count defaults to 1",
    entry: {
      filename: "a.txt",
      status: "modified",
      additions: 1,
      deletions: 1,
      changes: 2,
      patch: ["@@ -1 +1 @@", "-x", "+y"].join("\n"),
    },
    expect: { hunks: 1, degraded: false, rightCommentable: [1], leftCommentable: [1] },
  },
  {
    name: "zero-count-insertion",
    why: "`@@ -1,0 +2 @@ l1` — an empty old range; oldStart is the line BEFORE the insertion point and is not addressable",
    entry: {
      filename: "f.txt",
      status: "modified",
      additions: 1,
      deletions: 0,
      changes: 1,
      patch: ["@@ -1,0 +2 @@ l1", "+NEW"].join("\n"),
    },
    expect: { hunks: 1, degraded: false, rightCommentable: [2], leftCommentable: [] },
  },
  {
    name: "no-newline-both-sides",
    why: "one hunk can carry TWO `\\ No newline` markers, one per side; each attaches to its own preceding line",
    entry: {
      filename: "d.txt",
      status: "modified",
      additions: 1,
      deletions: 1,
      changes: 2,
      patch: [
        "@@ -1,2 +1,2 @@",
        " one",
        "-two",
        "\\ No newline at end of file",
        "+TWO",
        "\\ No newline at end of file",
      ].join("\n"),
    },
    expect: { hunks: 1, degraded: false, rightCommentable: [1, 2], leftCommentable: [2] },
  },
  {
    name: "crlf",
    why: "a trailing \\r is real content; stripping it would corrupt suggestion payloads and fingerprints",
    entry: {
      filename: "g.txt",
      status: "modified",
      additions: 1,
      deletions: 1,
      changes: 2,
      patch: ["@@ -1,2 +1,2 @@", " l1\r", "-l2\r", "+l2X\r"].join("\n"),
    },
    expect: { hunks: 1, degraded: false, rightCommentable: [1, 2], leftCommentable: [2] },
  },
  {
    name: "empty-added-line",
    why: "an added blank line is `+` with empty content and is fully commentable",
    entry: {
      filename: "j.txt",
      status: "modified",
      additions: 1,
      deletions: 0,
      changes: 1,
      // Note the bare " " on the empty context line — that is what git actually emits.
      patch: ["@@ -1,3 +1,4 @@", " keep", " ", "+", " after"].join("\n"),
    },
    expect: { hunks: 1, degraded: false, rightCommentable: [1, 2, 3, 4], leftCommentable: [] },
  },
  {
    name: "tabs-and-trailing-space",
    why: "byte-exact content matters for ```suggestion base text",
    entry: {
      filename: "k.go",
      status: "modified",
      additions: 1,
      deletions: 1,
      changes: 2,
      // Every body line carries its prefix character first: a context line is a SPACE then the
      // content, so a tab-indented context line begins " \t", not "\t".
      patch: [
        "@@ -5,3 +5,3 @@ func main() {",
        " \tsetup()",
        "-\trun(1)   ",
        "+\trun(2)\t",
        " \tdone()",
      ].join("\n"),
    },
    expect: { hunks: 1, degraded: false, rightCommentable: [5, 6, 7], leftCommentable: [6] },
  },
  {
    name: "multi-hunk-gap",
    why: "THE critical case: a range spanning the gap between hunks must be rejected, because those new-file numbers are not in the diff",
    entry: {
      filename: "src/server.js",
      status: "modified",
      additions: 2,
      deletions: 0,
      changes: 2,
      patch: [
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
      ].join("\n"),
    },
    expect: {
      hunks: 2,
      degraded: false,
      // 10-13 from the first hunk, 41-44 from the second. 14..40 are NOT in the diff.
      rightCommentable: [10, 11, 12, 13, 41, 42, 43, 44],
      leftCommentable: [],
    },
  },
  {
    name: "adjacent-hunks",
    why: "two hunks whose new-file numbers are continuous must merge into one interval, so a range across them is allowed",
    entry: {
      filename: "src/adjacent.js",
      status: "modified",
      additions: 2,
      deletions: 0,
      changes: 2,
      patch: [
        "@@ -1,2 +1,3 @@",
        " a",
        "+b",
        " c",
        "@@ -3,2 +4,3 @@",
        " d",
        "+e",
        " f",
      ].join("\n"),
    },
    expect: { hunks: 2, degraded: false, rightCommentable: [1, 2, 3, 4, 5, 6], leftCommentable: [] },
  },
  {
    name: "heading-with-at-at",
    why: "the section heading capture is greedy, so a heading containing `@@` still parses",
    entry: {
      filename: "weird.md",
      status: "modified",
      additions: 1,
      deletions: 0,
      changes: 1,
      patch: ["@@ -1,2 +1,3 @@ heading with @@ inside", " a", "+b", " c"].join("\n"),
    },
    expect: { hunks: 1, degraded: false, rightCommentable: [1, 2, 3], leftCommentable: [] },
  },
  {
    name: "added-file",
    why: "RIGHT-only; the LEFT index must be empty",
    entry: {
      filename: "new.txt",
      status: "added",
      additions: 3,
      deletions: 0,
      changes: 3,
      patch: ["@@ -0,0 +1,3 @@", "+one", "+two", "+three"].join("\n"),
    },
    expect: { hunks: 1, degraded: false, rightCommentable: [1, 2, 3], leftCommentable: [] },
  },
  {
    name: "removed-file",
    why: "LEFT-only; a RIGHT anchor here can never be valid",
    entry: {
      filename: "gone.txt",
      status: "removed",
      additions: 0,
      deletions: 3,
      changes: 3,
      patch: ["@@ -1,3 +0,0 @@", "-one", "-two", "-three"].join("\n"),
    },
    expect: { hunks: 1, degraded: false, rightCommentable: [], leftCommentable: [1, 2, 3] },
  },
  {
    name: "rename-with-hunks",
    why: "a LEFT comment on a renamed file must still use the NEW path; previousPath is display-only",
    entry: {
      filename: "src/new-name.js",
      previous_filename: "src/old-name.js",
      status: "renamed",
      additions: 1,
      deletions: 1,
      changes: 2,
      patch: ["@@ -1,2 +1,2 @@", " keep", "-old", "+new"].join("\n"),
    },
    expect: { hunks: 1, degraded: false, rightCommentable: [1, 2], leftCommentable: [2] },
  },
  {
    name: "rename-pure",
    why: "a rename with no content change has no patch, but is not withheld — file comments stay available",
    entry: {
      filename: "src/moved.js",
      previous_filename: "src/original.js",
      status: "renamed",
      additions: 0,
      deletions: 0,
      changes: 0,
    },
    expect: { hunks: 0, degraded: false, patchAvailability: "empty", rightCommentable: [], leftCommentable: [] },
  },
  {
    name: "patch-withheld",
    why: "changes but no patch (binary, or diff too large): line comments are impossible, so nothing is commentable",
    entry: {
      filename: "assets/logo.png",
      status: "modified",
      additions: 0,
      deletions: 0,
      changes: 120,
    },
    expect: {
      hunks: 0,
      degraded: false,
      patchAvailability: "absent-large",
      rightCommentable: [],
      leftCommentable: [],
    },
  },
  {
    name: "count-mismatch",
    why: "fail closed: a body that does not reconcile with the header yields ZERO commentable lines rather than plausible wrong ones",
    entry: {
      filename: "broken.txt",
      status: "modified",
      additions: 1,
      deletions: 0,
      changes: 1,
      // Header promises 3 new lines; the body only accounts for 2.
      patch: ["@@ -1,2 +1,3 @@", " a", "+b"].join("\n"),
    },
    expect: {
      hunks: 1,
      degraded: true,
      patchAvailability: "truncated",
      rightCommentable: [],
      leftCommentable: [],
    },
  },
  {
    name: "malformed-header",
    why: "an unparseable header abandons the file instead of guessing line numbers",
    entry: {
      filename: "bad-header.txt",
      status: "modified",
      additions: 1,
      deletions: 0,
      changes: 1,
      patch: ["@@ this is not a hunk header @@", " a", "+b"].join("\n"),
    },
    expect: { hunks: 0, degraded: true, patchAvailability: "truncated", rightCommentable: [], leftCommentable: [] },
  },
  {
    name: "unknown-prefix",
    why: "a stray prefix is skipped, and the count check then fails — that is what actually protects us",
    entry: {
      filename: "odd.txt",
      status: "modified",
      additions: 1,
      deletions: 0,
      changes: 1,
      patch: ["@@ -1,2 +1,3 @@", " a", "?huh", "+b", " c"].join("\n"),
    },
    expect: { degraded: true, patchAvailability: "truncated", rightCommentable: [], leftCommentable: [] },
  },
  {
    name: "unicode-content",
    why: "multi-byte and combining characters must survive parsing and round-tripping intact",
    entry: {
      filename: "dir/ünïcode.md",
      status: "modified",
      additions: 1,
      deletions: 1,
      changes: 2,
      patch: ["@@ -1,2 +1,2 @@", " café ☕", "-naïve 🎉", "+naïve 🎊 é"].join("\n"),
    },
    expect: { hunks: 1, degraded: false, rightCommentable: [1, 2], leftCommentable: [2] },
  },
];

/** @param {string} name */
export function fixture(name) {
  const found = FIXTURES.find((item) => item.name === name);
  if (!found) throw new Error(`unknown diff fixture: ${name}`);
  return found;
}

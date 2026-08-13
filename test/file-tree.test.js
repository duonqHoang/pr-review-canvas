import assert from "node:assert/strict";
import test from "node:test";
import { buildFileTree, filterFiles, isSubsequence, reviewProgress } from "../src/shared/file-tree.js";

/**
 * @param {string} path
 * @param {Partial<import("../src/shared/file-tree.js").FileEntry>} [extra]
 * @returns {import("../src/shared/file-tree.js").FileEntry}
 */
const entry = (path, extra = {}) => ({ index: 0, path, additions: 1, deletions: 0, ...extra });

/** @param {import("../src/shared/file-tree.js").TreeNode[]} nodes */
function outline(nodes, depth = 0) {
  /** @type {string[]} */
  const lines = [];
  for (const node of nodes) {
    lines.push(`${"  ".repeat(depth)}${node.kind === "dir" ? `${node.name}/` : node.name}`);
    if (node.kind === "dir") lines.push(...outline(node.children, depth + 1));
  }
  return lines;
}

test("files at the root stay at the root", () => {
  const tree = buildFileTree([entry("README.md"), entry("LICENSE")]);
  assert.deepEqual(outline(tree), ["LICENSE", "README.md"]);
});

test("a single-child directory chain collapses into one row", () => {
  // The rule that stops a Java or Go repository rendering as a column of indentation.
  const tree = buildFileTree([entry("src/main/java/com/example/App.java")]);
  assert.deepEqual(outline(tree), ["src/main/java/com/example/", "  App.java"]);
});

test("a chain stops collapsing where it branches", () => {
  // `src` has two children, so it keeps its own row; `a` and `b` each hold a file rather than a
  // directory, so there is nothing for them to merge with either.
  const tree = buildFileTree([entry("src/a/one.js"), entry("src/b/two.js")]);
  assert.deepEqual(outline(tree), ["src/", "  a/", "    one.js", "  b/", "    two.js"]);
});

test("collapsing merges a chain but stops at the branch point", () => {
  const tree = buildFileTree([entry("src/deep/nested/a/one.js"), entry("src/deep/nested/b/two.js")]);
  assert.deepEqual(outline(tree), ["src/deep/nested/", "  a/", "    one.js", "  b/", "    two.js"]);
});

test("a directory holding both a file and a subdirectory does not collapse", () => {
  // Two children means the parent has content of its own to show, so folding it away would hide it.
  const tree = buildFileTree([entry("src/index.js"), entry("src/lib/util.js")]);
  assert.deepEqual(outline(tree), ["src/", "  lib/", "    util.js", "  index.js"]);
});

test("directories sort before files and each group sorts alphabetically", () => {
  const tree = buildFileTree([entry("zebra.md"), entry("alpha.md"), entry("dir/b.md"), entry("dir/a.md")]);
  assert.deepEqual(outline(tree), ["dir/", "  a.md", "  b.md", "alpha.md", "zebra.md"]);
});

test("the pull request's own file order survives on the leaves", () => {
  // The tree is alphabetical but `n`/`p` must walk the PR's order, so `index` is the thing that
  // must not be rewritten by sorting.
  const tree = buildFileTree([entry("z/last.js", { index: 0 }), entry("a/first.js", { index: 1 })]);
  /** @type {Array<[string, number]>} */
  const leaves = [];
  /** @param {import("../src/shared/file-tree.js").TreeNode[]} nodes */
  const walk = (nodes) => {
    for (const node of nodes) {
      if (node.kind === "file") leaves.push([node.path, node.entry.index]);
      else walk(node.children);
    }
  };
  walk(tree);
  assert.deepEqual(leaves, [
    ["a/first.js", 1],
    ["z/last.js", 0],
  ]);
});

test("directory totals roll up from the leaves, including viewed", () => {
  const tree = buildFileTree([
    entry("src/a.js", { additions: 3, deletions: 1, viewed: true }),
    entry("src/deep/b.js", { additions: 5, deletions: 2 }),
  ]);
  const src = tree[0];
  assert.equal(src.kind, "dir");
  if (src.kind !== "dir") return;
  assert.deepEqual(src.totals, { files: 2, viewed: 1, additions: 8, deletions: 3 });
  const deep = src.children.find((child) => child.kind === "dir");
  assert.equal(deep?.kind, "dir");
  if (deep?.kind !== "dir") return;
  assert.deepEqual(deep.totals, { files: 1, viewed: 0, additions: 5, deletions: 2 });
});

test("a collapsed directory still reports what is inside it", () => {
  const tree = buildFileTree([entry("a/b/c/one.js", { additions: 2, deletions: 0 })]);
  const node = tree[0];
  assert.equal(node.kind, "dir");
  if (node.kind !== "dir") return;
  assert.equal(node.name, "a/b/c");
  assert.equal(node.path, "a/b/c");
  assert.equal(node.totals.files, 1);
});

test("two files with the same name in different directories stay separate", () => {
  const tree = buildFileTree([entry("a/index.js"), entry("b/index.js")]);
  assert.deepEqual(outline(tree), ["a/", "  index.js", "b/", "  index.js"]);
});

test("a path with a leading or repeated separator does not create a phantom directory", () => {
  // Not expected from GitHub, but a crash here would take out the whole sidebar, so it is pinned.
  const tree = buildFileTree([entry("a//b.js")]);
  assert.equal(tree.length, 1);
  assert.equal(tree[0].kind, "dir");
});

// ---------------------------------------------------------------------------
// Filtering
// ---------------------------------------------------------------------------

test("an empty filter returns the list untouched", () => {
  const files = [entry("b.js"), entry("a.js")];
  assert.equal(filterFiles(files, ""), files);
  assert.equal(filterFiles(files, "   "), files);
});

test("a substring match wins over a subsequence match", () => {
  const files = [entry("src/shared/permalink.js"), entry("perm.js")];
  const hits = filterFiles(files, "perm");
  assert.deepEqual(
    hits.map((hit) => hit.path),
    ["perm.js", "src/shared/permalink.js"],
  );
});

test("a subsequence finds a file across directory separators", () => {
  const files = [entry("src/shared/permalink.js"), entry("test/unrelated.js")];
  const hits = filterFiles(files, "srshprm");
  assert.deepEqual(
    hits.map((hit) => hit.path),
    ["src/shared/permalink.js"],
  );
});

test("filtering is case-insensitive", () => {
  const hits = filterFiles([entry("src/README.md")], "readme");
  assert.equal(hits.length, 1);
});

test("a query that matches nothing returns nothing", () => {
  assert.deepEqual(filterFiles([entry("a.js")], "zzz"), []);
});

test("isSubsequence needs the characters in order", () => {
  assert.equal(isSubsequence("abc", "axbxc"), true);
  assert.equal(isSubsequence("cba", "axbxc"), false);
  assert.equal(isSubsequence("", "anything"), true);
  assert.equal(isSubsequence("abc", "ab"), false);
});

test("review progress counts viewed files and knows when it is finished", () => {
  assert.deepEqual(reviewProgress([entry("a", { viewed: true }), entry("b")]), { viewed: 1, total: 2, done: false });
  assert.deepEqual(reviewProgress([entry("a", { viewed: true })]), { viewed: 1, total: 1, done: true });
  // An empty PR is not a finished review.
  assert.deepEqual(reviewProgress([]), { viewed: 0, total: 0, done: false });
});

/**
 * The changed-files tree.
 *
 * Kept as a pure transform from a flat list to a nested one, with no DOM anywhere, for two reasons:
 * the interesting behaviour is all in path grouping and prefix collapsing, and that behaviour is
 * exactly what is annoying to check by clicking around a browser.
 *
 * Two ordering rules coexist deliberately and must not be merged:
 *
 * - The **tree** is sorted alphabetically, directories first, because that is how someone looks for
 *   a file they have in mind.
 * - **Navigation** (`n`/`p`, and the review order generally) follows the pull request's own file
 *   order, which is what `index` preserves on every leaf.
 */

/**
 * @typedef {object} FileEntry
 * @property {number} index position in the pull request's own file order
 * @property {string} path
 * @property {number} additions
 * @property {number} deletions
 * @property {string} [status]
 * @property {boolean} [viewed]
 * @property {boolean} [degraded]
 */

/**
 * @typedef {{ kind: "file", name: string, path: string, entry: FileEntry }} FileNode
 */

/**
 * @typedef {object} DirNode
 * @property {"dir"} kind
 * @property {string} name possibly a collapsed run like `src/shared`
 * @property {string} path full path of the directory
 * @property {TreeNode[]} children
 * @property {{ files: number, viewed: number, additions: number, deletions: number }} totals
 */

/** @typedef {FileNode | DirNode} TreeNode */

/**
 * Build the tree.
 *
 * @param {FileEntry[]} files
 * @returns {TreeNode[]}
 */
export function buildFileTree(files) {
  /** @type {DirNode} */
  const root = { kind: "dir", name: "", path: "", children: [], totals: emptyTotals() };

  for (const entry of files) {
    const segments = String(entry.path ?? "").split("/");
    const name = segments.pop() ?? "";
    let cursor = root;
    let prefix = "";
    for (const segment of segments) {
      prefix = prefix ? `${prefix}/${segment}` : segment;
      let next = cursor.children.find(
        (child) => child.kind === "dir" && child.name === segment && child.path === prefix,
      );
      if (!next) {
        next = /** @type {DirNode} */ ({
          kind: "dir",
          name: segment,
          path: prefix,
          children: [],
          totals: emptyTotals(),
        });
        cursor.children.push(next);
      }
      cursor = /** @type {DirNode} */ (next);
    }
    cursor.children.push({ kind: "file", name, path: entry.path, entry });
  }

  collapseSingleChildDirectories(root);
  sortTree(root);
  tally(root);
  return root.children;
}

function emptyTotals() {
  return { files: 0, viewed: 0, additions: 0, deletions: 0 };
}

/**
 * Fold `a` → `b` → `c` into one `a/b/c` row.
 *
 * Without this, a Java or Go repository produces a sidebar that is mostly indentation. The rule is
 * the same one GitHub uses: a directory with exactly one child, and that child a directory, merges
 * with it.
 *
 * @param {DirNode} node
 */
function collapseSingleChildDirectories(node) {
  for (const child of node.children) {
    if (child.kind === "dir") collapseSingleChildDirectories(child);
  }
  // Depth-first, so a chain collapses from the bottom up in one pass.
  for (let index = 0; index < node.children.length; index += 1) {
    let child = node.children[index];
    while (child.kind === "dir" && child.children.length === 1 && child.children[0].kind === "dir") {
      const only = /** @type {DirNode} */ (child.children[0]);
      child = {
        kind: "dir",
        name: `${child.name}/${only.name}`,
        path: only.path,
        children: only.children,
        totals: emptyTotals(),
      };
    }
    node.children[index] = child;
  }
}

/** @param {DirNode} node */
function sortTree(node) {
  node.children.sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === "dir" ? -1 : 1;
    return a.name.localeCompare(b.name, "en");
  });
  for (const child of node.children) if (child.kind === "dir") sortTree(child);
}

/**
 * Roll per-directory totals up from the leaves, so a collapsed directory can still say how much is
 * inside it and how much of that has been read.
 *
 * @param {DirNode} node
 */
function tally(node) {
  const totals = emptyTotals();
  for (const child of node.children) {
    if (child.kind === "file") {
      totals.files += 1;
      totals.viewed += child.entry.viewed ? 1 : 0;
      totals.additions += child.entry.additions ?? 0;
      totals.deletions += child.entry.deletions ?? 0;
      continue;
    }
    tally(child);
    totals.files += child.totals.files;
    totals.viewed += child.totals.viewed;
    totals.additions += child.totals.additions;
    totals.deletions += child.totals.deletions;
  }
  node.totals = totals;
}

/**
 * Filter the flat file list by a query.
 *
 * A plain case-insensitive substring match on the whole path, plus a subsequence fallback so
 * `srsh/prm` finds `src/shared/permalink.js`. Substring hits rank first, then earlier matches, then
 * shorter paths — the aim is that the file you meant is reachable with two or three keys, and
 * nothing more clever than that.
 *
 * @param {FileEntry[]} files
 * @param {string} query
 * @returns {FileEntry[]}
 */
export function filterFiles(files, query) {
  const needle = String(query ?? "")
    .trim()
    .toLowerCase();
  if (!needle) return files;
  /** @type {Array<{ entry: FileEntry, rank: number, at: number }>} */
  const hits = [];
  for (const entry of files) {
    const haystack = String(entry.path ?? "").toLowerCase();
    const at = haystack.indexOf(needle);
    if (at >= 0) {
      hits.push({ entry, rank: 0, at });
      continue;
    }
    if (isSubsequence(needle, haystack)) hits.push({ entry, rank: 1, at: haystack.length });
  }
  hits.sort((a, b) => a.rank - b.rank || a.at - b.at || a.entry.path.length - b.entry.path.length);
  return hits.map((hit) => hit.entry);
}

/**
 * @param {string} needle
 * @param {string} haystack
 */
export function isSubsequence(needle, haystack) {
  let cursor = 0;
  for (const character of haystack) {
    if (character === needle[cursor]) cursor += 1;
    if (cursor === needle.length) return true;
  }
  return needle.length === 0;
}

/**
 * How far through the review the user is.
 *
 * @param {FileEntry[]} files
 */
export function reviewProgress(files) {
  const viewed = files.filter((file) => file.viewed).length;
  return { viewed, total: files.length, done: files.length > 0 && viewed === files.length };
}

import { GITHUB_FILES_CAP } from "./diff/model.js";
import { markBinary, parseFileEntry } from "./diff/parse-patch.js";
import { fetchFiles, fetchPullRequest, fetchWholeDiff } from "./gh-fetch.js";

/**
 * Build the parsed snapshot of a pull request: the PR's metadata plus every file's diff, ready
 * for rendering and for anchor validation.
 *
 * The snapshot is large (megabytes on a big PR) and is stored separately from the session's hot
 * state so a draft autosave never rewrites it.
 */

/** Paths in the whole diff that are reported as binary. */
const BINARY_MARKER_RE = /^(?:Binary files .* differ|GIT binary patch)$/m;

/**
 * Extract, from `gh pr diff` output, the set of paths GitHub considers binary.
 *
 * We only need the binary/not-binary answer from the whole diff — the per-file patches come from
 * the files endpoint, which is already normalised. Parsing the whole diff for content would mean
 * maintaining a second, subtly different parser.
 *
 * @param {string} wholeDiff
 * @returns {Set<string>}
 */
export function binaryPathsFromWholeDiff(wholeDiff) {
  /** @type {Set<string>} */
  const binary = new Set();
  const sections = String(wholeDiff ?? "").split(/^diff --git /m);
  for (const section of sections) {
    if (!section.trim()) continue;
    if (!BINARY_MARKER_RE.test(section)) continue;
    const path = pathFromDiffSection(section);
    if (path) binary.add(path);
  }
  return binary;
}

/**
 * Read the file's current path out of one `diff --git` section.
 *
 * Deliberately reads `+++ b/<path>` (falling back to `--- a/<path>` for a deletion) rather than
 * the `diff --git a/x b/y` line: that line is ambiguous when a path contains a space.
 *
 * @param {string} section
 * @returns {string | null}
 */
export function pathFromDiffSection(section) {
  const plus = /^\+\+\+ (?:b\/)?(.+)$/m.exec(section);
  if (plus && plus[1] !== "/dev/null") return unquoteGitPath(plus[1]);
  const minus = /^--- (?:a\/)?(.+)$/m.exec(section);
  if (minus && minus[1] !== "/dev/null") return unquoteGitPath(minus[1]);
  // A binary section for a new file may carry neither; fall back to the header's b-side.
  const header = /^"?(.*?)"? "?(.*?)"?$/.exec(section.split("\n")[0] ?? "");
  if (header && header[2]) return unquoteGitPath(header[2].replace(/^b\//, ""));
  return null;
}

/**
 * Undo git's `core.quotePath` C-style escaping (`"a\tb"`, `"\303\251"`).
 *
 * @param {string} value
 * @returns {string}
 */
export function unquoteGitPath(value) {
  const raw = String(value ?? "");
  if (!(raw.startsWith('"') && raw.endsWith('"') && raw.length >= 2)) return raw;
  const inner = raw.slice(1, -1);
  /** @type {number[]} */
  const bytes = [];
  for (let i = 0; i < inner.length; i += 1) {
    const char = inner[i];
    if (char !== "\\") {
      // Non-ASCII cannot appear unescaped inside a quoted path, so a single-byte push is safe
      // for everything git emits here.
      for (const byte of Buffer.from(char, "utf8")) bytes.push(byte);
      continue;
    }
    const next = inner[i + 1];
    const octal = /^[0-7]{3}/.exec(inner.slice(i + 1));
    if (octal) {
      bytes.push(parseInt(octal[0], 8));
      i += 3;
      continue;
    }
    const simple = { n: 10, t: 9, r: 13, '"': 34, "\\": 92, a: 7, b: 8, f: 12, v: 11 };
    if (next && Object.hasOwn(simple, next)) {
      bytes.push(simple[/** @type {keyof typeof simple} */ (next)]);
      i += 1;
      continue;
    }
    bytes.push(92);
  }
  return Buffer.from(bytes).toString("utf8");
}

/**
 * @typedef {object} Snapshot
 * @property {import("./pr-ref.js").PrRef} ref
 * @property {import("./gh-fetch.js").PullRequestMeta} pr
 * @property {import("./diff/model.js").ParsedFile[]} files
 * @property {Map<string, import("./diff/model.js").ParsedFile>} byPath
 * @property {string} headSha
 * @property {string} baseSha
 * @property {string} fetchedAt
 * @property {boolean} fileCountCapped
 * @property {{ files: number, additions: number, deletions: number, binary: number, withheld: number, degraded: number }} counts
 */

/**
 * @param {import("./pr-ref.js").PrRef} ref
 * @param {object} [deps]
 * @param {typeof fetchPullRequest} [deps.fetchPullRequestImpl]
 * @param {typeof fetchFiles} [deps.fetchFilesImpl]
 * @param {typeof fetchWholeDiff} [deps.fetchWholeDiffImpl]
 * @param {() => string} [deps.now]
 * @returns {Promise<Snapshot>}
 */
export async function buildSnapshot(ref, deps = {}) {
  const fetchPr = deps.fetchPullRequestImpl ?? fetchPullRequest;
  const fetchFilesImpl = deps.fetchFilesImpl ?? fetchFiles;
  const fetchWholeDiffImpl = deps.fetchWholeDiffImpl ?? fetchWholeDiff;
  const now = deps.now ?? (() => new Date().toISOString());

  const [pr, entries] = await Promise.all([fetchPr(ref), fetchFilesImpl(ref)]);
  let files = entries.map((entry) => parseFileEntry(entry));

  // Only pay for the whole diff when at least one file came back without a patch: that is the
  // only case where we need to know whether it is binary or merely oversized.
  const needsBinaryCheck = files.some((file) => file.patchAvailability === "absent-large");
  if (needsBinaryCheck) {
    /** @type {Set<string>} */
    let binaryPaths = new Set();
    try {
      binaryPaths = binaryPathsFromWholeDiff(await fetchWholeDiffImpl(ref));
    } catch {
      // A failed whole-diff fetch is not fatal: the affected files simply stay "withheld",
      // which is the stricter classification.
      binaryPaths = new Set();
    }
    files = files.map((file) => (binaryPaths.has(file.path) ? markBinary(file) : file));
  }

  /** @type {Map<string, import("./diff/model.js").ParsedFile>} */
  const byPath = new Map();
  for (const file of files) byPath.set(file.path, file);

  return {
    ref,
    pr,
    files,
    byPath,
    headSha: pr.headSha,
    baseSha: pr.baseSha,
    fetchedAt: now(),
    // The files endpoint stops at 3000 entries; say so honestly rather than pretending the PR
    // is smaller than it is.
    fileCountCapped: files.length >= GITHUB_FILES_CAP,
    counts: summarizeFiles(files),
  };
}

/**
 * @param {import("./diff/model.js").ParsedFile[]} files
 */
export function summarizeFiles(files) {
  let additions = 0;
  let deletions = 0;
  let binary = 0;
  let withheld = 0;
  let degraded = 0;
  for (const file of files) {
    additions += file.additions;
    deletions += file.deletions;
    if (file.isBinary) binary += 1;
    if (file.patchAvailability === "absent-large") withheld += 1;
    if (file.degraded) degraded += 1;
  }
  return { files: files.length, additions, deletions, binary, withheld, degraded };
}

/**
 * Which paths a file lookup should try for a given comment path, newest first. A comment made
 * before a rename references the old path.
 *
 * @param {Snapshot} snapshot
 * @param {string} path
 * @returns {import("./diff/model.js").ParsedFile | null}
 */
export function findFile(snapshot, path) {
  const direct = snapshot.byPath.get(path);
  if (direct) return direct;
  return snapshot.files.find((file) => file.previousPath === path) ?? null;
}

/**
 * Compare two snapshots of the same PR taken at different head SHAs.
 *
 * Reports only what changed; classifying individual drafts as still-valid / moved / orphaned is
 * the anchor layer's job, because it needs the fingerprints.
 *
 * @param {Snapshot} before
 * @param {Snapshot} after
 */
export function diffSnapshots(before, after) {
  const changedPaths = [];
  for (const file of after.files) {
    const previous = before.byPath.get(file.path);
    if (!previous || previous.rawPatch !== file.rawPatch) changedPaths.push(file.path);
  }
  const removedPaths = before.files.filter((file) => !after.byPath.has(file.path)).map((file) => file.path);
  return {
    headChanged: before.headSha !== after.headSha,
    fromSha: before.headSha,
    toSha: after.headSha,
    changedPaths,
    removedPaths,
  };
}

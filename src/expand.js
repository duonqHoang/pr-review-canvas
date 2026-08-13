import { mkdir, readFile, readdir, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { AxiError } from "./axi.js";
import { fetchBlobLines, splitFileLines } from "./gh-fetch.js";
import { showFromAnyClone } from "./local-git.js";

/**
 * Expand-context: showing lines that surround a hunk but are not part of the diff.
 *
 * The expensive part is getting the file's content, and the order of preference is not a
 * micro-optimisation — it is the difference between a feature a reviewer can lean on and one that
 * burns an API budget:
 *
 * 1. **A local clone**, if the session knows one that has the commit. Free, offline, unlimited.
 * 2. **`gh api …/contents`** with the raw media type.
 * 3. **A clear error.** Never a guess: inventing context lines would put a comment affordance next
 *    to a line that may not exist.
 *
 * One fetch pulls the **whole file** and caches it under the session, so the second and subsequent
 * expansions in that file cost nothing at all.
 *
 * Everything produced here is `origin: "expanded"` with no commentable side. That single field is
 * what stops the renderer offering a `+` and what makes the validator refuse the line — a comment
 * on a line outside the diff is a guaranteed 422 that would reject the entire review batch.
 */

/** How many lines one click reveals. Matches GitHub. */
export const EXPAND_CHUNK_LINES = 20;

/** A file this big is not worth caching, and expanding it is not worth the transfer either. */
export const MAX_BLOB_BYTES = 2 * 1024 * 1024;

/** Per-session cache ceiling; the least recently used blobs are evicted first. */
export const MAX_BLOB_CACHE_BYTES = 20 * 1024 * 1024;

/**
 * @typedef {object} ExpandRange
 * @property {number} startNew first new-side line number to show, inclusive
 * @property {number} endNew last new-side line number to show, inclusive
 * @property {number} oldOffset `oldLine = newLine - oldOffset` throughout the range
 * @property {boolean} boundedByHunk true when the far end is another hunk rather than the file's edge
 */

/**
 * Work out which lines a click should reveal.
 *
 * Pure arithmetic on the parsed diff, which is why it is separated from the fetching: every
 * interesting failure mode here is an off-by-one, and those are cheap to test and expensive to
 * notice in a browser.
 *
 * The old-side numbering is recovered from the hunk boundary rather than tracked line by line. At the
 * *start* of a hunk the two sides differ by `newStart - oldStart`; at the *end* they differ by
 * `(newStart + newCount) - (oldStart + oldCount)`. Both are exact, because a gap between hunks
 * contains only unchanged lines by definition.
 *
 * @param {import("./diff/model.js").ParsedFile} file
 * @param {number} hunkIndex
 * @param {"before" | "after"} direction
 * @param {object} [options]
 * @param {number} [options.lineCount]
 * @param {number | null} [options.fileLineCount] total lines on the new side, when known
 * @param {number | null} [options.cursorNew] the outermost new-side line already on screen for this
 *   hunk and direction, exclusive. The browser owns this: expansions are view state that is never
 *   written to the snapshot, so the client tells the server where it got to rather than the server
 *   keeping a per-viewer position it would have to invalidate.
 * @returns {ExpandRange | null} null when there is nothing left to reveal
 */
export function expandRange(file, hunkIndex, direction, options = {}) {
  const hunk = file.hunks[hunkIndex];
  if (!hunk) return null;
  const lineCount = Math.max(1, options.lineCount ?? EXPAND_CHUNK_LINES);
  const already = file.expanded[`${direction}Hunk:${hunkIndex}`] ?? [];
  const cursorNew = options.cursorNew ?? null;

  if (direction === "before") {
    const oldOffset = hunk.newStart - hunk.oldStart;
    // Each further click starts above what is already shown.
    const endNew = (cursorNew ?? already[0]?.newLine ?? hunk.newStart) - 1;
    const previous = file.hunks[hunkIndex - 1];
    const shownAfterPrevious = file.expanded[`afterHunk:${hunkIndex - 1}`] ?? [];
    const previousEnd =
      shownAfterPrevious.at(-1)?.newLine ?? (previous ? previous.newStart + previous.newCount - 1 : 0);
    const floor = Math.max(1, previousEnd + 1);
    const startNew = Math.max(floor, endNew - lineCount + 1);
    if (startNew > endNew) return null;
    return { startNew, endNew, oldOffset, boundedByHunk: startNew === floor && Boolean(previous) };
  }

  const oldOffset = hunk.newStart + hunk.newCount - (hunk.oldStart + hunk.oldCount);
  const startNew = (cursorNew ?? already.at(-1)?.newLine ?? hunk.newStart + hunk.newCount - 1) + 1;
  const next = file.hunks[hunkIndex + 1];
  const shownBeforeNext = file.expanded[`beforeHunk:${hunkIndex + 1}`] ?? [];
  const nextStart = shownBeforeNext[0]?.newLine ?? next?.newStart ?? null;
  // With no following hunk the ceiling is the end of the file, which only the content knows.
  const ceiling = nextStart != null ? nextStart - 1 : (options.fileLineCount ?? Number.POSITIVE_INFINITY);
  const endNew = Math.min(ceiling, startNew + lineCount - 1);
  if (startNew > endNew) return null;
  return { startNew, endNew, oldOffset, boundedByHunk: endNew === ceiling && nextStart != null };
}

/**
 * Turn a range plus the file's content into diff lines.
 *
 * @param {string[]} lines whole new-side file, 0-indexed
 * @param {ExpandRange} range
 * @param {number} hunkIndex
 * @param {"before" | "after"} direction
 * @returns {import("./diff/model.js").DiffLine[]}
 */
export function expandedLines(lines, range, hunkIndex, direction) {
  /** @type {import("./diff/model.js").DiffLine[]} */
  const out = [];
  for (let newLine = range.startNew; newLine <= range.endNew; newLine += 1) {
    const text = lines[newLine - 1];
    // Past the end of the file. Happens whenever the last hunk's `after` is clicked, because the
    // diff alone cannot say how long the file is — so it is a normal stop, not an error.
    if (text == null) break;
    out.push({
      key: `x${hunkIndex}:${direction}:${newLine}`,
      hunkIndex,
      indexInHunk: out.length,
      kind: "context",
      oldLine: newLine - range.oldOffset,
      newLine,
      text,
      origin: "expanded",
      commentableSides: [],
    });
  }
  return out;
}

/**
 * Get a file's content at a commit, preferring a local clone and caching whatever it took.
 *
 * @param {object} input
 * @param {string} input.cacheDir the session's `blobs/` directory
 * @param {string[]} input.localRepos
 * @param {import("./pr-ref.js").PrRef} input.ref
 * @param {string} input.sha
 * @param {string} input.path
 * @param {object} [deps]
 * @param {typeof fetchBlobLines} [deps.fetchBlobLinesImpl]
 * @param {typeof showFromAnyClone} [deps.showFromAnyCloneImpl]
 * @returns {Promise<{ lines: string[], source: "cache" | "local-git" | "api" }>}
 */
export async function loadFileLines(input, deps = {}) {
  const fetchImpl = deps.fetchBlobLinesImpl ?? fetchBlobLines;
  const localImpl = deps.showFromAnyCloneImpl ?? showFromAnyClone;

  const cached = await readCachedBlob(input.cacheDir, input.sha, input.path);
  if (cached != null) return { lines: splitFileLines(cached), source: "cache" };

  const local = await localImpl(input.localRepos, input.sha, input.path);
  if (local) {
    await writeCachedBlob(input.cacheDir, input.sha, input.path, local.content);
    return { lines: splitFileLines(local.content), source: "local-git" };
  }

  let lines;
  try {
    lines = await fetchImpl(input.ref, input.sha, input.path);
  } catch (error) {
    // Surfaced rather than swallowed: the reviewer asked for these lines, and showing nothing with
    // no explanation reads as a broken button.
    throw new AxiError(
      `Could not read ${input.path} at ${input.sha.slice(0, 7)} to expand context`,
      "DEPENDENCY_ERROR",
      [
        "Check `gh auth status`",
        "Or open the PR's local clone so context can be read with git instead",
        error instanceof Error ? error.message : String(error),
      ],
    );
  }
  await writeCachedBlob(input.cacheDir, input.sha, input.path, `${lines.join("\n")}\n`);
  return { lines, source: "api" };
}

/**
 * The cache file for one blob.
 *
 * The path is percent-encoded into a single flat filename, so a repository path with slashes cannot
 * escape the cache directory or collide with a directory of its own name.
 *
 * @param {string} cacheDir
 * @param {string} sha
 * @param {string} filePath
 */
export function blobCachePath(cacheDir, sha, filePath) {
  return path.join(cacheDir, sha, encodeURIComponent(filePath));
}

/**
 * @param {string} cacheDir
 * @param {string} sha
 * @param {string} filePath
 * @returns {Promise<string | null>}
 */
export async function readCachedBlob(cacheDir, sha, filePath) {
  try {
    const file = blobCachePath(cacheDir, sha, filePath);
    const content = await readFile(file, "utf8");
    // Touch so the LRU sees this as recently used. Best-effort; a failure here only costs accuracy.
    await touch(file);
    return content;
  } catch {
    return null;
  }
}

/**
 * @param {string} cacheDir
 * @param {string} sha
 * @param {string} filePath
 * @param {string} content
 */
export async function writeCachedBlob(cacheDir, sha, filePath, content) {
  const bytes = Buffer.byteLength(content, "utf8");
  if (bytes > MAX_BLOB_BYTES) return;
  const file = blobCachePath(cacheDir, sha, filePath);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, content, "utf8");
  await evictBlobs(cacheDir);
}

/** @param {string} file */
async function touch(file) {
  try {
    const { utimes } = await import("node:fs/promises");
    const now = new Date();
    await utimes(file, now, now);
  } catch {
    // Read-only filesystem, or the file vanished between read and touch.
  }
}

/**
 * Drop least-recently-used blobs until the session's cache fits.
 *
 * @param {string} cacheDir
 * @param {number} [cap]
 */
export async function evictBlobs(cacheDir, cap = MAX_BLOB_CACHE_BYTES) {
  /** @type {Array<{ file: string, size: number, used: number }>} */
  const entries = [];
  let total = 0;
  try {
    for (const shaDir of await readdir(cacheDir)) {
      const dir = path.join(cacheDir, shaDir);
      let names;
      try {
        names = await readdir(dir);
      } catch {
        continue; // not a directory
      }
      for (const name of names) {
        const file = path.join(dir, name);
        try {
          const info = await stat(file);
          entries.push({ file, size: info.size, used: info.mtimeMs });
          total += info.size;
        } catch {
          // Raced with another eviction.
        }
      }
    }
  } catch {
    return; // no cache yet
  }
  if (total <= cap) return;
  entries.sort((a, b) => a.used - b.used);
  for (const entry of entries) {
    if (total <= cap) break;
    try {
      await unlink(entry.file);
      total -= entry.size;
    } catch {
      // Already gone.
    }
  }
}

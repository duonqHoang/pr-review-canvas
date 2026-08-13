import { execFile } from "node:child_process";

/**
 * Reading file content out of a local clone.
 *
 * This exists purely as the *first* choice for expand-context, and the reason is arithmetic: a
 * reviewer expanding context clicks it dozens of times in a session, each click needs the whole
 * file at one commit, and a local clone answers for free — offline, instantly, and without spending
 * an API request against a rate limit that is shared with everything else `gh` does.
 *
 * The clone is a **hint**, never a requirement. A session belongs to a pull request, not to a
 * checkout (the same PR opened from two clones is one session), so every path through here degrades
 * to the API rather than failing. A clone that is stale, shallow, or simply does not contain the
 * commit is the normal case, not an error worth reporting.
 *
 * `git` is spawned with `execFile` and never through a shell, for the same reason as `gh`: a path
 * out of a diff is attacker-influenced text.
 */

/** A local clone will not be consulted for longer than this; the API is the faster answer by then. */
const GIT_TIMEOUT_MS = 5_000;

/** Matching gh.js: a big file must not truncate silently. */
const MAX_BUFFER = 64 * 1024 * 1024;

/**
 * @param {string[]} args
 * @param {{ cwd: string, timeoutMs?: number }} options
 * @returns {Promise<{ code: number, stdout: string, stderr: string }>}
 */
export function gitRaw(args, options) {
  return new Promise((resolve, reject) => {
    execFile(
      "git",
      args,
      {
        cwd: options.cwd,
        maxBuffer: MAX_BUFFER,
        timeout: options.timeoutMs ?? GIT_TIMEOUT_MS,
        windowsHide: true,
        // A clone with a broken hook or a pager configured must not hang the server.
        env: { ...process.env, GIT_PAGER: "cat", GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0" },
      },
      (error, stdout, stderr) => {
        if (error && /** @type {{ code?: unknown }} */ (error).code === "ENOENT") {
          // git is not installed. Not an error here — it just means this path is unavailable.
          resolve({ code: 127, stdout: "", stderr: "git is not installed" });
          return;
        }
        if (error && /** @type {{ killed?: boolean }} */ (error).killed) {
          resolve({ code: 124, stdout: "", stderr: "git timed out" });
          return;
        }
        if (error && typeof (/** @type {{ code?: unknown }} */ (error).code) !== "number") {
          reject(error);
          return;
        }
        resolve({
          code: error ? Number(/** @type {{ code?: unknown }} */ (error).code) : 0,
          stdout: String(stdout ?? ""),
          stderr: String(stderr ?? ""),
        });
      },
    );
  });
}

/**
 * Whether a commit object is present locally.
 *
 * Checked separately from reading the file because the two failures mean different things: a missing
 * commit means "fetch, or use the API", while a missing path at a present commit means the file did
 * not exist there — and no amount of fetching will change that.
 *
 * @param {string} repoDir
 * @param {string} sha
 * @returns {Promise<boolean>}
 */
export async function hasCommit(repoDir, sha) {
  if (!isShaLike(sha)) return false;
  const result = await gitRaw(["cat-file", "-e", `${sha}^{commit}`], { cwd: repoDir });
  return result.code === 0;
}

/**
 * Read one file at one commit from a local clone.
 *
 * @param {string} repoDir
 * @param {string} sha
 * @param {string} path repository-relative
 * @returns {Promise<string | null>} null when this clone cannot answer
 */
export async function showFileAtCommit(repoDir, sha, path) {
  if (!isShaLike(sha) || !path) return null;
  // `--` separates the revision from the path so a path that looks like a flag or a ref cannot be
  // reinterpreted as one.
  const result = await gitRaw(["show", `${sha}:${path}`, "--"], { cwd: repoDir });
  return result.code === 0 ? result.stdout : null;
}

/**
 * Try every known clone in turn.
 *
 * @param {string[]} repoDirs
 * @param {string} sha
 * @param {string} path
 * @returns {Promise<{ content: string, repoDir: string } | null>}
 */
export async function showFromAnyClone(repoDirs, sha, path) {
  for (const repoDir of repoDirs) {
    try {
      if (!(await hasCommit(repoDir, sha))) continue;
      const content = await showFileAtCommit(repoDir, sha, path);
      if (content != null) return { content, repoDir };
    } catch {
      // A directory that has been deleted or is not a repository at all. Try the next one.
    }
  }
  return null;
}

/**
 * A SHA is interpolated into a revision argument, so it is validated rather than trusted. Reject
 * anything that is not a plain hex object name — a ref name here could resolve to something else
 * entirely, and `..` would turn one revision into a range.
 *
 * @param {string} value
 */
export function isShaLike(value) {
  return /^[0-9a-f]{7,64}$/i.test(String(value ?? ""));
}

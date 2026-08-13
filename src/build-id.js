import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * A fingerprint of the code a running server was started from.
 *
 * `version` alone is not enough to decide whether a background server is current. During
 * development the version does not change between edits, so `ensureServer` kept happily reusing a
 * process running code from ten minutes ago — and the symptom is the worst kind: the fix appears not
 * to work. Worse, the obvious workaround (restart the server) rotates the session's `accessId` and
 * kills the browser tab the user was reviewing in, so the cost of guessing wrong is real.
 *
 * Hashing content rather than mtimes is deliberate: a `git checkout` rewrites mtimes on files whose
 * bytes never changed, and a build id that flapped on branch switches would restart the server —
 * and close the tab — for nothing.
 */

const here = path.dirname(fileURLToPath(import.meta.url));

/** Extensions that change what the server does or serves. */
const RELEVANT = new Set([".js", ".mjs", ".css"]);

/** Never walked: caches and generated trees that are not what the server runs. */
const SKIP_DIRS = new Set(["node_modules", ".git"]);

/**
 * Delimiter between the hashed fields.
 *
 * NUL, because it is the one byte that cannot occur in a path and so cannot let two different trees
 * hash the same. Written as an escape rather than as a literal: an earlier version had the raw byte
 * in the source, which made git classify this file as binary — GitHub then reported it as a 0-line
 * change and withheld its patch entirely, so the file could not be reviewed in the tool it is part
 * of. Found by opening this project's own PR in the canvas.
 */
const SEPARATOR = "\0";

/** @type {string | null} */
let cached = null;

/**
 * The build id for this process. Computed once — the answer cannot change while the process runs,
 * because the modules are already loaded.
 *
 * @param {string} [root] defaults to this file's directory, i.e. `src/`
 * @returns {Promise<string>}
 */
export async function buildId(root = here) {
  if (cached && root === here) return cached;
  const files = (await collect(root)).sort();
  const hash = createHash("sha256");
  for (const file of files) {
    // The path goes into the hash as well as the bytes, so a rename with identical content still
    // reads as a change — it is one, for anything that resolves a module by name.
    hash.update(path.relative(root, file));
    hash.update(SEPARATOR);
    hash.update(await readFile(file));
    hash.update(SEPARATOR);
  }
  const id = hash.digest("hex").slice(0, 16);
  if (root === here) cached = id;
  return id;
}

/**
 * @param {string} dir
 * @returns {Promise<string[]>}
 */
async function collect(dir) {
  /** @type {string[]} */
  const found = [];
  /** @type {import("node:fs").Dirent[]} */
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    // A missing directory yields no files rather than an error: a build id is a diagnostic, and
    // failing to serve `/health` over one would be worse than a less precise answer.
    return found;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      found.push(...(await collect(full)));
    } else if (RELEVANT.has(path.extname(entry.name))) {
      found.push(full);
    }
  }
  return found;
}

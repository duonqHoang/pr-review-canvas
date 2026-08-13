import { randomBytes } from "node:crypto";
import { open, readFile, rename, unlink, writeFile } from "node:fs/promises";

/**
 * Durable JSON on disk.
 *
 * lavish rewrites one shared `state.json` in place on every mutation. That is fine for a
 * transient prompt queue; it is not fine here. A user may spend thirty minutes writing review
 * prose that exists nowhere else, and a crash or ENOSPC part-way through a whole-file rewrite
 * truncates it. So: write to a sibling temp file, fsync it, then rename. Rename within a
 * directory is atomic, so a reader either sees the old file or the new one — never a half-written
 * one.
 */

/**
 * @param {string} file
 * @param {unknown} value
 * @returns {Promise<void>}
 */
export async function writeJsonAtomic(file, value) {
  const serialized = `${JSON.stringify(value, null, 2)}\n`;
  // The temp file must live in the same directory as the target: rename is only atomic within a
  // filesystem, and /tmp is frequently a different one.
  //
  // The random suffix is load-bearing, not decoration. With only pid + timestamp, two writes to
  // the same target inside one millisecond pick the SAME temp path: both open it, the first
  // rename moves it away, and the second rename fails with ENOENT. That is a real crash, not a
  // theoretical race — concurrent writers to a shared file hit it immediately.
  const temp = `${file}.${process.pid}.${Date.now()}.${randomBytes(6).toString("hex")}.tmp`;
  let handle;
  try {
    handle = await open(temp, "w");
    await handle.writeFile(serialized, "utf8");
    // Without the fsync, the rename can land while the contents are still only in the page
    // cache — which on a hard power loss yields an empty file where the old one used to be.
    await handle.sync();
  } finally {
    await handle?.close();
  }
  try {
    await rename(temp, file);
  } catch (error) {
    await unlink(temp).catch(() => {});
    throw error;
  }
}

/**
 * @template T
 * @param {string} file
 * @param {T} fallback
 * @returns {Promise<T>}
 */
export async function readJsonOr(file, fallback) {
  try {
    const text = await readFile(file, "utf8");
    if (!text.trim()) return fallback;
    return /** @type {T} */ (JSON.parse(text));
  } catch {
    // A missing file and an unparseable one are the same thing to a caller: there is no usable
    // state here. Journal replay is what recovers the difference.
    return fallback;
  }
}

/**
 * Append one JSON record, newline-delimited.
 *
 * The journal is what makes the fold cache recoverable: a record is appended *before* the
 * snapshot is rewritten, so a crash between the two loses nothing. Appends are `O(record)`
 * rather than `O(state)`, which matters when a debounced autosave fires on every keystroke burst.
 *
 * @param {string} file
 * @param {unknown} record
 * @returns {Promise<void>}
 */
export async function appendJsonl(file, record) {
  await writeFile(file, `${JSON.stringify(record)}\n`, { encoding: "utf8", flag: "a" });
}

/**
 * Read a newline-delimited JSON file, skipping any trailing partial line.
 *
 * A torn final append is expected — it is exactly what a crash mid-write looks like — so it is
 * dropped rather than treated as corruption.
 *
 * @template T
 * @param {string} file
 * @returns {Promise<T[]>}
 */
export async function readJsonl(file) {
  /** @type {T[]} */
  const records = [];
  let text;
  try {
    text = await readFile(file, "utf8");
  } catch {
    return records;
  }
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      records.push(/** @type {T} */ (JSON.parse(line)));
    } catch {
      // Only the last line can legitimately be torn; anything earlier means real corruption,
      // but skipping is still the best available recovery.
      continue;
    }
  }
  return records;
}

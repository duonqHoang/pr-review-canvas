import { createHash } from "node:crypto";

/**
 * The `#diff-<hash>` element id GitHub gives each file in a pull request's Files view.
 *
 * Kept out of `shared/permalink.js` on purpose: that module is imported by the browser bundle and
 * must stay free of `node:crypto`. The hash is computed once per file on the server and handed to
 * the client as data, which also means the client cannot get it subtly wrong.
 *
 * The hash is the SHA-256 of the path's **bytes, with no trailing newline**. That sounds too small
 * to matter and is in fact the single easiest way to break every deep link into a review:
 *
 *     printf 'AGENTS.md' | shasum -a 256   →  a54ff182…78f9   ✓ what GitHub uses
 *     echo   'AGENTS.md' | shasum -a 256   →  954ec5da…       ✗ echo adds \n
 *
 * The second form is what anyone reaches for at a shell prompt, so a test asserts the negative
 * case as well as the positive one.
 */

/**
 * @param {string} path repository-relative path, **not** percent-encoded
 * @returns {string} e.g. `diff-a54ff182…`
 */
export function fileAnchorId(path) {
  return `diff-${fileAnchorHash(path)}`;
}

/**
 * The bare hex digest, without the `diff-` prefix.
 *
 * @param {string} path
 * @returns {string}
 */
export function fileAnchorHash(path) {
  return createHash("sha256")
    .update(Buffer.from(String(path ?? ""), "utf8"))
    .digest("hex");
}

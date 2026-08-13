/**
 * Permanent links back to GitHub.
 *
 * Lives in `shared/` so both the server and the browser build identical URLs, and therefore
 * imports nothing — in particular **not** `node:crypto`. The `#diff-<sha256(path)>` anchors used
 * by the files view need hashing and are built server-side instead.
 *
 * Two details are bug factories and are handled here once:
 *
 * 1. The path in a URL must be percent-encoded **per segment** — `/` stays a separator. A path
 *    with a space or a non-ASCII character breaks every link otherwise.
 * 2. A blob link addresses one revision of one file, so a LEFT-side link must change **both** the
 *    SHA (base, not head) **and** the path (`previousPath` for a rename). Changing only one of
 *    them produces a 404 that looks like a permissions problem.
 */

/** @typedef {{ host: string, owner: string, repo: string }} RepoRef */

/** @param {RepoRef} ref */
export function repoWebUrl(ref) {
  return `https://${ref.host}/${ref.owner}/${ref.repo}`;
}

/**
 * Percent-encode a repository-relative path for use in a URL, preserving separators.
 *
 * @param {string} path
 */
export function encodePathForUrl(path) {
  return String(path ?? "")
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");
}

/**
 * A `blob` link: the most durable form, because it names an immutable commit.
 *
 * Blob links only understand `#L<n>`; they have no notion of side. The caller therefore chooses
 * the SHA and the path that make the requested side correct — see `blobLinkFor`.
 *
 * @param {object} input
 * @param {RepoRef} input.ref
 * @param {string} input.sha
 * @param {string} input.path
 * @param {number} [input.line]
 * @param {number} [input.startLine] when present and different, produces a range
 * @returns {string}
 */
export function blobPermalink({ ref, sha, path, line, startLine }) {
  const base = `${repoWebUrl(ref)}/blob/${encodeURIComponent(sha)}/${encodePathForUrl(path)}`;
  if (line == null) return base;
  if (startLine != null && startLine !== line) {
    const from = Math.min(startLine, line);
    const to = Math.max(startLine, line);
    return `${base}#L${from}-L${to}`;
  }
  return `${base}#L${line}`;
}

/**
 * Pick the SHA and path that make a blob link land on the requested side of the diff.
 *
 * @param {object} input
 * @param {RepoRef} input.ref
 * @param {string} input.headSha
 * @param {string} input.baseSha
 * @param {{ path: string, previousPath: string | null }} input.file
 * @param {import("../diff/model.js").Side} input.side
 * @param {number} [input.line]
 * @param {number} [input.startLine]
 * @returns {string}
 */
export function blobLinkFor({ ref, headSha, baseSha, file, side, line, startLine }) {
  const left = side === "LEFT";
  return blobPermalink({
    ref,
    sha: left ? baseSha : headSha,
    // The only place `previousPath` is the correct path: the base revision predates the rename.
    path: left ? (file.previousPath ?? file.path) : file.path,
    line,
    startLine,
  });
}

/**
 * A link into the pull request's Files view, pinned to a commit.
 *
 * The two forms answer different questions and both are worth offering. A blob link is the durable
 * one — it survives a force-push and shows the file as it was. This one shows the *review context*:
 * the diff, the surrounding conversation, the Files tab someone is already looking at. It is less
 * durable (the anchor is only meaningful while that file is still in the diff), which is exactly why
 * the SHA is in the path: `/files` on its own drifts as the branch moves.
 *
 * `anchorId` comes from `fileAnchorId` on the server. Note the asymmetry it hides: that hash is
 * computed over the **raw** path while the URL elsewhere carries a **percent-encoded** one. Mixing
 * the two up breaks every link for a path containing a space or a non-ASCII character.
 *
 * @param {object} input
 * @param {RepoRef} input.ref
 * @param {number} input.number pull request number
 * @param {string} input.sha commit to pin to; the head SHA of the snapshot being reviewed
 * @param {string} input.anchorId `diff-<sha256(path)>`
 * @param {import("../diff/model.js").Side} [input.side]
 * @param {number} [input.line]
 * @param {number} [input.startLine]
 * @returns {string}
 */
export function filesViewPermalink({ ref, number, sha, anchorId, side, line, startLine }) {
  const base = `${repoWebUrl(ref)}/pull/${number}/files/${encodeURIComponent(sha)}#${anchorId}`;
  if (side == null || line == null) return base;
  return `${base}${lineSuffix(side, line, startLine)}`;
}

/**
 * The `#L…`/`#R…` fragment used by the pull-request files view. Kept here next to the blob form
 * so the difference between the two is visible in one place.
 *
 * @param {import("../diff/model.js").Side} side
 * @param {number} line
 * @param {number} [startLine]
 * @returns {string}
 */
export function lineSuffix(side, line, startLine) {
  const mark = side === "LEFT" ? "L" : "R";
  if (startLine != null && startLine !== line) {
    const from = Math.min(startLine, line);
    const to = Math.max(startLine, line);
    return `${mark}${from}-${mark}${to}`;
  }
  return `${mark}${line}`;
}

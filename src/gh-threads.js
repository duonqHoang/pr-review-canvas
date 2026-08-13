import { fetchLineComments, fetchReviewThreads } from "./gh-fetch.js";

/**
 * Existing review threads on the pull request.
 *
 * Two GitHub APIs are needed and neither is sufficient alone:
 *
 * - **REST** `pulls/{n}/comments` returns every review comment with its anchor, its body and its
 *   `in_reply_to_id`. It has **no notion of resolved**.
 * - **GraphQL** `reviewThreads` is the only place `isResolved` and `isOutdated` exist, but its
 *   comment payload is thin.
 *
 * So the model is built from REST and annotated from GraphQL. The join key is the **first comment of
 * the thread**: REST groups by `in_reply_to_id ?? id`, and GraphQL exposes that same id as its first
 * comment's `databaseId`.
 *
 * A GraphQL failure is not fatal. Some GitHub Enterprise setups and some token scopes refuse it, and
 * losing every existing thread because the resolved flag is unavailable would be a far worse
 * outcome than rendering threads without it.
 */

/**
 * @typedef {object} ExistingComment
 * @property {number} id
 * @property {string} author
 * @property {string} body
 * @property {string} createdAt
 * @property {string} url
 * @property {string} association author_association, for an "author"/"member" chip
 */

/**
 * @typedef {object} ExistingThread
 * @property {string} id GraphQL node id when known, else `rest:<rootCommentId>`
 * @property {number} rootCommentId the id a reply must be addressed to
 * @property {string} path
 * @property {import("./diff/model.js").Side} side
 * @property {number | null} line null means the anchor is no longer in the diff
 * @property {number | null} startLine
 * @property {number | null} originalLine where it was anchored when written
 * @property {number | null} originalStartLine
 * @property {string} diffHunk the trailing diff window GitHub stored with the comment
 * @property {boolean} isResolved
 * @property {boolean} isOutdated
 * @property {boolean} resolvedStateKnown false when GraphQL was unavailable
 * @property {"line" | "file"} subjectType
 * @property {ExistingComment[]} comments oldest first
 */

/** @param {import("./gh-fetch.js").GhReviewComment} comment */
function toExistingComment(comment) {
  return {
    id: Number(comment.id),
    author: String(comment.user?.login ?? "unknown"),
    body: String(comment.body ?? ""),
    createdAt: String(comment.created_at ?? ""),
    url: String(comment.html_url ?? ""),
    association: String(comment.author_association ?? ""),
  };
}

/**
 * Group REST review comments into threads and annotate them from GraphQL.
 *
 * @param {object} input
 * @param {import("./gh-fetch.js").GhReviewComment[]} input.comments
 * @param {import("./gh-fetch.js").GhReviewThreadState[]} [input.reviewThreads]
 * @param {boolean} [input.graphqlAvailable] false when the GraphQL query failed
 * @returns {ExistingThread[]}
 */
export function mergeThreads({ comments, reviewThreads = [], graphqlAvailable = true }) {
  /** @type {Map<number, import("./gh-fetch.js").GhReviewComment[]>} */
  const groups = new Map();
  for (const comment of comments) {
    // A reply carries `in_reply_to_id`; the thread's first comment does not. This is the only
    // grouping signal REST offers, and it is reliable — GitHub does not nest replies further.
    const root = Number(comment.in_reply_to_id ?? comment.id);
    const group = groups.get(root);
    if (group) group.push(comment);
    else groups.set(root, [comment]);
  }

  /** @type {Map<number, import("./gh-fetch.js").GhReviewThreadState>} */
  const byRoot = new Map();
  for (const thread of reviewThreads) {
    if (thread.rootCommentId != null) byRoot.set(Number(thread.rootCommentId), thread);
  }

  /** @type {ExistingThread[]} */
  const out = [];
  for (const [rootId, group] of groups) {
    const ordered = [...group].sort((a, b) => String(a.created_at ?? "").localeCompare(String(b.created_at ?? "")));
    const root = ordered.find((comment) => Number(comment.id) === rootId) ?? ordered[0];
    const state = byRoot.get(rootId);

    const line = root.line ?? null;
    const originalLine = root.original_line ?? null;
    // `line: null` with an `original_line` is GitHub's own way of saying the anchor left the diff.
    // Trust it even when GraphQL is unavailable, because it is the same fact from the other API.
    const outdated = state ? state.isOutdated : line == null && originalLine != null;

    out.push({
      id: state?.id ?? `rest:${rootId}`,
      rootCommentId: rootId,
      path: String(root.path ?? ""),
      side: root.side ?? "RIGHT",
      line,
      startLine: root.start_line ?? null,
      originalLine,
      originalStartLine: root.original_start_line ?? null,
      diffHunk: String(root.diff_hunk ?? ""),
      isResolved: state?.isResolved ?? false,
      isOutdated: outdated,
      resolvedStateKnown: graphqlAvailable && Boolean(state),
      subjectType: root.subject_type === "file" ? "file" : "line",
      comments: ordered.map(toExistingComment),
    });
  }

  // Oldest thread first, so the inline stack under a line reads chronologically.
  out.sort((a, b) => String(a.comments[0]?.createdAt ?? "").localeCompare(String(b.comments[0]?.createdAt ?? "")));
  return out;
}

/**
 * @typedef {object} ThreadsSnapshot
 * @property {ExistingThread[]} threads
 * @property {string} fetchedAt
 * @property {boolean} graphqlAvailable
 * @property {string | null} graphqlError
 */

/**
 * @param {import("./pr-ref.js").PrRef} ref
 * @param {object} [deps]
 * @param {typeof fetchLineComments} [deps.fetchLineCommentsImpl]
 * @param {typeof fetchReviewThreads} [deps.fetchReviewThreadsImpl]
 * @param {() => string} [deps.now]
 * @returns {Promise<ThreadsSnapshot>}
 */
export async function fetchExistingThreads(ref, deps = {}) {
  const fetchComments = deps.fetchLineCommentsImpl ?? fetchLineComments;
  const fetchStates = deps.fetchReviewThreadsImpl ?? fetchReviewThreads;
  const now = deps.now ?? (() => new Date().toISOString());

  const comments = await fetchComments(ref);
  /** @type {import("./gh-fetch.js").GhReviewThreadState[]} */
  let reviewThreads = [];
  /** @type {string | null} */
  let graphqlError = null;
  try {
    reviewThreads = await fetchStates(ref);
  } catch (error) {
    // Degrade to REST only: threads without a resolved flag beat no threads at all.
    graphqlError = String(/** @type {{ message?: unknown }} */ (error)?.message || error);
  }

  return {
    threads: mergeThreads({ comments, reviewThreads, graphqlAvailable: graphqlError === null }),
    fetchedAt: now(),
    graphqlAvailable: graphqlError === null,
    graphqlError,
  };
}

/**
 * Threads anchored in the current diff, keyed by path. Outdated threads are excluded: they have no
 * line to sit on, and the caller renders them in a per-file collapsed list instead.
 *
 * @param {ExistingThread[]} threads
 * @returns {Map<string, ExistingThread[]>}
 */
export function threadsByPath(threads) {
  /** @type {Map<string, ExistingThread[]>} */
  const map = new Map();
  for (const thread of threads) {
    const list = map.get(thread.path);
    if (list) list.push(thread);
    else map.set(thread.path, [thread]);
  }
  return map;
}

/**
 * Where a thread is rendered.
 *
 * An outdated thread has no `line`, so there is nowhere on the current diff to put it — pinning it
 * to `original_line` would attach someone's comment to whatever code now occupies that number,
 * which is exactly the mis-anchoring this project refuses to do anywhere else.
 *
 * @param {ExistingThread} thread
 * @returns {{ placement: "inline", line: number, side: import("./diff/model.js").Side }
 *   | { placement: "file-list", reason: "outdated" | "file-level" }}
 */
export function placementFor(thread) {
  if (thread.subjectType === "file") return { placement: "file-list", reason: "file-level" };
  if (thread.line == null) return { placement: "file-list", reason: "outdated" };
  return { placement: "inline", line: thread.line, side: thread.side };
}

/**
 * A short summary for the poll payload and the CLI. Counts only — thread bodies are other people's
 * words and the agent has no reason to read them unless the user asks.
 *
 * @param {ExistingThread[]} threads
 */
export function summarizeThreads(threads) {
  let unresolved = 0;
  let resolved = 0;
  let outdated = 0;
  for (const thread of threads) {
    if (thread.isResolved) resolved += 1;
    else unresolved += 1;
    if (thread.isOutdated) outdated += 1;
  }
  return { total: threads.length, unresolved, resolved, outdated };
}

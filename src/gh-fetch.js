import { gh, ghJson } from "./gh.js";
import { repoSlug } from "./pr-ref.js";

/**
 * The read path: every GitHub query this tool makes.
 *
 * All of it runs on the **server**, never in the agent's context. A 60-file PR's patches are
 * hundreds of kilobytes and the *human* is the one who reads the diff, so routing that through
 * the model would burn the context budget for nothing. It also has to live here for a second
 * reason: expand-context is a browser click that happens while the agent is asleep inside a
 * long-poll, so the server must be able to call `gh` on its own.
 *
 * Because the server's cwd is not the user's repository, every call passes `--repo` explicitly.
 */

/** PR context the canvas needs, kept in the same `gh pr view` call as the existing header metadata. */
export const PR_VIEW_FIELDS = [
  "number",
  "title",
  "state",
  "isDraft",
  "url",
  "headRefName",
  "baseRefName",
  "headRefOid",
  "baseRefOid",
  "changedFiles",
  "additions",
  "deletions",
  "author",
  "body",
  "createdAt",
  "updatedAt",
  "mergedAt",
  "commits",
  "mergeable",
].join(",");

/**
 * @typedef {object} PullRequestCommit
 * @property {string} oid
 * @property {string} messageHeadline
 * @property {string} authoredDate
 * @property {string} authorLogin
 * @property {string} authorName
 */

/**
 * @typedef {object} PullRequestMeta
 * @property {number} number
 * @property {string} title
 * @property {string} state
 * @property {boolean} isDraft
 * @property {string} url
 * @property {string} headRefName
 * @property {string} baseRefName
 * @property {string} headSha
 * @property {string} baseSha
 * @property {number} changedFiles
 * @property {number} additions
 * @property {number} deletions
 * @property {string} authorLogin
 * @property {string} [body]
 * @property {string} [createdAt]
 * @property {string} [updatedAt]
 * @property {string} [mergedAt]
 * @property {PullRequestCommit[]} [commits]
 */

/**
 * @typedef {object} FetchDeps
 * @property {typeof gh} [ghImpl]
 * @property {typeof ghJson} [ghJsonImpl]
 */

/**
 * @param {import("./pr-ref.js").PrRef} ref
 * @param {FetchDeps} [deps]
 * @returns {Promise<PullRequestMeta>}
 */
export async function fetchPullRequest(ref, deps = {}) {
  const ghJsonImpl = deps.ghJsonImpl ?? ghJson;
  /** @type {Record<string, unknown>} */
  const view = await ghJsonImpl(["pr", "view", String(ref.number), "--repo", repoSlug(ref), "--json", PR_VIEW_FIELDS]);
  const commits = Array.isArray(view.commits) ? view.commits : [];
  return {
    number: Number(view.number ?? ref.number),
    title: String(view.title ?? ""),
    state: String(view.state ?? "UNKNOWN"),
    isDraft: Boolean(view.isDraft),
    url: String(view.url ?? ""),
    headRefName: String(view.headRefName ?? ""),
    baseRefName: String(view.baseRefName ?? ""),
    headSha: String(view.headRefOid ?? ""),
    baseSha: String(view.baseRefOid ?? ""),
    changedFiles: Number(view.changedFiles ?? 0),
    additions: Number(view.additions ?? 0),
    deletions: Number(view.deletions ?? 0),
    authorLogin: String(/** @type {{ login?: unknown }} */ (view.author)?.login ?? ""),
    body: String(view.body ?? ""),
    createdAt: String(view.createdAt ?? ""),
    updatedAt: String(view.updatedAt ?? ""),
    mergedAt: String(view.mergedAt ?? ""),
    commits: commits.map((entry) => {
      const commit = /** @type {Record<string, unknown>} */ (entry);
      const authors = Array.isArray(commit.authors) ? commit.authors : [];
      const author = /** @type {Record<string, unknown>} */ (authors[0] ?? {});
      return {
        oid: String(commit.oid ?? ""),
        messageHeadline: String(commit.messageHeadline ?? ""),
        authoredDate: String(commit.authoredDate ?? ""),
        authorLogin: String(author.login ?? ""),
        authorName: String(author.name ?? ""),
      };
    }),
  };
}

/**
 * Per-file diffs. `--paginate` is required: the endpoint pages at 100 and caps at 3000 entries.
 *
 * @param {import("./pr-ref.js").PrRef} ref
 * @param {FetchDeps} [deps]
 * @returns {Promise<import("./diff/parse-patch.js").GhFileEntry[]>}
 */
export async function fetchFiles(ref, deps = {}) {
  const ghJsonImpl = deps.ghJsonImpl ?? ghJson;
  /** @type {import("./diff/parse-patch.js").GhFileEntry[]} */
  const entries = await ghJsonImpl([
    "api",
    "--paginate",
    "--slurp",
    `repos/${repoSlug(ref)}/pulls/${ref.number}/files?per_page=100`,
  ]);
  // With --slurp, gh returns an array of pages; without it, a single page object. Flatten both.
  return flattenPages(entries);
}

/**
 * The whole unified diff. Used only as a fallback for files whose `patch` the files endpoint
 * omitted, and to learn which of those are binary.
 *
 * @param {import("./pr-ref.js").PrRef} ref
 * @param {FetchDeps} [deps]
 * @returns {Promise<string>}
 */
export async function fetchWholeDiff(ref, deps = {}) {
  const ghImpl = deps.ghImpl ?? gh;
  return ghImpl(["pr", "diff", String(ref.number), "--repo", repoSlug(ref), "--color", "never"]);
}

/**
 * @typedef {object} GhReviewComment
 * @property {number} id
 * @property {string} [node_id]
 * @property {number} [pull_request_review_id]
 * @property {number} [in_reply_to_id]
 * @property {string} path
 * @property {string} body
 * @property {string} [diff_hunk]
 * @property {string} [commit_id]
 * @property {string} [original_commit_id]
 * @property {number | null} [line]
 * @property {import("./diff/model.js").Side} [side]
 * @property {number | null} [start_line]
 * @property {import("./diff/model.js").Side} [start_side]
 * @property {number | null} [original_line]
 * @property {number | null} [original_start_line]
 * @property {number | null} [position]
 * @property {number | null} [original_position]
 * @property {"line" | "file"} [subject_type]
 * @property {{ login?: string, avatar_url?: string }} [user]
 * @property {string} [author_association]
 * @property {string} [created_at]
 * @property {string} [updated_at]
 * @property {string} [html_url]
 */

/**
 * Line-anchored review comments. Distinct resource from the PR's conversation comments.
 *
 * @param {import("./pr-ref.js").PrRef} ref
 * @param {FetchDeps} [deps]
 * @returns {Promise<GhReviewComment[]>}
 */
export async function fetchLineComments(ref, deps = {}) {
  const ghJsonImpl = deps.ghJsonImpl ?? ghJson;
  /** @type {GhReviewComment[]} */
  const pages = await ghJsonImpl([
    "api",
    "--paginate",
    "--slurp",
    `repos/${repoSlug(ref)}/pulls/${ref.number}/comments?per_page=100&sort=created&direction=asc`,
  ]);
  return flattenPages(pages);
}

/**
 * Conversation-tab comments. A PR is an issue, so these come from the issues endpoint, and
 * `gh pr view --json comments` returns only these — never the line comments above.
 *
 * @param {import("./pr-ref.js").PrRef} ref
 * @param {FetchDeps} [deps]
 * @returns {Promise<Array<Record<string, unknown>>>}
 */
export async function fetchIssueComments(ref, deps = {}) {
  const ghJsonImpl = deps.ghJsonImpl ?? ghJson;
  /** @type {Array<Record<string, unknown>>} */
  const pages = await ghJsonImpl([
    "api",
    "--paginate",
    "--slurp",
    `repos/${repoSlug(ref)}/issues/${ref.number}/comments?per_page=100`,
  ]);
  return flattenPages(pages);
}

const REVIEW_THREADS_QUERY = `
query($owner:String!, $repo:String!, $number:Int!, $cursor:String) {
  repository(owner:$owner, name:$repo) {
    pullRequest(number:$number) {
      reviewThreads(first:100, after:$cursor) {
        pageInfo { hasNextPage endCursor }
        nodes {
          id
          isResolved
          isOutdated
          isCollapsed
          path
          line
          startLine
          diffSide
          comments(first:1) { nodes { databaseId } }
        }
      }
    }
  }
}`;

/**
 * @typedef {object} GhReviewThreadState
 * @property {string} id GraphQL node id
 * @property {boolean} isResolved
 * @property {boolean} isOutdated
 * @property {boolean} isCollapsed
 * @property {string} path
 * @property {number | null} line
 * @property {number | null} startLine
 * @property {import("./diff/model.js").Side | null} diffSide
 * @property {number | null} rootCommentId REST id of the thread's first comment
 */

/**
 * Resolved/unresolved state exists **only** in GraphQL — REST has no field for it. This is the
 * one query we cannot avoid if the UI is to hide or collapse resolved threads.
 *
 * @param {import("./pr-ref.js").PrRef} ref
 * @param {FetchDeps} [deps]
 * @returns {Promise<GhReviewThreadState[]>}
 */
export async function fetchReviewThreads(ref, deps = {}) {
  const ghJsonImpl = deps.ghJsonImpl ?? ghJson;
  /** @type {GhReviewThreadState[]} */
  const threads = [];
  /** @type {string | null} */
  let cursor = null;

  for (let page = 0; page < 50; page += 1) {
    /** @type {Record<string, unknown>} */
    const response = await ghJsonImpl([
      "api",
      "graphql",
      "-f",
      `query=${REVIEW_THREADS_QUERY}`,
      "-F",
      `owner=${ref.owner}`,
      "-F",
      `repo=${ref.repo}`,
      "-F",
      `number=${ref.number}`,
      ...(cursor ? ["-F", `cursor=${cursor}`] : []),
    ]);

    const container = /** @type {any} */ (response)?.data?.repository?.pullRequest?.reviewThreads;
    if (!container) break;
    for (const node of container.nodes ?? []) {
      threads.push({
        id: String(node.id ?? ""),
        isResolved: Boolean(node.isResolved),
        isOutdated: Boolean(node.isOutdated),
        isCollapsed: Boolean(node.isCollapsed),
        path: String(node.path ?? ""),
        line: node.line ?? null,
        startLine: node.startLine ?? null,
        diffSide: node.diffSide ?? null,
        rootCommentId: node.comments?.nodes?.[0]?.databaseId ?? null,
      });
    }
    if (!container.pageInfo?.hasNextPage) break;
    cursor = String(container.pageInfo.endCursor);
  }

  return threads;
}

/**
 * Fetch a whole file at a commit, for expand-context.
 *
 * The caller should try local git first (`git show <sha>:<path>`) — it is free, offline and not
 * rate-limited. This is the fallback. One fetch pulls the entire file so every later expand in
 * that file costs nothing.
 *
 * @param {import("./pr-ref.js").PrRef} ref
 * @param {string} sha
 * @param {string} path
 * @param {FetchDeps} [deps]
 * @returns {Promise<string[]>} lines, without trailing newlines
 */
export async function fetchBlobLines(ref, sha, path, deps = {}) {
  const ghImpl = deps.ghImpl ?? gh;
  const raw = await ghImpl([
    "api",
    "-H",
    "Accept: application/vnd.github.raw",
    `repos/${repoSlug(ref)}/contents/${encodePathForApi(path)}?ref=${encodeURIComponent(sha)}`,
  ]);
  return splitFileLines(raw);
}

/**
 * Split file content into lines without inventing or losing a trailing line.
 *
 * @param {string} content
 * @returns {string[]}
 */
export function splitFileLines(content) {
  const text = String(content ?? "");
  if (text === "") return [];
  const lines = text.split("\n");
  // A terminal newline yields one trailing "" that is not a line of the file.
  if (lines[lines.length - 1] === "") lines.pop();
  return lines;
}

/**
 * Percent-encode a path for use in an API URL path, keeping the separators.
 *
 * @param {string} path
 */
export function encodePathForApi(path) {
  return String(path ?? "")
    .split("/")
    .map(encodeURIComponent)
    .join("/");
}

/**
 * `gh api --paginate --slurp` returns an array of pages; a single request returns one array (or
 * one object). Normalize all of those to a flat array.
 *
 * @template T
 * @param {unknown} value
 * @returns {T[]}
 */
export function flattenPages(value) {
  if (!Array.isArray(value)) return value == null ? [] : [/** @type {T} */ (value)];
  /** @type {T[]} */
  const out = [];
  for (const item of value) {
    if (Array.isArray(item)) out.push(.../** @type {T[]} */ (item));
    else if (item != null) out.push(/** @type {T} */ (item));
  }
  return out;
}

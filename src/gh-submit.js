import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { AxiError } from "./axi.js";
import { gh, ghRaw } from "./gh.js";
import { repoSlug } from "./pr-ref.js";

/**
 * The write path. Exactly one function here talks to GitHub in a way that changes anything.
 *
 * Three properties this module must hold:
 *
 * 1. **No shell, ever.** Review bodies contain backticks, quotes, newlines and ```suggestion
 *    fences. The payload travels as a temp file passed to `--input`, so no user-authored text
 *    reaches argv, let alone a shell.
 * 2. **The batch is atomic.** `POST /pulls/{n}/reviews` either creates every comment or none, and
 *    it answers 422 for the whole batch if a single comment's line is outside the diff. Callers
 *    must have validated first; this module refuses to guess.
 * 3. **Review first, replies second.** Replies post immediately and cannot be batched into a
 *    review. Doing them after means a 422 on the review leaks nothing.
 */

/** GitHub's error string when a comment is anchored outside the diff. Worth matching exactly. */
export const LINE_NOT_IN_DIFF = "pull_request_review_thread.line must be part of the diff";

/**
 * @param {import("./session-store.js").Verdict} verdict
 * @returns {"COMMENT" | "APPROVE" | "REQUEST_CHANGES"}
 */
export function eventForVerdict(verdict) {
  if (verdict === "APPROVE" || verdict === "REQUEST_CHANGES" || verdict === "COMMENT") return verdict;
  throw new AxiError(`Unknown review verdict: ${verdict}`, "VALIDATION_ERROR", [
    "Use COMMENT, APPROVE or REQUEST_CHANGES",
  ]);
}

/** @param {"COMMENT" | "APPROVE" | "REQUEST_CHANGES"} event */
export function expectedStateForEvent(event) {
  return event === "APPROVE" ? "APPROVED" : event === "REQUEST_CHANGES" ? "CHANGES_REQUESTED" : "COMMENTED";
}

/**
 * @typedef {object} ReviewPayload
 * @property {string} commit_id
 * @property {"COMMENT" | "APPROVE" | "REQUEST_CHANGES"} event
 * @property {string} [body]
 * @property {import("./anchor/anchor.js").GitHubReviewComment[]} comments
 */

/**
 * Assemble the review payload.
 *
 * `commit_id` is always sent explicitly. Omitting it lets GitHub default to the PR's newest
 * commit, which silently re-anchors every comment if the author pushed while the human was
 * drafting — the exact failure this tool exists to avoid.
 *
 * @param {object} input
 * @param {string} input.headSha
 * @param {import("./session-store.js").Verdict} input.verdict
 * @param {string} input.body
 * @param {import("./anchor/anchor.js").GitHubReviewComment[]} input.comments
 * @returns {ReviewPayload}
 */
export function buildReviewPayload({ headSha, verdict, body, comments }) {
  const event = eventForVerdict(verdict);
  const trimmedBody = String(body ?? "").trim();

  // GitHub requires a body for COMMENT and REQUEST_CHANGES; it is optional for APPROVE.
  if ((event === "COMMENT" || event === "REQUEST_CHANGES") && !trimmedBody) {
    throw new AxiError(`A ${event} review needs a summary body`, "VALIDATION_ERROR", [
      "Write a short summary in the review dialog before submitting",
    ]);
  }
  if (event === "COMMENT" && comments.length === 0 && !trimmedBody) {
    throw new AxiError("There is nothing to submit", "VALIDATION_ERROR", [
      "Draft at least one comment, or write a summary",
    ]);
  }

  // A file-level comment cannot ride in a review creation. Verified live: with no line GitHub
  // answers `0.position (Expected value to not be null)`, and adding `subject_type: "file"` is
  // rejected on top of that. `subject_type` only works on the standalone
  // `POST /pulls/{n}/comments` endpoint, which is a separate, non-atomic call — the same shape as a
  // reply. Refused here rather than sent, because a 422 rejects the whole batch and would take
  // every other comment in the review down with it.
  const fileLevel = comments.filter((comment) => comment.line == null);
  if (fileLevel.length > 0) {
    throw new AxiError("GitHub does not accept file-level comments inside a review", "VALIDATION_ERROR", [
      `Affected: ${fileLevel.map((comment) => comment.path).join(", ")}`,
      "Anchor the comment to a line in the diff, or leave the point in the review summary",
    ]);
  }

  /** @type {ReviewPayload} */
  const payload = { commit_id: headSha, event, comments };
  if (trimmedBody) payload.body = trimmedBody;
  return payload;
}

/**
 * @typedef {object} SubmitResult
 * @property {{ id: number, state: string, html_url: string, commit_id: string }} review
 * @property {number} commentsPosted
 * @property {Array<{ id: string, url: string }>} replies
 * @property {Array<{ id: string, error: string }>} failed
 */

/**
 * POST the review.
 *
 * @param {import("./pr-ref.js").PrRef} ref
 * @param {ReviewPayload} payload
 * @param {{ ghRawImpl?: typeof ghRaw }} [deps]
 * @returns {Promise<{ id: number, state: string, html_url: string, commit_id: string }>}
 */
export async function postReview(ref, payload, deps = {}) {
  const ghRawImpl = deps.ghRawImpl ?? ghRaw;
  const dir = await mkdtemp(path.join(tmpdir(), "prc-submit-"));
  const file = path.join(dir, "review.json");
  try {
    await writeFile(file, JSON.stringify(payload), "utf8");
    const result = await ghRawImpl([
      "api",
      `repos/${repoSlug(ref)}/pulls/${ref.number}/reviews`,
      "--method",
      "POST",
      "--input",
      file,
    ]);
    if (result.code !== 0) throw submitError(result, payload);

    /** @type {{ id?: number, state?: string, html_url?: string, commit_id?: string }} */
    const body = JSON.parse(result.stdout || "{}");
    const expected = expectedStateForEvent(payload.event);
    if (body.state && body.state !== expected) {
      // Not fatal, but the user must not be told "approved" when GitHub recorded something else.
      throw new AxiError(`GitHub recorded the review as ${body.state}, not ${expected}`, "SERVER_ERROR", [
        `Check the review at ${body.html_url ?? "the pull request"}`,
      ]);
    }
    return {
      id: Number(body.id ?? 0),
      state: String(body.state ?? expected),
      html_url: String(body.html_url ?? ""),
      commit_id: String(body.commit_id ?? payload.commit_id),
    };
  } finally {
    // The payload contains the user's review prose; do not leave it in /tmp.
    await rm(dir, { recursive: true, force: true });
  }
}

/**
 * Turn a failed submit into an error whose hints name the likely culprit.
 *
 * Deliberately does NOT retry with comments removed. The batch is atomic, so a 422 means nothing
 * was posted and the state is clean — but silently dropping a comment to make the rest succeed
 * would destroy writing the human cannot get back.
 *
 * @param {import("./gh.js").GhResult} result
 * @param {ReviewPayload} payload
 * @returns {AxiError}
 */
export function submitError(result, payload) {
  const text = `${result.stderr}\n${result.stdout}`;
  if (text.includes(LINE_NOT_IN_DIFF)) {
    return new AxiError("GitHub rejected the review: a comment is anchored outside the diff", "VALIDATION_ERROR", [
      "Nothing was posted — the review POST is atomic, so your drafts are intact.",
      `Suspect comments: ${suspectAnchors(payload).join(", ") || "unknown"}`,
      "Ask the user to re-anchor them in the browser, then submit again.",
    ]);
  }
  if (/diff too large/i.test(text)) {
    return new AxiError("GitHub rejected the review: a commented file's diff is too large", "VALIDATION_ERROR", [
      "Nothing was posted.",
      "Move that comment to the pull request conversation instead of a line.",
    ]);
  }
  if (/HTTP 422/.test(text)) {
    return new AxiError("GitHub rejected the review as invalid (422)", "VALIDATION_ERROR", [
      "Nothing was posted.",
      result.stderr.trim(),
    ]);
  }
  return new AxiError("Submitting the review failed", "SERVER_ERROR", [
    "Nothing was posted.",
    result.stderr.trim() || `exit code ${result.code}`,
  ]);
}

/**
 * A short list of `path:line` pairs to report back when GitHub will not say which comment broke.
 *
 * @param {ReviewPayload} payload
 * @returns {string[]}
 */
export function suspectAnchors(payload) {
  return payload.comments.slice(0, 10).map((comment) => {
    const range = comment.start_line ? `${comment.start_line}-${comment.line}` : `${comment.line ?? "file"}`;
    return `${comment.path}:${range}`;
  });
}

/**
 * Post replies to existing threads.
 *
 * These cannot be batched into a review — the replies endpoint posts immediately — so each is
 * reported individually and a failure does not abort the rest.
 *
 * @param {import("./pr-ref.js").PrRef} ref
 * @param {Array<{ id: string, inReplyTo: number, body: string }>} replies
 * @param {{ ghImpl?: typeof gh }} [deps]
 * @returns {Promise<{ posted: Array<{ id: string, url: string }>, failed: Array<{ id: string, error: string }> }>}
 */
export async function postReplies(ref, replies, deps = {}) {
  const ghImpl = deps.ghImpl ?? gh;
  /** @type {Array<{ id: string, url: string }>} */
  const posted = [];
  /** @type {Array<{ id: string, error: string }>} */
  const failed = [];

  for (const reply of replies) {
    const dir = await mkdtemp(path.join(tmpdir(), "prc-reply-"));
    const file = path.join(dir, "reply.json");
    try {
      await writeFile(file, JSON.stringify({ body: reply.body }), "utf8");
      const stdout = await ghImpl([
        "api",
        `repos/${repoSlug(ref)}/pulls/${ref.number}/comments/${reply.inReplyTo}/replies`,
        "--method",
        "POST",
        "--input",
        file,
      ]);
      /** @type {{ html_url?: string }} */
      const body = JSON.parse(stdout || "{}");
      posted.push({ id: reply.id, url: String(body.html_url ?? "") });
    } catch (error) {
      failed.push({ id: reply.id, error: String(/** @type {{ message?: unknown }} */ (error)?.message || error) });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  return { posted, failed };
}

/**
 * The manual equivalent of what `submit` does, for `--dry-run`.
 *
 * Printed so the user can run it themselves and see it go through their own tooling's approval
 * gate. That keeps the manual path auditable rather than hidden.
 *
 * @param {import("./pr-ref.js").PrRef} ref
 * @param {ReviewPayload} payload
 */
export function manualCommandFor(ref, payload) {
  return [
    `cat > review.json <<'JSON'`,
    JSON.stringify(payload, null, 2),
    `JSON`,
    `gh api "repos/${repoSlug(ref)}/pulls/${ref.number}/reviews" --method POST --input review.json`,
  ].join("\n");
}

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { AxiError } from "../src/axi.js";
import { classifyGhError, describeGitHubErrors } from "../src/gh.js";
import { toGitHubComment } from "../src/anchor/anchor.js";
import { validateBatch } from "../src/anchor/validate.js";
import { parseFileEntry } from "../src/diff/parse-patch.js";
import {
  buildReviewPayload,
  eventForVerdict,
  expectedStateForEvent,
  LINE_NOT_IN_DIFF,
  manualCommandFor,
  postReplies,
  postReview,
  submitError,
  suspectAnchors,
} from "../src/gh-submit.js";
import { fixture } from "./fixtures/diffs.js";

const REF = { host: "github.com", owner: "o", repo: "r", number: 7 };

/** @param {string[]} names */
function snapshotOf(names) {
  const files = names.map((name) => parseFileEntry(fixture(name).entry));
  return {
    ref: REF,
    pr: /** @type {any} */ ({}),
    files,
    byPath: new Map(files.map((file) => [file.path, file])),
    headSha: "headsha",
    baseSha: "basesha",
    fetchedAt: "t",
    fileCountCapped: false,
    counts: { files: files.length, additions: 0, deletions: 0, binary: 0, withheld: 0, degraded: 0 },
  };
}

/** @param {Partial<import("../src/gh.js").GhResult>} parts */
const ghResult = (parts) => ({ code: 0, stdout: "", stderr: "", ...parts });

test("verdicts map to events and to the state GitHub should report back", () => {
  assert.equal(eventForVerdict("COMMENT"), "COMMENT");
  assert.equal(expectedStateForEvent("COMMENT"), "COMMENTED");
  assert.equal(expectedStateForEvent("APPROVE"), "APPROVED");
  assert.equal(expectedStateForEvent("REQUEST_CHANGES"), "CHANGES_REQUESTED");
  assert.throws(() => eventForVerdict(/** @type {any} */ ("LGTM")), AxiError);
});

test("buildReviewPayload always pins commit_id explicitly", () => {
  // Omitting it lets GitHub default to the newest commit, silently re-anchoring every comment if
  // the author pushed mid-draft.
  const payload = buildReviewPayload({
    headSha: "abc123",
    verdict: "COMMENT",
    body: "summary",
    comments: [{ path: "a.js", body: "nit", line: 1, side: "RIGHT" }],
  });
  assert.equal(payload.commit_id, "abc123");
  assert.equal(payload.event, "COMMENT");
  assert.equal(payload.body, "summary");
});

test("COMMENT and REQUEST_CHANGES require a body; APPROVE does not", () => {
  const comments = [{ path: "a.js", body: "nit", line: 1, side: /** @type {const} */ ("RIGHT") }];
  assert.throws(() => buildReviewPayload({ headSha: "s", verdict: "COMMENT", body: "  ", comments }), AxiError);
  assert.throws(() => buildReviewPayload({ headSha: "s", verdict: "REQUEST_CHANGES", body: "", comments }), AxiError);
  const approved = buildReviewPayload({ headSha: "s", verdict: "APPROVE", body: "", comments });
  assert.equal(approved.body, undefined, "an empty body must be omitted, not sent as an empty string");
});

test("a line comment carries no subject_type", () => {
  // Verified live against GitHub: the field is documented for `POST /pulls/{n}/comments`, but the
  // `comments[]` of a review creation is a different type internally and rejects it outright —
  //   Variable $threads of type [DraftPullRequestReviewThread] was provided invalid value for
  //   0.subjectType (Field is not defined on DraftPullRequestReviewThread)
  // 422 on a review is atomic, so this one field took the whole batch down with it. `"line"` is the
  // default anyway, so sending it only ever bought a rejection.
  const single = toGitHubComment(anchor("a.js", "RIGHT", 5), "nit");
  assert.equal("subject_type" in single, false);
  assert.deepEqual(single, { path: "a.js", body: "nit", line: 5, side: "RIGHT" });

  const ranged = toGitHubComment({ ...anchor("a.js", "RIGHT", 8), startLine: 5 }, "nit");
  assert.equal("subject_type" in ranged, false);
  assert.equal(ranged.start_line, 5);
  assert.equal(ranged.start_side, "RIGHT");
});

test("a file-level comment is refused by the review payload builder", () => {
  // Also verified live: with no line GitHub answers `0.position (Expected value to not be null)`, and
  // `subject_type: "file"` is rejected on top of that. File-level comments only work on the
  // standalone endpoint, which is a separate non-atomic call. Refusing here is the point — sending
  // one would 422 the review and take every other comment down with it.
  assert.throws(
    () =>
      buildReviewPayload({
        headSha: "abc123",
        verdict: "COMMENT",
        body: "summary",
        comments: [
          { path: "a.js", body: "nit", line: 1, side: "RIGHT" },
          { path: "logo.png", body: "whole-file note", subject_type: "file" },
        ],
      }),
    (error) => {
      assert.ok(error instanceof AxiError);
      assert.match(error.message, /does not accept file-level comments inside a review/);
      // The path is named, because the user has to know which comment to re-anchor.
      assert.ok(error.suggestions.some((hint) => hint.includes("logo.png")));
      return true;
    },
  );
});

test("an empty review with no body is refused", () => {
  assert.throws(() => buildReviewPayload({ headSha: "s", verdict: "COMMENT", body: "", comments: [] }), AxiError);
});

test("a 422 surfaces GitHub's own words, which live in stdout", () => {
  // `gh api` prints the response body to stdout and only a one-line summary to stderr, so keying on
  // stderr alone reported "Unprocessable Entity (HTTP 422)" and nothing else. That is undiagnosable:
  // it cost a live debugging session to discover the offending field was `subject_type`.
  const body = JSON.stringify({
    message: "Unprocessable Entity",
    errors: [
      "Variable $threads of type [DraftPullRequestReviewThread] was provided invalid value for " +
        "0.subjectType (Field is not defined on DraftPullRequestReviewThread)",
    ],
  });
  const error = classifyGhError(["api", "repos/o/r/pulls/3/reviews"], {
    code: 1,
    stdout: body,
    stderr: "gh: Unprocessable Entity (HTTP 422)",
  });
  assert.equal(error.code, "VALIDATION_ERROR");
  assert.ok(
    error.suggestions.some((hint) => hint.includes("subjectType")),
    "the field GitHub rejected must appear in the output",
  );
});

test("GitHub error bodies of every shape are readable", () => {
  // Strings (what the review endpoint returns, because it proxies to GraphQL) and objects (the usual
  // REST shape) both have to come through.
  assert.deepEqual(describeGitHubErrors(JSON.stringify({ message: "Bad", errors: ["one", "two"] })), [
    "Bad",
    "one",
    "two",
  ]);
  assert.deepEqual(
    describeGitHubErrors(
      JSON.stringify({
        message: "Validation Failed",
        errors: [{ resource: "PullRequestReviewComment", field: "line", code: "invalid", message: "Line is bad" }],
      }),
    ),
    ["Validation Failed", "PullRequestReviewComment line invalid Line is bad"],
  );
  // Not JSON at all, or empty: show what there is rather than nothing.
  assert.deepEqual(describeGitHubErrors("<html>502</html>"), ["<html>502</html>"]);
  assert.deepEqual(describeGitHubErrors(""), []);
  assert.deepEqual(describeGitHubErrors(JSON.stringify({ message: "Just a message" })), ["Just a message"]);
});

test("postReview sends the payload via --input, never through argv", async () => {
  /** @type {string[]} */
  let seenArgs = [];
  /** @type {string} */
  let written = "";
  const review = await postReview(
    REF,
    buildReviewPayload({
      headSha: "abc",
      verdict: "COMMENT",
      // Deliberately hostile: backticks, quotes, newlines, a fence, a shell metacharacter.
      body: 'look at `x`; "quoted"\n```suggestion\nrm -rf /\n```\n$(whoami)',
      comments: [{ path: "a.js", body: "nit", line: 1, side: "RIGHT" }],
    }),
    {
      ghRawImpl: async (args) => {
        seenArgs = args;
        const inputIndex = args.indexOf("--input");
        written = await readFile(args[inputIndex + 1], "utf8");
        return ghResult({ stdout: JSON.stringify({ id: 5, state: "COMMENTED", html_url: "u", commit_id: "abc" }) });
      },
    },
  );

  assert.deepEqual(seenArgs.slice(0, 4), ["api", "repos/o/r/pulls/7/reviews", "--method", "POST"]);
  assert.ok(seenArgs.includes("--input"));
  // No fragment of the body may appear in argv.
  assert.equal(
    seenArgs.some((arg) => arg.includes("whoami") || arg.includes("suggestion")),
    false,
  );
  assert.match(written, /whoami/, "the body travels in the file");
  assert.equal(review.id, 5);
  assert.equal(review.state, "COMMENTED");
});

test("postReview refuses a response whose state does not match the verdict sent", async () => {
  await assert.rejects(
    () =>
      postReview(REF, buildReviewPayload({ headSha: "abc", verdict: "APPROVE", body: "", comments: [] }), {
        ghRawImpl: async () => ghResult({ stdout: JSON.stringify({ id: 1, state: "PENDING", html_url: "u" }) }),
      }),
    (error) => error instanceof AxiError && /recorded the review as PENDING/.test(error.message),
  );
});

test("postReview deletes the temp payload file even on failure", async () => {
  /** @type {string} */
  let file = "";
  await assert.rejects(() =>
    postReview(REF, buildReviewPayload({ headSha: "abc", verdict: "APPROVE", body: "", comments: [] }), {
      ghRawImpl: async (args) => {
        file = args[args.indexOf("--input") + 1];
        return ghResult({ code: 1, stderr: "HTTP 500" });
      },
    }),
  );
  await assert.rejects(() => readFile(file, "utf8"), /ENOENT/);
});

test("a line-not-in-diff 422 says nothing was posted and names the suspects", () => {
  const payload = buildReviewPayload({
    headSha: "abc",
    verdict: "COMMENT",
    body: "summary",
    comments: [
      { path: "a.js", body: "x", line: 10, side: "RIGHT" },
      { path: "b.js", body: "y", line: 4, side: "RIGHT", start_line: 2, start_side: "RIGHT" },
    ],
  });
  const error = submitError(
    ghResult({ code: 1, stderr: `HTTP 422: Validation Failed (${LINE_NOT_IN_DIFF})` }),
    payload,
  );
  assert.equal(error.code, "VALIDATION_ERROR");
  const hints = error.suggestions.join(" ");
  assert.match(hints, /Nothing was posted/);
  assert.match(hints, /a\.js:10/);
  assert.match(hints, /b\.js:2-4/);
});

test("a diff-too-large rejection suggests moving the comment off the line", () => {
  const payload = buildReviewPayload({
    headSha: "abc",
    verdict: "COMMENT",
    body: "s",
    comments: [{ path: "big.js", body: "x", line: 1, side: "RIGHT" }],
  });
  const error = submitError(ghResult({ code: 1, stderr: "HTTP 422: path diff too large" }), payload);
  assert.match(error.suggestions.join(" "), /conversation instead of a line/);
});

test("suspectAnchors is bounded so a huge batch does not flood the output", () => {
  const comments = Array.from({ length: 30 }, (_unused, i) => ({
    path: `f${i}.js`,
    body: "x",
    line: i + 1,
    side: /** @type {const} */ ("RIGHT"),
  }));
  assert.equal(suspectAnchors({ commit_id: "s", event: "COMMENT", comments }).length, 10);
});

test("replies post one at a time, and one failure does not abort the rest", async () => {
  let call = 0;
  const { posted, failed } = await postReplies(
    REF,
    [
      { id: "r1", inReplyTo: 111, body: "first" },
      { id: "r2", inReplyTo: 222, body: "second" },
      { id: "r3", inReplyTo: 333, body: "third" },
    ],
    {
      ghImpl: async (args) => {
        call += 1;
        assert.ok(args.includes("--input"), "a reply body must also travel in a file");
        if (call === 2) throw new AxiError("HTTP 404", "NOT_FOUND");
        return JSON.stringify({ html_url: `https://example.test/c/${call}` });
      },
    },
  );
  assert.deepEqual(
    posted.map((entry) => entry.id),
    ["r1", "r3"],
  );
  assert.equal(failed.length, 1);
  assert.equal(failed[0].id, "r2");
});

test("manualCommandFor produces a command that would trip an approval gate on purpose", () => {
  const payload = buildReviewPayload({
    headSha: "abc",
    verdict: "COMMENT",
    body: "s",
    comments: [{ path: "a.js", body: "x", line: 1, side: "RIGHT" }],
  });
  const command = manualCommandFor(REF, payload);
  assert.match(command, /gh api "repos\/o\/r\/pulls\/7\/reviews" --method POST --input review\.json/);
  assert.match(command, /"commit_id": "abc"/);
});

// ---------------------------------------------------------------------------
// The layer that actually prevents the 422: validation before submit.
// ---------------------------------------------------------------------------

test("validateBatch yields a payload only when every comment is anchored inside the diff", () => {
  const snapshot = snapshotOf(["simple-modified", "multi-hunk-gap"]);
  const good = validateBatch(
    [
      { id: "c1", anchor: anchor("src/retry.ts", "RIGHT", 13), body: "ok" },
      { id: "c2", anchor: anchor("src/server.js", "RIGHT", 42), body: "ok" },
    ],
    /** @type {any} */ (snapshot),
  );
  assert.equal(good.ok, true);
  assert.equal(good.payload?.comments.length, 2);
  assert.equal(good.payload?.commit_id, "headsha");
});

test("validateBatch withholds the payload entirely when one comment is bad", () => {
  // The POST is atomic, so a batch containing one known-bad comment must never be sent.
  const snapshot = snapshotOf(["multi-hunk-gap"]);
  const batch = validateBatch(
    [
      { id: "good", anchor: anchor("src/server.js", "RIGHT", 42), body: "ok" },
      { id: "bad", anchor: anchor("src/server.js", "RIGHT", 25), body: "outside any hunk" },
    ],
    /** @type {any} */ (snapshot),
  );
  assert.equal(batch.ok, false);
  assert.deepEqual(batch.blocking, ["bad"]);
  assert.equal(batch.payload, undefined, "no payload at all, not a filtered one");
});

test("a range spanning a hunk gap is blocked with a clamp suggestion", () => {
  const snapshot = snapshotOf(["multi-hunk-gap"]);
  const batch = validateBatch(
    [{ id: "c", anchor: { ...anchor("src/server.js", "RIGHT", 42), startLine: 12, startSide: "RIGHT" }, body: "x" }],
    /** @type {any} */ (snapshot),
  );
  assert.equal(batch.ok, false);
  const result = batch.results.c;
  assert.equal(result.ok, false);
  assert.equal(result.ok === false && result.reason, "range-not-fully-in-diff");
  assert.equal(result.ok === false && result.nearestValid?.how, "clamp-to-hunk");
  // The repair is offered, never applied.
  assert.equal(batch.payload, undefined);
});

test("a comment on a renamed file's old path is blocked with the new path offered", () => {
  const snapshot = snapshotOf(["rename-with-hunks"]);
  const batch = validateBatch(
    [{ id: "c", anchor: anchor("src/old-name.js", "RIGHT", 2), body: "x" }],
    /** @type {any} */ (snapshot),
  );
  const result = batch.results.c;
  assert.equal(result.ok === false && result.reason, "file-referenced-by-old-path");
  assert.equal(result.ok === false && result.nearestValid?.anchor.path, "src/new-name.js");
});

test("a comment on a file whose diff was withheld is blocked", () => {
  const snapshot = snapshotOf(["patch-withheld"]);
  const batch = validateBatch(
    [{ id: "c", anchor: anchor("assets/logo.png", "RIGHT", 1), body: "x" }],
    /** @type {any} */ (snapshot),
  );
  assert.equal(batch.results.c.ok, false);
});

test("a LEFT anchor on a context line is normalized to RIGHT rather than risked", () => {
  const snapshot = snapshotOf(["simple-modified"]);
  const batch = validateBatch(
    // Old line 12 is a context line; GitHub's own UI would address it as RIGHT 12.
    [{ id: "c", anchor: anchor("src/retry.ts", "LEFT", 12), body: "x" }],
    /** @type {any} */ (snapshot),
  );
  assert.equal(batch.ok, true);
  const result = batch.results.c;
  assert.equal(result.ok, true);
  assert.equal(result.ok === true && result.payload.side, "RIGHT");
  assert.equal(result.ok === true && result.payload.line, 12);
  assert.ok(result.ok === true && result.warnings.includes("normalized-left-context-to-right"));
});

test("a one-line range collapses to a single-line comment instead of failing", () => {
  const snapshot = snapshotOf(["simple-modified"]);
  const batch = validateBatch(
    [{ id: "c", anchor: { ...anchor("src/retry.ts", "RIGHT", 13), startLine: 13, startSide: "RIGHT" }, body: "x" }],
    /** @type {any} */ (snapshot),
  );
  assert.equal(batch.ok, true);
  assert.equal(batch.payload?.comments[0].start_line, undefined);
});

test("a file-level comment omits the line keys entirely rather than sending nulls", () => {
  const snapshot = snapshotOf(["rename-pure"]);
  const batch = validateBatch(
    [{ id: "c", anchor: { kind: "file", path: "src/moved.js" }, body: "whole-file note" }],
    /** @type {any} */ (snapshot),
  );
  assert.equal(batch.ok, true);
  const comment = /** @type {Record<string, unknown>} */ (batch.payload?.comments[0]);
  assert.equal(comment.subject_type, "file");
  assert.equal("line" in comment, false, "GitHub errors on an explicit null line");
  assert.equal("side" in comment, false);
});

/**
 * @param {string} path
 * @param {"LEFT" | "RIGHT"} side
 * @param {number} line
 * @returns {import("../src/anchor/anchor.js").LineAnchor}
 */
function anchor(path, side, line) {
  return {
    kind: "line",
    path,
    side,
    line,
    fingerprint: {
      rawText: "",
      textHash: "",
      beforeHash: "",
      afterHash: "",
      hunkHeader: "",
      blobSha: null,
      headSha: "headsha",
    },
  };
}

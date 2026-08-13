import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { toGitHubComment } from "../src/anchor/anchor.js";
import { allDiffLines } from "../src/diff/model.js";
import { ghRaw } from "../src/gh.js";
import { parseExplicitPrRef } from "../src/pr-ref.js";
import { buildSnapshot } from "../src/snapshot.js";

/**
 * What GitHub actually accepts.
 *
 * Every other test in this repository asserts what *we* believe. This one asks GitHub, because the
 * cost of being wrong is an atomic 422 that rejects a whole review — and the documentation has
 * already been wrong twice in this project's history (`subject_type` inside a review's `comments[]`
 * is rejected; a file-level comment cannot ride in a review at all). Both were found by exactly this
 * technique: post a PENDING review, read the error, delete it.
 *
 * PENDING is the mechanism that makes this safe to run: a pending review is a draft visible to nobody
 * but its author, and it is deleted immediately afterwards. Nothing is ever published.
 *
 * Opt in, because it needs a real open pull request and a real token:
 *
 *   PRC_LIVE=1 PRC_LIVE_PR=owner/repo#123 node --test test/live-github.test.js
 *
 * Use a scratch PR you own. The PR needs at least one file with an addition, a deletion and a context
 * line, which any ordinary edit produces.
 *
 * LEFT-on-context is deliberately **not** probed. GitHub may well accept it, but `normalizeAnchor`
 * rewrites such an anchor to RIGHT at the same source line losslessly, so the answer cannot change
 * any behaviour — and a probe whose only possible effect is pressure to relax a conservative choice
 * for no gain is worth less than the request it costs.
 */

const enabled = process.env.PRC_LIVE === "1" && Boolean(process.env.PRC_LIVE_PR);
const reason = "set PRC_LIVE=1 and PRC_LIVE_PR=owner/repo#N to run the live acceptance tests";

/** @param {string[]} args @param {unknown} [body] */
async function api(args, body) {
  if (body === undefined) return ghRaw(args);
  const dir = await mkdtemp(path.join(tmpdir(), "prc-live-"));
  try {
    const file = path.join(dir, "payload.json");
    await writeFile(file, JSON.stringify(body), "utf8");
    return await ghRaw([...args, "--input", file]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/**
 * Post a PENDING review and delete it, whatever the outcome.
 *
 * @param {import("../src/pr-ref.js").PrRef} ref
 * @param {object} payload
 * @returns {Promise<{ code: number, stdout: string, stderr: string }>}
 */
async function tryPendingReview(ref, payload) {
  const slug = `${ref.owner}/${ref.repo}`;
  // No `event`: that is what makes the review PENDING rather than published.
  const result = await api(["api", `repos/${slug}/pulls/${ref.number}/reviews`, "--method", "POST"], payload);
  if (result.code === 0) {
    const id = Number(JSON.parse(result.stdout || "{}").id ?? 0);
    if (id) await api(["api", `repos/${slug}/pulls/${ref.number}/reviews/${id}`, "--method", "DELETE"]);
  }
  return result;
}

/** @returns {Promise<{ ref: import("../src/pr-ref.js").PrRef, snapshot: any, file: any }>} */
async function liveFixture() {
  const ref = parseExplicitPrRef(String(process.env.PRC_LIVE_PR));
  assert.ok(ref, `PRC_LIVE_PR is not a pull request reference: ${process.env.PRC_LIVE_PR}`);
  const snapshot = await buildSnapshot(ref);
  const file = snapshot.files.find(
    (/** @type {any} */ candidate) => !candidate.degraded && candidate.hunks.length > 0 && candidate.additions > 0,
  );
  assert.ok(file, "the live PR needs at least one file with a parsed hunk and an addition");
  return { ref, snapshot, file };
}

test("GitHub accepts every anchor shape the validator certifies", { skip: enabled ? false : reason }, async () => {
  const { ref, snapshot, file } = await liveFixture();
  const lines = allDiffLines(file);
  const addition = lines.find((line) => line.kind === "add");
  const context = lines.find((line) => line.kind === "context");
  const deletion = lines.find((line) => line.kind === "del");
  assert.ok(addition, "the live PR needs an addition");

  /** @type {Array<{ label: string, comment: any }>} */
  const cases = [];
  cases.push({
    label: "addition on RIGHT",
    comment: toGitHubComment(
      {
        kind: "line",
        path: file.path,
        side: "RIGHT",
        line: Number(addition.newLine),
        fingerprint: /** @type {any} */ ({}),
      },
      "prc live acceptance probe: addition",
    ),
  });
  if (context) {
    // The pairing this test was written to settle. `commentableSidesFor` reports RIGHT only for a
    // context line even though GitHub documents LEFT as legal there, and that choice stays until this
    // says otherwise.
    cases.push({
      label: "context on RIGHT",
      comment: toGitHubComment(
        {
          kind: "line",
          path: file.path,
          side: "RIGHT",
          line: Number(context.newLine),
          fingerprint: /** @type {any} */ ({}),
        },
        "prc live acceptance probe: context",
      ),
    });
  }
  if (deletion) {
    cases.push({
      label: "deletion on LEFT",
      comment: toGitHubComment(
        {
          kind: "line",
          path: file.path,
          side: "LEFT",
          line: Number(deletion.oldLine),
          fingerprint: /** @type {any} */ ({}),
        },
        "prc live acceptance probe: deletion",
      ),
    });
  }

  // Each shape on its own, so a rejection names which one. A single batch would only say the review
  // failed — the same undiagnosable outcome an atomic 422 gives a user.
  for (const entry of cases) {
    const result = await tryPendingReview(ref, {
      commit_id: snapshot.headSha,
      body: "prc live acceptance probe",
      comments: [entry.comment],
    });
    assert.equal(result.code, 0, `GitHub rejected ${entry.label}: ${result.stdout}\n${result.stderr}`);
  }
});

test("GitHub accepts a multi-line range inside one hunk", { skip: enabled ? false : reason }, async () => {
  const { ref, snapshot, file } = await liveFixture();
  // Two consecutive RIGHT-commentable numbers within a single hunk. A range that crossed a hunk gap
  // would be rejected, which is the rule `isRangeCommentable` enforces and the next test probes.
  const hunk = file.hunks.find(
    (/** @type {any} */ candidate) =>
      candidate.lines.filter((/** @type {any} */ line) => line.newLine != null).length >= 2,
  );
  assert.ok(hunk, "the live PR needs a hunk with at least two new-side lines");
  const numbers = hunk.lines
    .filter((/** @type {any} */ line) => line.newLine != null && line.kind !== "del")
    .map((/** @type {any} */ line) => Number(line.newLine));

  const result = await tryPendingReview(ref, {
    commit_id: snapshot.headSha,
    body: "prc live acceptance probe",
    comments: [
      toGitHubComment(
        {
          kind: "line",
          path: file.path,
          side: "RIGHT",
          startLine: numbers[0],
          startSide: "RIGHT",
          line: numbers[1],
          fingerprint: /** @type {any} */ ({}),
        },
        "prc live acceptance probe: range",
      ),
    ],
  });
  assert.equal(result.code, 0, `GitHub rejected a same-hunk range: ${result.stdout}\n${result.stderr}`);
});

test(
  "GitHub refuses a line outside the diff, as the validator assumes",
  { skip: enabled ? false : reason },
  async () => {
    const { ref, snapshot, file } = await liveFixture();
    const lastHunk = file.hunks[file.hunks.length - 1];
    // Well past the end of the final hunk: a real line in the file, never part of the diff. The
    // validator's strictness is justified by this rejection, so the negative case is as load-bearing as
    // the positives — a tool that only tested acceptance would not notice it had become too permissive.
    const outside = lastHunk.newStart + lastHunk.newCount + 500;

    const result = await tryPendingReview(ref, {
      commit_id: snapshot.headSha,
      body: "prc live acceptance probe",
      comments: [{ path: file.path, body: "prc live acceptance probe: outside", line: outside, side: "RIGHT" }],
    });
    assert.notEqual(result.code, 0, "GitHub accepted a comment outside the diff; the validator is now too strict");
    assert.match(`${result.stdout}\n${result.stderr}`, /diff|line/i);
  },
);

test(
  "a line one row outside a hunk is refused exactly like a distant one",
  { skip: enabled ? false : reason },
  async () => {
    // Settled by probe on 2026-08-12, because "outside the diff" being 500 lines away left an obvious
    // question open: GitHub's own UI offers a comment box on expanded context, so perhaps the API
    // accepts a line that merely *neighbours* a hunk. It does not. Both of these come back
    // `422 Line could not be resolved`, the same as a line far past the end:
    //
    //   - a line in the gap between two hunks (skills/pr-review-canvas/SKILL.md:8, hunks 1..6 and 11..22)
    //   - a line one past the final hunk (:24)
    //
    // So expanded rows carrying no commentable side is not this project being conservative — it is the
    // only shape the API will take, and offering a `+` there would trade a clear "not part of the diff"
    // for an atomic 422 that rejects the whole review at submit time.
    const { ref, snapshot, file } = await liveFixture();
    const hunks = file.hunks;
    /** @type {number[]} */
    const candidates = [];
    const last = hunks[hunks.length - 1];
    candidates.push(last.newStart + last.newCount + 1);
    if (hunks.length > 1) {
      const gap = hunks[0].newStart + hunks[0].newCount;
      if (gap < hunks[1].newStart) candidates.push(gap);
    }

    for (const line of candidates) {
      const result = await tryPendingReview(ref, {
        commit_id: snapshot.headSha,
        body: "prc live acceptance probe",
        comments: [{ path: file.path, body: "prc live acceptance probe: neighbouring line", line, side: "RIGHT" }],
      });
      assert.notEqual(
        result.code,
        0,
        `GitHub accepted line ${line}, one row outside a hunk — expanded rows can now carry a +`,
      );
      assert.match(`${result.stdout}\n${result.stderr}`, /could not be resolved|diff/i);
    }
  },
);

test("a file-level comment cannot ride inside a review", { skip: enabled ? false : reason }, async () => {
  const { ref, snapshot, file } = await liveFixture();
  // Pins a behaviour found the hard way: `subject_type: "file"` inside a review's `comments[]` fails
  // with `0.position (Expected value to not be null)`. `buildReviewPayload` refuses these up front,
  // and this is the evidence for why it has to.
  const result = await tryPendingReview(ref, {
    commit_id: snapshot.headSha,
    body: "prc live acceptance probe",
    comments: [{ path: file.path, body: "prc live acceptance probe: file level", subject_type: "file" }],
  });
  assert.notEqual(result.code, 0, "GitHub now accepts a file-level comment in a review; gh-submit.js can be relaxed");
});

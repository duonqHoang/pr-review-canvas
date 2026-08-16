import assert from "node:assert/strict";
import test from "node:test";
import { fetchPullRequest, PR_VIEW_FIELDS } from "../src/gh-fetch.js";

/**
 * Pull request context is fetched through one narrow `gh pr view` call. These tests pin both the
 * requested fields and their normalization because the review page otherwise fails much later,
 * after a valid GitHub response has already been persisted as an incomplete snapshot.
 */

const REF = { host: "github.com", owner: "o", repo: "r", number: 11 };

test("pull request metadata includes description, times and normalized commits", async () => {
  /** @type {string[]} */
  let args = [];
  const meta = await fetchPullRequest(/** @type {any} */ (REF), {
    ghJsonImpl: /** @type {any} */ (
      async (/** @type {string[]} */ nextArgs) => {
        args = nextArgs;
        return {
          number: 11,
          title: "Context",
          state: "MERGED",
          author: { login: "octo" },
          body: "## Intent",
          createdAt: "2026-08-01T10:00:00Z",
          updatedAt: "2026-08-02T10:00:00Z",
          mergedAt: "2026-08-03T10:00:00Z",
          commits: [
            {
              oid: "abcdef1234567890",
              messageHeadline: "feat: context",
              authoredDate: "2026-08-01T09:00:00Z",
              authors: [{ login: "octo", name: "Octo Cat" }],
            },
          ],
        };
      }
    ),
  });

  assert.equal(args.at(-1), PR_VIEW_FIELDS);
  for (const field of ["body", "createdAt", "updatedAt", "mergedAt", "commits"]) {
    assert.ok(PR_VIEW_FIELDS.split(",").includes(field), `${field} is not requested from GitHub`);
  }
  assert.equal(meta.body, "## Intent");
  assert.equal(meta.authorLogin, "octo");
  assert.deepEqual(meta.commits, [
    {
      oid: "abcdef1234567890",
      messageHeadline: "feat: context",
      authoredDate: "2026-08-01T09:00:00Z",
      authorLogin: "octo",
      authorName: "Octo Cat",
    },
  ]);
});

test("missing optional context becomes empty values rather than breaking old snapshots", async () => {
  const meta = await fetchPullRequest(/** @type {any} */ (REF), {
    ghJsonImpl: /** @type {any} */ (async () => ({})),
  });
  assert.equal(meta.body, "");
  assert.equal(meta.createdAt, "");
  assert.equal(meta.mergedAt, "");
  assert.deepEqual(meta.commits, []);
});

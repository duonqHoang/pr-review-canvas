import assert from "node:assert/strict";
import test from "node:test";
import { AxiError } from "../src/axi.js";
import { checkGhAuth, classifyGhError, gh, ghJson, ghRaw, resetGhAuthProbe } from "../src/gh.js";

/** @param {Partial<{ code: number, stdout: string, stderr: string }>} parts */
const result = (parts) => ({ code: 1, stdout: "", stderr: "", ...parts });

test("classifyGhError maps an auth failure to AUTH_ERROR", () => {
  const error = classifyGhError(["pr", "view"], result({ stderr: "gh auth login required" }));
  assert.equal(error.code, "AUTH_ERROR");
  assert.match(error.suggestions.join(" "), /gh auth login/);
});

test("classifyGhError separates rate limiting from a plain 403", () => {
  assert.equal(
    classifyGhError(["api", "x"], result({ stderr: "HTTP 403: API rate limit exceeded" })).code,
    "RATE_LIMITED",
  );
  assert.equal(classifyGhError(["api", "x"], result({ stderr: "HTTP 403: Forbidden" })).code, "FORBIDDEN");
});

test("classifyGhError maps 404 and 'could not resolve to' to NOT_FOUND", () => {
  assert.equal(classifyGhError(["api", "x"], result({ stderr: "HTTP 404: Not Found" })).code, "NOT_FOUND");
  assert.equal(
    classifyGhError(["api", "graphql"], result({ stderr: "Could not resolve to a PullRequest" })).code,
    "NOT_FOUND",
  );
  assert.equal(classifyGhError(["pr", "view"], result({ stderr: "no pull requests found" })).code, "NOT_FOUND");
});

test("classifyGhError maps 422 to VALIDATION_ERROR and keeps GitHub's own wording", () => {
  // This message is the difference between "submit failed" and "your comment on line 42 is
  // outside the diff", so it must survive into the error's suggestions verbatim.
  const stderr = "HTTP 422: Validation Failed (pull_request_review_thread.line must be part of the diff)";
  const error = classifyGhError(["api", "repos/o/r/pulls/1/reviews"], result({ stderr }));
  assert.equal(error.code, "VALIDATION_ERROR");
  assert.match(error.suggestions.join(" "), /must be part of the diff/);
});

test("classifyGhError falls back to SERVER_ERROR and names the command", () => {
  const error = classifyGhError(["pr", "diff", "9"], result({ code: 3, stderr: "" }));
  assert.equal(error.code, "SERVER_ERROR");
  assert.match(error.message, /gh pr diff 9/);
  assert.match(error.suggestions.join(" "), /exit code 3/);
});

// --- real subprocess behaviour ---------------------------------------------
// These run `gh` for real but only with read-only, side-effect-free arguments.

test("ghRaw reports a non-zero exit without throwing", async () => {
  const outcome = await ghRaw(["--this-flag-does-not-exist"]);
  assert.notEqual(outcome.code, 0);
  assert.equal(typeof outcome.stderr, "string");
});

test("gh throws a classified AxiError on a non-zero exit", async () => {
  await assert.rejects(
    () => gh(["--this-flag-does-not-exist"]),
    (error) => error instanceof AxiError,
  );
});

test("ghJson throws a readable error when stdout is not JSON", async () => {
  await assert.rejects(
    () => ghJson(["--version"]),
    (error) => error instanceof AxiError && /did not return JSON/.test(error.message),
  );
});

test("gh --version succeeds and identifies the tool", async () => {
  const stdout = await gh(["--version"]);
  assert.match(stdout, /gh version/);
});

test("checkGhAuth caches its probe until reset", async () => {
  resetGhAuthProbe();
  const first = await checkGhAuth();
  const second = await checkGhAuth();
  assert.equal(first, second, "the probe result should be the identical cached object");
  resetGhAuthProbe();
  const third = await checkGhAuth();
  assert.notEqual(first, third, "resetting should force a fresh probe");
});

test("a missing gh binary is reported as DEPENDENCY_ERROR", async () => {
  // Simulated by emptying PATH so exec cannot find `gh`, which is the ENOENT branch.
  await assert.rejects(
    () => ghRaw(["--version"], { env: { ...process.env, PATH: "/nonexistent" } }),
    (error) => error instanceof AxiError && error.code === "DEPENDENCY_ERROR",
  );
});

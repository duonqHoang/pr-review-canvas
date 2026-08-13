import { execFile } from "node:child_process";
import { AxiError } from "./axi.js";

/**
 * The one and only place this project spawns `gh`.
 *
 * Two invariants, both load-bearing:
 *
 * 1. **Never through a shell.** Always `execFile("gh", argv)`. Review comment bodies contain
 *    backticks, quotes, newlines and ```suggestion fences; putting any of that near a shell is
 *    a command-injection bug waiting to happen. Request bodies travel via `--input <file>`, so
 *    no user-authored text ever reaches argv either.
 * 2. **Always `--repo <owner>/<repo>` from the server.** The detached server has a different
 *    cwd than the agent, so `gh`'s cwd-based repo inference would silently target the wrong
 *    repository — or fail. Callers pass the repo explicitly; only PR *resolution* (which runs
 *    in the CLI, in the user's cwd) may rely on inference.
 */

const MAX_BUFFER = 64 * 1024 * 1024; // a 3000-file PR's `files` payload can be tens of MB

/**
 * @typedef {object} GhRunOptions
 * @property {string} [cwd]
 * @property {string} [input] written to stdin
 * @property {number} [timeoutMs]
 * @property {NodeJS.ProcessEnv} [env]
 */

/**
 * @typedef {object} GhResult
 * @property {number} code
 * @property {string} stdout
 * @property {string} stderr
 */

/**
 * Run `gh` and return its raw result without throwing on a non-zero exit. Callers that want the
 * error surfaced use {@link gh} instead.
 *
 * @param {string[]} args
 * @param {GhRunOptions} [options]
 * @returns {Promise<GhResult>}
 */
export function ghRaw(args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = execFile(
      "gh",
      args,
      {
        cwd: options.cwd,
        maxBuffer: MAX_BUFFER,
        timeout: options.timeoutMs ?? 60_000,
        env: options.env ?? process.env,
        // Belt and braces: `gh` should never open a pager or prompt when driven by a tool.
        windowsHide: true,
      },
      (error, stdout, stderr) => {
        if (error && /** @type {{ code?: unknown }} */ (error).code === "ENOENT") {
          reject(
            new AxiError("GitHub CLI (`gh`) is not installed or not on PATH", "DEPENDENCY_ERROR", [
              "Install it from https://cli.github.com",
              "Then run `gh auth login`",
            ]),
          );
          return;
        }
        if (error && /** @type {{ killed?: boolean }} */ (error).killed) {
          reject(new AxiError(`\`gh ${args[0] ?? ""}\` timed out`, "SERVER_ERROR", [String(stderr || "").trim()]));
          return;
        }
        const code = error ? Number(/** @type {{ code?: unknown }} */ (error).code ?? 1) : 0;
        resolve({ code, stdout: String(stdout ?? ""), stderr: String(stderr ?? "") });
      },
    );
    if (options.input !== undefined) {
      child.stdin?.end(options.input);
    }
  });
}

/**
 * Run `gh` and throw a classified {@link AxiError} on failure.
 *
 * @param {string[]} args
 * @param {GhRunOptions} [options]
 * @returns {Promise<string>} stdout
 */
export async function gh(args, options = {}) {
  const result = await ghRaw(args, options);
  if (result.code !== 0) throw classifyGhError(args, result);
  return result.stdout;
}

/**
 * Run `gh` and parse stdout as JSON.
 *
 * @template T
 * @param {string[]} args
 * @param {GhRunOptions} [options]
 * @returns {Promise<T>}
 */
export async function ghJson(args, options = {}) {
  const stdout = await gh(args, options);
  try {
    return /** @type {T} */ (JSON.parse(stdout));
  } catch {
    throw new AxiError(`\`gh ${args.join(" ")}\` did not return JSON`, "SERVER_ERROR", [
      stdout.slice(0, 200).trim() || "(empty output)",
    ]);
  }
}

/**
 * Turn a `gh` failure into something a human can act on. The message text matters: the GitHub
 * validation strings we key on here are the difference between "submit failed opaquely" and
 * "your comment on src/foo.js:42 is outside the diff".
 *
 * @param {string[]} args
 * @param {GhResult} result
 * @returns {AxiError}
 */
export function classifyGhError(args, result) {
  const stderr = result.stderr.trim();
  const stdout = result.stdout.trim();
  const text = `${stderr}\n${stdout}`;
  const command = `gh ${args.join(" ")}`;

  if (/gh auth login|authentication|HTTP 401/i.test(text)) {
    return new AxiError("GitHub CLI is not authenticated", "AUTH_ERROR", ["Run `gh auth login`", stderr]);
  }
  if (/HTTP 403/.test(text) && /rate limit/i.test(text)) {
    return new AxiError("GitHub API rate limit exceeded", "RATE_LIMITED", [
      "Wait for the limit to reset, then retry",
      stderr,
    ]);
  }
  if (/HTTP 403/.test(text)) {
    return new AxiError("GitHub refused the request (403)", "FORBIDDEN", [
      "Check that your token has the `repo` scope",
      stderr,
    ]);
  }
  if (/HTTP 404|could not resolve to|no pull requests found/i.test(text)) {
    return new AxiError("GitHub could not find that pull request or repository", "NOT_FOUND", [command, stderr]);
  }
  if (/HTTP 422/.test(text)) {
    // The useful part of a 422 is in **stdout**: `gh api` prints the response body there and only a
    // one-line summary to stderr. Reporting stderr alone produced "Unprocessable Entity (HTTP 422)"
    // and nothing else, which is undiagnosable — it cost a live debugging session to find that the
    // offending field was `subject_type`. GitHub's own wording is far better than anything this
    // function could infer, so it is passed through.
    return new AxiError("GitHub rejected the request as invalid (422)", "VALIDATION_ERROR", [
      command,
      ...describeGitHubErrors(stdout),
      stderr,
    ]);
  }
  return new AxiError(`\`${command}\` failed`, "SERVER_ERROR", [stderr || `exit code ${result.code}`]);
}

/**
 * Pull the readable parts out of a GitHub error response body.
 *
 * The shape is `{ message, errors: [...] }`, where an entry is either a string or an object with
 * `resource`/`field`/`code`/`message`. GitHub's review endpoint proxies to GraphQL internally and
 * returns strings there, which is how a rejected field ends up named in full:
 *
 *   Field is not defined on DraftPullRequestReviewThread
 *
 * That sentence is the entire difference between a fixable error and an opaque one, so it is
 * surfaced verbatim rather than summarised.
 *
 * @param {string} stdout
 * @returns {string[]}
 */
export function describeGitHubErrors(stdout) {
  const text = String(stdout ?? "").trim();
  if (!text) return [];
  /** @type {any} */
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    // Not JSON: still better to show it than to show nothing.
    return [text.slice(0, 500)];
  }
  /** @type {string[]} */
  const out = [];
  if (body?.message) out.push(String(body.message));
  for (const entry of Array.isArray(body?.errors) ? body.errors : []) {
    if (typeof entry === "string") {
      out.push(entry);
      continue;
    }
    const parts = [entry?.resource, entry?.field, entry?.code, entry?.message].filter(Boolean).map(String);
    if (parts.length) out.push(parts.join(" "));
  }
  return out.length ? out : [text.slice(0, 500)];
}

/**
 * Probe once whether `gh` exists and is authenticated. Cached per process because it is on the
 * hot path of every `open`.
 *
 * @type {Promise<{ ok: true } | { ok: false, error: AxiError }> | null}
 */
let authProbe = null;

/** @returns {Promise<{ ok: true } | { ok: false, error: AxiError }>} */
export function checkGhAuth() {
  if (!authProbe) {
    authProbe = (async () => {
      try {
        const result = await ghRaw(["auth", "status"], { timeoutMs: 15_000 });
        if (result.code === 0) return /** @type {const} */ ({ ok: true });
        return {
          ok: /** @type {false} */ (false),
          error: new AxiError("GitHub CLI is not authenticated", "AUTH_ERROR", [
            "Run `gh auth login`",
            result.stderr.trim(),
          ]),
        };
      } catch (error) {
        return { ok: /** @type {false} */ (false), error: /** @type {AxiError} */ (error) };
      }
    })();
  }
  return authProbe;
}

/** Test seam: drop the cached auth probe. */
export function resetGhAuthProbe() {
  authProbe = null;
}

export async function assertGhReady() {
  const probe = await checkGhAuth();
  if (!probe.ok) throw probe.error;
}

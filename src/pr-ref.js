import { createHash } from "node:crypto";
import { AxiError } from "./axi.js";
import { ghJson } from "./gh.js";

/**
 * Session identity.
 *
 * lavish keys a session by a canonical file path. There is no file here, so identity is the PR
 * itself. Two consequences worth stating up front:
 *
 * - The same PR reviewed from two different clones is **one** session. The review artifact
 *   belongs to the pull request, not to a checkout, so drafts follow the PR.
 * - The head SHA is deliberately **not** part of the identity. Including it would orphan every
 *   draft on every force-push, which is the opposite of what a 30-minute review needs.
 */

const DEFAULT_HOST = "github.com";

/**
 * @typedef {object} PrRef
 * @property {string} host lowercase, e.g. "github.com" or "ghe.example.com"
 * @property {string} owner as supplied (display casing preserved)
 * @property {string} repo as supplied (display casing preserved)
 * @property {number} number
 */

/** @param {string} value */
function isValidSegment(value) {
  // GitHub owners and repo names: letters, digits, dot, dash, underscore.
  return /^[A-Za-z0-9._-]+$/.test(value) && value !== "." && value !== "..";
}

/** @param {unknown} value */
function toPrNumber(value) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : null;
}

/**
 * Parse a reference that fully specifies owner, repo and number, with no `gh` call needed.
 *
 * Accepts:
 * - `https://github.com/o/r/pull/219` and any trailing path/query/hash (`/files`,
 *   `#discussion_r1`, `/commits/abc`)
 * - `github.com/o/r/pull/219` (scheme optional)
 * - `o/r#219`
 * - `o/r/219`
 * - `o/r/pull/219`
 *
 * @param {string} input
 * @returns {PrRef | null}
 */
export function parseExplicitPrRef(input) {
  const raw = String(input ?? "").trim();
  if (!raw) return null;

  const SEG = "[A-Za-z0-9._-]+";

  // The shorthands are matched against the raw string FIRST. Routing them through `new URL`
  // does not work: prefixing a scheme onto `o/r/219` yields host="o" and a two-segment path,
  // which is indistinguishable from a truncated URL.
  const shorthands = [
    new RegExp(`^(${SEG})/(${SEG})#(\\d+)$`), //           o/r#219
    new RegExp(`^(${SEG})/(${SEG})/(\\d+)$`), //           o/r/219
    new RegExp(`^(${SEG})/(${SEG})/pulls?/(\\d+)$`), //    o/r/pull/219
  ];
  for (const pattern of shorthands) {
    const match = pattern.exec(raw);
    if (!match) continue;
    const number = toPrNumber(match[3]);
    return number ? { host: DEFAULT_HOST, owner: match[1], repo: match[2], number } : null;
  }

  // Everything else must be a real URL with a host: `[scheme://]host/owner/repo/pull/N`,
  // with any trailing path, query or fragment ignored.
  const withScheme = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(raw) ? raw : `https://${raw}`;
  /** @type {URL} */
  let url;
  try {
    url = new URL(withScheme);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;

  const segments = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);
  if (segments.length < 4) return null;

  const [owner, repo, kind, numberSegment] = segments;
  if (!isValidSegment(owner) || !isValidSegment(repo)) return null;
  if (kind !== "pull" && kind !== "pulls") return null;

  const number = toPrNumber(numberSegment);
  if (!number) return null;
  return { host: url.hostname.toLowerCase(), owner, repo, number };
}

/**
 * Parse a bare PR number (`219` or `#219`). These need a repo from somewhere else.
 *
 * @param {string} input
 * @returns {number | null}
 */
export function parsePrNumber(input) {
  const raw = String(input ?? "").trim();
  const match = /^#?(\d+)$/.exec(raw);
  return match ? toPrNumber(match[1]) : null;
}

/**
 * Parse an `owner/repo` value as accepted by `--repo`.
 *
 * @param {string} input
 * @returns {{ host: string, owner: string, repo: string } | null}
 */
export function parseRepoFlag(input) {
  const raw = String(input ?? "").trim();
  if (!raw) return null;
  const short = /^([A-Za-z0-9._-]+)\/([A-Za-z0-9._-]+)$/.exec(raw);
  if (short) return { host: DEFAULT_HOST, owner: short[1], repo: short[2] };
  const long = /^([A-Za-z0-9._-]+\.[A-Za-z0-9._-]+)\/([A-Za-z0-9._-]+)\/([A-Za-z0-9._-]+)$/.exec(raw);
  if (long) return { host: long[1].toLowerCase(), owner: long[2], repo: long[3] };
  return null;
}

/**
 * The string that identifies a session. Lowercased throughout: GitHub treats hosts, owners and
 * repo names case-insensitively, so `Owner/Repo#1` and `owner/repo#1` must be one session.
 *
 * @param {PrRef} ref
 */
export function canonicalPrString(ref) {
  return `${ref.host.toLowerCase()}/${ref.owner.toLowerCase()}/${ref.repo.toLowerCase()}/pull/${ref.number}`;
}

/**
 * The 16-hex session key.
 *
 * Note this is a hash of **public** data, so unlike lavish's file-path key it is guessable. It
 * is an identifier, never a secret: the browser-facing URL uses a separate random `access_id`.
 *
 * @param {PrRef} ref
 */
export function sessionKey(ref) {
  return createHash("sha256").update(canonicalPrString(ref), "utf8").digest("hex").slice(0, 16);
}

/** The short form used in output and accepted as input. @param {PrRef} ref */
export function displayRef(ref) {
  return `${ref.owner}/${ref.repo}#${ref.number}`;
}

/** @param {PrRef} ref */
export function repoSlug(ref) {
  return `${ref.owner}/${ref.repo}`;
}

/** @param {PrRef} ref */
export function prWebUrl(ref) {
  return `https://${ref.host}/${ref.owner}/${ref.repo}/pull/${ref.number}`;
}

/**
 * Resolve whatever the user typed into a full {@link PrRef}.
 *
 * When the repo is not spelled out we ask `gh` and parse the `.url` it returns rather than
 * reading `git remote`. That is deliberate: for a PR opened from a fork, the remote points at
 * the fork while the pull request lives on the **base** repo, and only `gh` knows the difference.
 *
 * The `gh` seam is declared with the narrow shape this function actually needs rather than
 * `typeof ghJson`: a generic signature cannot be satisfied by a test double, and the only field
 * we read is `url`.
 *
 * @typedef {(args: string[], options?: { cwd?: string }) => Promise<{ url?: string, number?: number }>} PrViewFetcher
 *
 * @param {object} options
 * @param {string} [options.input] the positional argument, if any
 * @param {string} [options.repoFlag] `--repo owner/repo`
 * @param {string} [options.cwd] where to run `gh` for inference
 * @param {PrViewFetcher} [options.ghJsonImpl] test seam
 * @returns {Promise<{ ref: PrRef, resolvedBy: "explicit" | "repo-flag" | "cwd-number" | "cwd-branch" }>}
 */
export async function resolvePrRef({ input, repoFlag, cwd, ghJsonImpl = ghJson }) {
  const typed = String(input ?? "").trim();

  const explicit = typed ? parseExplicitPrRef(typed) : null;
  if (explicit) return { ref: explicit, resolvedBy: "explicit" };

  const number = typed ? parsePrNumber(typed) : null;
  if (typed && number === null) {
    throw new AxiError(`Could not read \`${typed}\` as a pull request`, "VALIDATION_ERROR", [
      "Pass a PR URL, `owner/repo#123`, or just `123` from inside the repository",
      "Or add `--repo owner/repo`",
    ]);
  }

  const repo = repoFlag ? parseRepoFlag(repoFlag) : null;
  if (repoFlag && !repo) {
    throw new AxiError(`Could not read \`${repoFlag}\` as a repository`, "VALIDATION_ERROR", [
      "Use `--repo owner/repo`",
    ]);
  }

  // `--repo owner/repo 219` needs no lookup at all.
  if (repo && number !== null) {
    return { ref: { ...repo, number }, resolvedBy: "repo-flag" };
  }

  /** @type {string[]} */
  const args = ["pr", "view"];
  if (number !== null) args.push(String(number));
  args.push("--json", "url,number");
  if (repo) args.push("--repo", `${repo.owner}/${repo.repo}`);

  /** @type {{ url?: string, number?: number }} */
  const view = await ghJsonImpl(args, { cwd });
  const resolved = parseExplicitPrRef(String(view.url ?? ""));
  if (!resolved) {
    throw new AxiError("Could not determine which pull request to review", "NOT_FOUND", [
      number === null
        ? "No pull request is associated with the current branch"
        : `\`gh pr view ${number}\` did not return a usable URL`,
      "Pass a PR URL or `owner/repo#123` explicitly",
    ]);
  }
  return { ref: resolved, resolvedBy: number === null ? "cwd-branch" : "cwd-number" };
}

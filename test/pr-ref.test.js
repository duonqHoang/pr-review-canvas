import assert from "node:assert/strict";
import test from "node:test";
import { AxiError } from "../src/axi.js";
import {
  canonicalPrString,
  displayRef,
  parseExplicitPrRef,
  parsePrNumber,
  parseRepoFlag,
  prWebUrl,
  repoSlug,
  resolvePrRef,
  sessionKey,
} from "../src/pr-ref.js";

const CANONICAL = "github.com/kunchenguid/lavish-axi/pull/219";

test("all explicit input forms parse to the same ref", () => {
  const forms = [
    "https://github.com/kunchenguid/lavish-axi/pull/219",
    "http://github.com/kunchenguid/lavish-axi/pull/219",
    "github.com/kunchenguid/lavish-axi/pull/219",
    "kunchenguid/lavish-axi#219",
    "kunchenguid/lavish-axi/219",
    "kunchenguid/lavish-axi/pull/219",
  ];
  for (const form of forms) {
    const ref = parseExplicitPrRef(form);
    assert.ok(ref, `expected ${form} to parse`);
    assert.equal(canonicalPrString(ref), CANONICAL, `for ${form}`);
  }
});

test("trailing path, query and fragment on a PR URL are ignored", () => {
  const forms = [
    "https://github.com/kunchenguid/lavish-axi/pull/219/files",
    "https://github.com/kunchenguid/lavish-axi/pull/219/files#diff-abc123R42",
    "https://github.com/kunchenguid/lavish-axi/pull/219#discussion_r3650079535",
    "https://github.com/kunchenguid/lavish-axi/pull/219/commits/90608665c6ab",
    "https://github.com/kunchenguid/lavish-axi/pull/219?w=1",
    "https://github.com/kunchenguid/lavish-axi/pull/219/files/90608665c6ab",
  ];
  for (const form of forms) {
    const ref = parseExplicitPrRef(form);
    assert.ok(ref, `expected ${form} to parse`);
    assert.equal(canonicalPrString(ref), CANONICAL, `for ${form}`);
  }
});

test("a GitHub Enterprise host is preserved and does not collide with github.com", () => {
  const ghe = parseExplicitPrRef("https://ghe.example.com/team/app/pull/7");
  const dotcom = parseExplicitPrRef("https://github.com/team/app/pull/7");
  assert.ok(ghe && dotcom);
  assert.equal(ghe.host, "ghe.example.com");
  assert.equal(dotcom.host, "github.com");
  assert.notEqual(sessionKey(ghe), sessionKey(dotcom));
});

test("owner, repo and host fold case for identity but keep their display casing", () => {
  const upper = parseExplicitPrRef("https://GitHub.com/KunChenGuid/Lavish-AXI/pull/219");
  const lower = parseExplicitPrRef("https://github.com/kunchenguid/lavish-axi/pull/219");
  assert.ok(upper && lower);
  // One session, whatever the user typed.
  assert.equal(canonicalPrString(upper), canonicalPrString(lower));
  assert.equal(sessionKey(upper), sessionKey(lower));
  // But output shows what they typed.
  assert.equal(displayRef(upper), "KunChenGuid/Lavish-AXI#219");
  assert.equal(repoSlug(upper), "KunChenGuid/Lavish-AXI");
});

test("the session key is a stable 16-hex digest of the canonical string", () => {
  const ref = parseExplicitPrRef("kunchenguid/lavish-axi#219");
  assert.ok(ref);
  const key = sessionKey(ref);
  assert.match(key, /^[0-9a-f]{16}$/);
  // Pinned so a later refactor cannot silently re-key every existing session on disk.
  assert.equal(
    key,
    sessionKey(/** @type {never} */ (parseExplicitPrRef(`https://github.com/${repoSlug(ref)}/pull/219`))),
  );
});

test("different PR numbers in the same repo are different sessions", () => {
  const a = parseExplicitPrRef("kunchenguid/lavish-axi#219");
  const b = parseExplicitPrRef("kunchenguid/lavish-axi#218");
  assert.ok(a && b);
  assert.notEqual(sessionKey(a), sessionKey(b));
});

test("parseExplicitPrRef rejects things that are not a PR reference", () => {
  const bad = [
    "",
    "   ",
    "219",
    "#219",
    "kunchenguid/lavish-axi",
    "kunchenguid/lavish-axi#0",
    "kunchenguid/lavish-axi#abc",
    "https://github.com/kunchenguid/lavish-axi",
    "https://github.com/kunchenguid/lavish-axi/issues/219",
    "https://github.com/kunchenguid/lavish-axi/pull/abc",
    "https://github.com/kunchenguid/lavish-axi/pull/0",
    "ftp://github.com/o/r/pull/1",
    "o/r/pull/",
  ];
  for (const form of bad) {
    assert.equal(parseExplicitPrRef(form), null, `expected ${JSON.stringify(form)} to be rejected`);
  }
});

test("parsePrNumber accepts a bare or hashed number only", () => {
  assert.equal(parsePrNumber("219"), 219);
  assert.equal(parsePrNumber("#219"), 219);
  assert.equal(parsePrNumber(" 219 "), 219);
  assert.equal(parsePrNumber("0"), null);
  assert.equal(parsePrNumber("-1"), null);
  assert.equal(parsePrNumber("21a"), null);
  assert.equal(parsePrNumber(""), null);
});

test("parseRepoFlag accepts owner/repo and host/owner/repo", () => {
  assert.deepEqual(parseRepoFlag("owner/repo"), { host: "github.com", owner: "owner", repo: "repo" });
  assert.deepEqual(parseRepoFlag("ghe.example.com/team/app"), {
    host: "ghe.example.com",
    owner: "team",
    repo: "app",
  });
  assert.equal(parseRepoFlag("owner"), null);
  assert.equal(parseRepoFlag("a/b/c/d"), null);
  assert.equal(parseRepoFlag(""), null);
});

test("prWebUrl round-trips through the parser", () => {
  const ref = parseExplicitPrRef("ghe.example.com/team/app/pull/7");
  assert.ok(ref);
  assert.equal(prWebUrl(ref), "https://ghe.example.com/team/app/pull/7");
  assert.equal(canonicalPrString(/** @type {never} */ (parseExplicitPrRef(prWebUrl(ref)))), canonicalPrString(ref));
});

// --- resolvePrRef -----------------------------------------------------------
// `gh` is injected, so these run offline and assert the exact argv we send.

test("resolvePrRef takes the explicit path without calling gh", async () => {
  const result = await resolvePrRef({
    input: "https://github.com/o/r/pull/5",
    ghJsonImpl: async () => {
      throw new Error("gh must not be called for an explicit ref");
    },
  });
  assert.equal(result.resolvedBy, "explicit");
  assert.equal(canonicalPrString(result.ref), "github.com/o/r/pull/5");
});

test("resolvePrRef combines --repo with a bare number without calling gh", async () => {
  const result = await resolvePrRef({
    input: "219",
    repoFlag: "owner/repo",
    ghJsonImpl: async () => {
      throw new Error("gh must not be called when --repo and a number are both given");
    },
  });
  assert.equal(result.resolvedBy, "repo-flag");
  assert.equal(canonicalPrString(result.ref), "github.com/owner/repo/pull/219");
});

test("resolvePrRef asks gh for a bare number and trusts the returned url", async () => {
  /** @type {string[][]} */
  const calls = [];
  const result = await resolvePrRef({
    input: "219",
    cwd: "/tmp/some/clone",
    ghJsonImpl: async (args, options) => {
      calls.push(args);
      assert.equal(options?.cwd, "/tmp/some/clone");
      return { url: "https://github.com/kunchenguid/lavish-axi/pull/219", number: 219 };
    },
  });
  assert.deepEqual(calls, [["pr", "view", "219", "--json", "url,number"]]);
  assert.equal(result.resolvedBy, "cwd-number");
  assert.equal(canonicalPrString(result.ref), CANONICAL);
});

test("resolvePrRef with no input resolves the current branch's PR", async () => {
  /** @type {string[][]} */
  const calls = [];
  const result = await resolvePrRef({
    ghJsonImpl: async (args) => {
      calls.push(args);
      return { url: "https://github.com/o/r/pull/42", number: 42 };
    },
  });
  assert.deepEqual(calls, [["pr", "view", "--json", "url,number"]]);
  assert.equal(result.resolvedBy, "cwd-branch");
  assert.equal(result.ref.number, 42);
});

test("a fork PR resolves to the base repository, not the fork", async () => {
  // This is the whole reason resolution goes through `gh pr view --json url` instead of
  // parsing `git remote`: the remote points at the fork, the PR lives on the base repo.
  const result = await resolvePrRef({
    input: "219",
    ghJsonImpl: async () => ({ url: "https://github.com/kunchenguid/lavish-axi/pull/219", number: 219 }),
  });
  assert.equal(repoSlug(result.ref), "kunchenguid/lavish-axi");
});

test("resolvePrRef rejects unparseable input before touching gh", async () => {
  await assert.rejects(
    () =>
      resolvePrRef({
        input: "not a pr",
        ghJsonImpl: async () => {
          throw new Error("gh must not be called");
        },
      }),
    (error) => error instanceof AxiError && error.code === "VALIDATION_ERROR",
  );
});

test("resolvePrRef rejects a malformed --repo", async () => {
  await assert.rejects(
    () => resolvePrRef({ input: "219", repoFlag: "not-a-repo", ghJsonImpl: async () => ({}) }),
    (error) => error instanceof AxiError && error.code === "VALIDATION_ERROR",
  );
});

test("resolvePrRef reports NOT_FOUND when gh returns no usable url", async () => {
  await assert.rejects(
    () => resolvePrRef({ ghJsonImpl: async () => ({}) }),
    (error) => error instanceof AxiError && error.code === "NOT_FOUND",
  );
});

test("resolvePrRef passes --repo through to gh when only the repo is known", async () => {
  /** @type {string[][]} */
  const calls = [];
  await resolvePrRef({
    repoFlag: "owner/repo",
    ghJsonImpl: async (args) => {
      calls.push(args);
      return { url: "https://github.com/owner/repo/pull/9", number: 9 };
    },
  });
  assert.deepEqual(calls, [["pr", "view", "--json", "url,number", "--repo", "owner/repo"]]);
});

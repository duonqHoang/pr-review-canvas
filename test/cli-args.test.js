import assert from "node:assert/strict";
import test from "node:test";
import {
  BIN,
  COMMAND_NAMES,
  createHomeOutput,
  createOpenOutput,
  createStopOutput,
  firstPositionalArg,
  flagValue,
  hasFlag,
  normalizeArgv,
  sessionUpsertPayload,
} from "../src/cli.js";

test("flagValue reads both --flag value and --flag=value", () => {
  assert.equal(flagValue(["--port", "5000"], "--port"), "5000");
  assert.equal(flagValue(["--port=5000"], "--port"), "5000");
  assert.equal(flagValue(["--verbose", "--port", "5000"], "--port"), "5000");
  assert.equal(flagValue([], "--port"), undefined);
  assert.equal(flagValue(["--other", "x"], "--port"), undefined);
});

test("firstPositionalArg skips flags and the values they consume", () => {
  assert.equal(firstPositionalArg(["219"]), "219");
  assert.equal(firstPositionalArg(["--verbose", "219"]), "219");
  assert.equal(firstPositionalArg(["--repo", "owner/repo", "219"], ["--repo"]), "219");
  // Without declaring --repo as a value flag, its value looks positional. This is why callers
  // must pass their value flags in.
  assert.equal(firstPositionalArg(["--repo", "owner/repo", "219"]), "owner/repo");
  assert.equal(firstPositionalArg(["--repo=owner/repo", "219"], ["--repo"]), "219");
  assert.equal(firstPositionalArg(["--", "--weird-name"]), "--weird-name");
  assert.equal(firstPositionalArg(["--verbose"]), undefined);
});

test("hasFlag is an exact token match", () => {
  assert.equal(hasFlag(["--verbose"], "--verbose"), true);
  assert.equal(hasFlag(["--verbose=1"], "--verbose"), false);
  assert.equal(hasFlag([], "--verbose"), false);
});

test("createHomeOutput documents every registered command", () => {
  // `open` is never typed by name — normalizeArgv inserts it — so the home view advertises it
  // the way a user actually invokes it. Everything else is documented under its own name.
  /** @type {Record<string, string>} */
  const displayedAs = {
    open: `${BIN} <pr>`,
    poll: `${BIN} poll <pr>`,
    answer: `${BIN} answer <pr> --thread <id>`,
    submit: `${BIN} submit <pr> --token <t>`,
    refresh: `${BIN} refresh <pr>`,
    end: `${BIN} end <pr>`,
  };
  /** @type {Set<string>} */
  const documentedElsewhere = new Set(["setup"]); // lives in TOP_LEVEL_HELP, not the status view

  const home = createHomeOutput();
  const documented = Object.keys(/** @type {Record<string, unknown>} */ (home.commands));
  for (const name of COMMAND_NAMES) {
    if (documentedElsewhere.has(name)) continue;
    const expected = displayedAs[name] ?? `${BIN} ${name}`;
    assert.ok(documented.includes(expected), `expected home output to document \`${expected}\``);
  }
});

test("normalizeArgv rewrites a bare PR reference into an explicit open", () => {
  // The SDK dispatches on argv[0], so without this `pr-review-canvas 219` is an unknown command.
  assert.deepEqual(normalizeArgv(["219"]), ["open", "219"]);
  assert.deepEqual(normalizeArgv(["https://github.com/o/r/pull/5"]), ["open", "https://github.com/o/r/pull/5"]);
  assert.deepEqual(normalizeArgv(["o/r#5", "--repo", "o/r"]), ["open", "o/r#5", "--repo", "o/r"]);
  // A leading flag with no ref is legitimate: resolve the current branch's PR.
  assert.deepEqual(normalizeArgv(["--repo", "o/r"]), ["open", "--repo", "o/r"]);
});

test("normalizeArgv leaves real commands, SDK built-ins and top-level flags alone", () => {
  for (const name of COMMAND_NAMES) {
    assert.deepEqual(normalizeArgv([name, "--port", "1"]), [name, "--port", "1"]);
  }
  // `update` is the SDK's own command; prepending open would break self-update.
  assert.deepEqual(normalizeArgv(["update"]), ["update"]);
  assert.deepEqual(normalizeArgv(["update", "--check"]), ["update", "--check"]);
  // These belong to the SDK's top-level handling, not to the open subcommand.
  assert.deepEqual(normalizeArgv(["--help"]), ["--help"]);
  assert.deepEqual(normalizeArgv(["--version"]), ["--version"]);
  assert.deepEqual(normalizeArgv(["-v"]), ["-v"]);
  assert.deepEqual(normalizeArgv(["-V"]), ["-V"]);
  assert.deepEqual(normalizeArgv([]), []);
});

test("createOpenOutput reports the ref, the key and the canonical identity", () => {
  const ref = { host: "github.com", owner: "KunChenGuid", repo: "lavish-axi", number: 219 };
  const output = createOpenOutput({ ref, resolvedBy: "explicit" });
  assert.deepEqual(output.session, {
    ref: "KunChenGuid/lavish-axi#219",
    // Independently verified: printf 'github.com/kunchenguid/lavish-axi/pull/219' | shasum -a 256
    key: "b47d587c3f8cf14e",
    canonical: "github.com/kunchenguid/lavish-axi/pull/219",
    resolved_by: "explicit",
  });
  assert.deepEqual(output.pr, {
    host: "github.com",
    owner: "KunChenGuid",
    repo: "lavish-axi",
    number: 219,
    url: "https://github.com/KunChenGuid/lavish-axi/pull/219",
  });
});

test("the session open POSTs carries the GitHub PR URL, not the canvas URL", () => {
  const ref = { host: "github.com", owner: "KunChenGuid", repo: "lavish-axi", number: 219 };
  const body = sessionUpsertPayload({ ref, key: "k", accessId: "a", headSha: "h", localRepo: "/cwd" });
  // "Open on GitHub" renders `session.pr.url`; if this ever becomes the local canvas URL again, the
  // toolbar link opens the canvas instead of the PR.
  assert.equal(body.url, "https://github.com/KunChenGuid/lavish-axi/pull/219");
  assert.equal(body.displayRef, "KunChenGuid/lavish-axi#219");
  assert.equal(body.reopen, true);
});

test("createStopOutput wraps the server report", () => {
  assert.deepEqual(createStopOutput({ status: "stopped", port: 4391 }), {
    server: { status: "stopped", port: 4391 },
  });
});

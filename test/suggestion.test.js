import assert from "node:assert/strict";
import test from "node:test";
import {
  applyEol,
  baseLinesFor,
  buildSuggestion,
  detectEol,
  effectiveBody,
  fenceFor,
  hashBaseLines,
  renderSuggestionBody,
  setSuggestionRange,
  stripCr,
  validateSuggestion,
} from "../src/anchor/suggestion.js";
import { parseFileEntry } from "../src/diff/parse-patch.js";

/**
 * Suggestions are the one feature here that **writes to the author's branch**. Every test below
 * exists because getting it wrong produces a commit the reviewer never intended, which is worse
 * than any error message.
 */

/** @param {string} patch @param {string} [filename] */
function file(patch, filename = "src/a.js") {
  return parseFileEntry(
    /** @type {any} */ ({
      filename,
      status: "modified",
      additions: 1,
      deletions: 1,
      changes: 2,
      patch,
      sha: "b10b",
    }),
  );
}

const simple = file(
  [
    "@@ -1,4 +1,5 @@",
    " const a = 1;",
    " const b = 2;",
    "-const c = 3;",
    "+const c = 33;",
    "+const d = 4;",
    " end;",
  ].join("\n"),
);

const crlf = file(
  ["@@ -1,3 +1,3 @@", " const a = 1;\r", "-const b = 2;\r", "+const b = 22;\r", " const c = 3;\r"].join("\n"),
);

const noEof = file(
  ["@@ -1,2 +1,2 @@", " first", "-second", "+second changed", "\\ No newline at end of file"].join("\n"),
);

const twoHunks = file(
  ["@@ -1,2 +1,2 @@", " keep 1", "-drop", "+add", "@@ -40,2 +40,2 @@", " far 1", "-far drop", "+far add"].join("\n"),
);

test("the fixtures parse cleanly, so everything below tests real diff geometry", () => {
  for (const [name, parsed] of Object.entries({ simple, crlf, noEof, twoHunks })) {
    assert.deepEqual(parsed.diagnostics, [], `${name}: ${JSON.stringify(parsed.diagnostics)}`);
    assert.equal(parsed.degraded, false, name);
  }
});

// ---- base lines ---------------------------------------------------------

test("base lines are the RIGHT-commentable lines of the range, deletions excluded", () => {
  const base = baseLinesFor(simple, 3, 4);
  assert.ok(base);
  assert.deepEqual(
    base.map((line) => line.text),
    ["const c = 33;", "const d = 4;"],
  );
  // Deletions live on LEFT and are not what a suggestion replaces.
  assert.ok(!base.some((line) => line.kind === "del"));
});

test("a range that leaves the diff has no base at all", () => {
  // Line 3 is in the first hunk, line 40 is in the second: the numbers in between are not in the
  // diff, so there is nothing for a suggestion to replace.
  assert.equal(baseLinesFor(twoHunks, 1, 40), null);
  assert.equal(baseLinesFor(simple, 4, 999), null);
});

// ---- line endings ------------------------------------------------------

test("CRLF is detected only when every base line ends in CR", () => {
  assert.equal(detectEol(["a\r", "b\r"]), "CRLF");
  // A mixed range stays LF: adding CR to lines that never had it is a change nobody asked for.
  assert.equal(detectEol(["a\r", "b"]), "LF");
  assert.equal(detectEol(["a", "b"]), "LF");
  assert.equal(detectEol([]), "LF");
});

test("stripping and re-applying CRLF round-trips byte-for-byte", () => {
  const original = ["const b = 22;\r", "next\r"];
  assert.deepEqual(applyEol(stripCr(original), "CRLF"), original);
  assert.deepEqual(stripCr(original), ["const b = 22;", "next"]);
  // Re-applying is idempotent, so a line that already ends in CR is not given a second one.
  assert.deepEqual(applyEol(original, "CRLF"), original);
});

test("a CRLF file gets CRLF back in the rendered suggestion", () => {
  const built = buildSuggestion({ file: crlf, side: "RIGHT", line: 2 });
  assert.ok(!("error" in built));
  assert.equal(built.suggestion.eol, "CRLF");
  // Stored without CR so the editor shows clean lines...
  assert.deepEqual(built.suggestion.replacementLines, ["const b = 22;"]);
  // ...and emitted with it, or GitHub's "Commit suggestion" reformats the whole file.
  const body = renderSuggestionBody("", built.suggestion);
  assert.equal(body, "```suggestion\nconst b = 22;\r\n```");
});

// ---- fences ------------------------------------------------------------

test("the fence is always longer than the longest backtick run inside it", () => {
  assert.equal(fenceFor("plain code"), "```");
  assert.equal(fenceFor("a `x` b"), "```");
  assert.equal(fenceFor("```js\nx\n```"), "````");
  assert.equal(fenceFor("`````"), "``````");
  assert.equal(fenceFor(""), "```");
});

test("a replacement containing a fence is still emitted unambiguously", () => {
  const suggestion = {
    baseLines: ["x"],
    baseHash: hashBaseLines(["x"]),
    replacementLines: ["```js", "const a = 1;", "```"],
    eol: /** @type {const} */ ("LF"),
  };
  const body = renderSuggestionBody("Use a fenced example:", suggestion);
  assert.equal(body, "Use a fenced example:\n\n````suggestion\n```js\nconst a = 1;\n```\n````");
});

// ---- the empty-fence distinction --------------------------------------

test("an empty replacement deletes the lines, and one empty line does not", () => {
  const base = ["const gone = 1;"];
  /** @param {string[]} replacementLines */
  const make = (replacementLines) => ({
    baseLines: base,
    baseHash: hashBaseLines(base),
    replacementLines,
    eol: /** @type {const} */ ("LF"),
  });
  // Empty fence: GitHub reads this as "remove these lines".
  assert.equal(renderSuggestionBody("", make([])), "```suggestion\n```");
  // One empty line: replace them with a blank line. A different edit, and the two must not collapse.
  assert.equal(renderSuggestionBody("", make([""])), "```suggestion\n\n```");
});

// ---- building ----------------------------------------------------------

test("a suggestion is refused on the original side, where the lines do not exist", () => {
  const built = buildSuggestion({ file: simple, side: "LEFT", line: 3 });
  assert.ok("error" in built);
  assert.equal(built.error, "suggestion-side-not-right");
  assert.match(built.message, /head branch/);
});

test("the default replacement is the current code, so the editor opens on what is there", () => {
  const built = buildSuggestion({ file: simple, side: "RIGHT", line: 4, startLine: 3 });
  assert.ok(!("error" in built));
  assert.deepEqual(built.suggestion.replacementLines, ["const c = 33;", "const d = 4;"]);
  assert.deepEqual(built.suggestion.baseLines, ["const c = 33;", "const d = 4;"]);
  assert.equal(built.suggestion.baseHash, hashBaseLines(["const c = 33;", "const d = 4;"]));
  assert.deepEqual(built.warnings, []);
});

test("a range spanning a hunk gap is refused with a message that names the range", () => {
  const built = buildSuggestion({ file: twoHunks, side: "RIGHT", line: 40, startLine: 1 });
  assert.ok("error" in built);
  assert.equal(built.error, "suggestion-base-not-in-diff");
  assert.match(built.message, /1-40/);
});

test("a missing newline at end of file is flagged rather than silently changed", () => {
  const built = buildSuggestion({ file: noEof, side: "RIGHT", line: 2 });
  assert.ok(!("error" in built));
  assert.equal(built.suggestion.noNewlineAtEof, true);
  assert.equal(built.warnings.length, 1);
  assert.match(built.warnings[0], /trailing newline/);
});

// ---- validation --------------------------------------------------------

test("a suggestion validates against the diff it was built from", () => {
  const built = buildSuggestion({ file: simple, side: "RIGHT", line: 4, startLine: 3 });
  assert.ok(!("error" in built));
  const anchor = /** @type {any} */ ({
    kind: "line",
    path: simple.path,
    side: "RIGHT",
    line: 4,
    startLine: 3,
    startSide: "RIGHT",
  });
  const result = validateSuggestion(anchor, built.suggestion, simple);
  assert.equal(result.ok, true);
});

test("drift in the replaced code blocks the suggestion instead of applying it blind", () => {
  const built = buildSuggestion({ file: simple, side: "RIGHT", line: 4, startLine: 3 });
  assert.ok(!("error" in built));
  // The author pushed: the same line numbers now hold different code.
  const moved = file(
    [
      "@@ -1,4 +1,5 @@",
      " const a = 1;",
      " const b = 2;",
      "-const c = 3;",
      "+const c = 999;",
      "+const d = 4;",
      " end;",
    ].join("\n"),
  );
  const anchor = /** @type {any} */ ({
    kind: "line",
    path: simple.path,
    side: "RIGHT",
    line: 4,
    startLine: 3,
    startSide: "RIGHT",
  });
  const result = validateSuggestion(anchor, built.suggestion, moved);
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.reason, "suggestion-base-drift");
  assert.match(result.message, /lines you have not seen/);
});

test("a suggestion is refused on a LEFT anchor and on a file anchor", () => {
  const built = buildSuggestion({ file: simple, side: "RIGHT", line: 4 });
  assert.ok(!("error" in built));
  const left = validateSuggestion(
    /** @type {any} */ ({ kind: "line", path: simple.path, side: "LEFT", line: 3 }),
    built.suggestion,
    simple,
  );
  assert.equal(left.ok, false);
  if (!left.ok) assert.equal(left.reason, "suggestion-side-not-right");

  const whole = validateSuggestion(/** @type {any} */ ({ kind: "file", path: simple.path }), built.suggestion, simple);
  assert.equal(whole.ok, false);
  if (!whole.ok) assert.equal(whole.reason, "suggestion-requires-line-anchor");
});

test("a mixed-side range is refused: start_side must equal side", () => {
  const built = buildSuggestion({ file: simple, side: "RIGHT", line: 4, startLine: 3 });
  assert.ok(!("error" in built));
  const result = validateSuggestion(
    /** @type {any} */ ({
      kind: "line",
      path: simple.path,
      side: "RIGHT",
      line: 4,
      startLine: 3,
      startSide: "LEFT",
    }),
    built.suggestion,
    simple,
  );
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.reason, "suggestion-side-not-right");
});

// ---- range moves are atomic -------------------------------------------

test("moving the range moves the anchor and the base hash together", () => {
  const moved = setSuggestionRange({
    file: simple,
    headSha: "head",
    line: 4,
    startLine: 3,
    replacementLines: ["const c = 4;"],
  });
  assert.ok(!("error" in moved));
  assert.equal(moved.anchor.line, 4);
  assert.equal(moved.anchor.startLine, 3);
  assert.equal(moved.anchor.startSide, "RIGHT");
  assert.equal(moved.suggestion.baseHash, hashBaseLines(["const c = 33;", "const d = 4;"]));
  assert.deepEqual(moved.suggestion.replacementLines, ["const c = 4;"]);

  // And the pair it produced validates, which is the property that matters: an anchor and a hash
  // describing different ranges is the state in which a suggestion edits the wrong lines.
  const check = validateSuggestion(moved.anchor, moved.suggestion, simple);
  assert.equal(check.ok, true);
});

test("a failed range move changes nothing, rather than half-applying", () => {
  const moved = setSuggestionRange({ file: twoHunks, headSha: "head", line: 40, startLine: 1 });
  assert.ok("error" in moved);
  assert.equal(moved.error, "suggestion-base-not-in-diff");
  assert.equal("anchor" in moved, false);
  assert.equal("suggestion" in moved, false);
});

// ---- the body that reaches GitHub -------------------------------------

test("effectiveBody is the single rendering path for what GitHub receives", () => {
  const built = buildSuggestion({ file: simple, side: "RIGHT", line: 4, startLine: 3 });
  assert.ok(!("error" in built));
  assert.equal(effectiveBody({ body: "plain comment" }), "plain comment");
  assert.equal(
    effectiveBody({ body: "swap these", suggestion: built.suggestion }),
    "swap these\n\n```suggestion\nconst c = 33;\nconst d = 4;\n```",
  );
  // No prose is fine: the patch says it.
  assert.equal(
    effectiveBody({ body: "   ", suggestion: built.suggestion }),
    "```suggestion\nconst c = 33;\nconst d = 4;\n```",
  );
});

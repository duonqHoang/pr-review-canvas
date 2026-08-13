import assert from "node:assert/strict";
import test from "node:test";
import { buildFingerprint, lineAt } from "../src/anchor/anchor.js";
import {
  canAutoAccept,
  describeDrift,
  DRIFT_CONFIDENCE,
  findFileForAnchor,
  reanchor,
  reanchorAll,
} from "../src/anchor/drift.js";
import { parseFileEntry } from "../src/diff/parse-patch.js";

/**
 * Drift tests.
 *
 * The property under test throughout is the one that makes the feature safe rather than clever:
 * a proposal is only ever produced when the *text* is accounted for. Every test that asserts a
 * non-match is therefore as important as the ones that assert a match — a false `moved` puts the
 * reviewer's comment on code they never read.
 */

/**
 * @param {Array<{ path: string, patch: string, previousPath?: string, sha?: string }>} entries
 * @param {string} [headSha]
 * @returns {import("../src/diff/model.js").ParsedDiff}
 */
function diffOf(entries, headSha = "head2") {
  const files = entries.map((entry) =>
    parseFileEntry({
      filename: entry.path,
      status: entry.previousPath ? "renamed" : "modified",
      previous_filename: entry.previousPath,
      additions: 1,
      deletions: 1,
      changes: 2,
      sha: entry.sha ?? "blob",
      patch: entry.patch,
    }),
  );
  return {
    host: "github.com",
    owner: "o",
    repo: "r",
    prNumber: 1,
    headSha,
    baseSha: "base",
    files,
    byPath: new Map(files.map((file) => [file.path, file])),
    fetchedAt: "t",
    source: "files-api",
    fileCountCapped: false,
  };
}

/**
 * Build an anchor the way the app does — from a real parsed line — so the fingerprint under test is
 * the fingerprint production would have stored.
 *
 * @param {import("../src/diff/model.js").ParsedDiff} diff
 * @param {string} path
 * @param {import("../src/diff/model.js").Side} side
 * @param {number} line
 * @param {number} [startLine]
 * @returns {import("../src/anchor/anchor.js").LineAnchor}
 */
function anchorAt(diff, path, side, line, startLine) {
  const file = diff.byPath.get(path);
  assert.ok(file, `fixture must contain ${path}`);
  const endLine = lineAt(file, side, line);
  assert.ok(endLine, `line ${line} must be commentable on ${side}`);
  const start = startLine === undefined ? undefined : lineAt(file, side, startLine);
  /** @type {import("../src/anchor/anchor.js").LineAnchor} */
  const anchor = {
    kind: "line",
    path,
    side,
    line,
    fingerprint: buildFingerprint({ file, endLine, startLine: start ?? undefined, headSha: diff.headSha }),
  };
  if (startLine !== undefined) {
    anchor.startLine = startLine;
    anchor.startSide = side;
  }
  return anchor;
}

const BEFORE = [
  "@@ -10,6 +10,7 @@ function retry(fn, opts) {",
  "   let delay = base;",
  "   const jitter = random();",
  "+  log(delay);",
  "   delay = delay * jitter;",
  "   return delay;",
  " }",
  " ",
].join("\n");

test("an untouched line is unchanged, and unchanged auto-accepts", () => {
  const before = diffOf([{ path: "src/retry.ts", patch: BEFORE }], "head1");
  const anchor = anchorAt(before, "src/retry.ts", "RIGHT", 12);
  const result = reanchor(anchor, diffOf([{ path: "src/retry.ts", patch: BEFORE }]));

  assert.equal(result.status, "unchanged");
  assert.equal(result.confidence, 1);
  assert.equal(result.how, "same-line-same-text");
  assert.equal(canAutoAccept(result), true);
  // Even the untouched case rebuilds the fingerprint, so the new headSha is recorded and the next
  // push does not re-report the same line as drifted.
  assert.equal(result.proposedAnchor?.kind === "line" && result.proposedAnchor.fingerprint.headSha, "head2");
});

test("a line that keeps its number but changes its text is NOT a match", () => {
  // The single most important negative in this file. GitHub would happily accept the comment, and
  // it would sit on code the reviewer never saw.
  const before = diffOf([{ path: "src/retry.ts", patch: BEFORE }], "head1");
  const anchor = anchorAt(before, "src/retry.ts", "RIGHT", 12);

  const rewritten = BEFORE.replace("+  log(delay);", "+  metrics.record(delay);");
  const result = reanchor(anchor, diffOf([{ path: "src/retry.ts", patch: rewritten }]));

  assert.equal(result.status, "orphaned");
  assert.equal(result.proposedAnchor, undefined);
  // The old hunk header travels with the orphan so the UI can still show where it used to live.
  assert.match(String(result.detail), /^@@ -10,6 \+10,7 @@/);
});

test("a line pushed down by an insertion above is found by its text", () => {
  const before = diffOf([{ path: "src/retry.ts", patch: BEFORE }], "head1");
  const anchor = anchorAt(before, "src/retry.ts", "RIGHT", 12);

  const shifted = [
    "@@ -10,6 +10,9 @@ function retry(fn, opts) {",
    "   let delay = base;",
    "   const jitter = random();",
    "+  assertFinite(base);",
    "+  assertFinite(jitter);",
    "+  log(delay);",
    "   delay = delay * jitter;",
    "   return delay;",
    " }",
    " ",
  ].join("\n");
  const result = reanchor(anchor, diffOf([{ path: "src/retry.ts", patch: shifted }]));

  assert.equal(result.status, "moved");
  assert.equal(result.confidence, DRIFT_CONFIDENCE.uniqueText);
  assert.equal(result.proposedAnchor?.kind === "line" && result.proposedAnchor.line, 14);
  // A move is an inference, so it never auto-accepts however clean the match looks.
  assert.equal(canAutoAccept(result), false);
});

test("two identical lines with different neighbours resolve by context hash", () => {
  const twice = [
    "@@ -1,4 +1,6 @@",
    " function a() {",
    "+  log(delay);",
    " }",
    " function b() {",
    "+  log(delay);",
    " }",
  ].join("\n");
  const before = diffOf([{ path: "d.ts", patch: twice }], "head1");
  // Anchor the SECOND occurrence, inside function b.
  const anchor = anchorAt(before, "d.ts", "RIGHT", 5);
  assert.equal(anchor.fingerprint.rawText, "  log(delay);");

  const shifted = [
    "@@ -1,4 +1,7 @@",
    "+// header",
    " function a() {",
    "+  log(delay);",
    " }",
    " function b() {",
    "+  log(delay);",
    " }",
  ].join("\n");
  const result = reanchor(anchor, diffOf([{ path: "d.ts", patch: shifted }]));

  assert.equal(result.status, "moved");
  assert.equal(result.confidence, DRIFT_CONFIDENCE.scored);
  assert.equal(result.how, "unique-text-scored");
  // 6, not 3: the neighbours pin it to function b.
  assert.equal(result.proposedAnchor?.kind === "line" && result.proposedAnchor.line, 6);
});

test("identical lines with identical neighbours are ambiguous, never guessed", () => {
  const symmetric = ["@@ -1,6 +1,8 @@", " {", "+  log(delay);", " }", " {", "+  log(delay);", " }", " {", " }"].join(
    "\n",
  );
  const before = diffOf([{ path: "d.ts", patch: symmetric }], "head1");
  const anchor = anchorAt(before, "d.ts", "RIGHT", 2);

  const shifted = [
    "@@ -1,6 +1,9 @@",
    "+// header",
    " {",
    "+  log(delay);",
    " }",
    " {",
    "+  log(delay);",
    " }",
    " {",
    " }",
  ].join("\n");
  const result = reanchor(anchor, diffOf([{ path: "d.ts", patch: shifted }]));

  assert.equal(result.status, "ambiguous");
  assert.equal(result.proposedAnchor, undefined);
  assert.ok((result.candidates?.length ?? 0) >= 2);
  assert.ok((result.candidates?.length ?? 0) <= 3, "at most three candidates reach the UI");
  for (const candidate of result.candidates ?? []) assert.equal(candidate.text, "  log(delay);");
});

test("a reindented line matches only at the trimmed confidence", () => {
  const before = diffOf([{ path: "d.ts", patch: BEFORE }], "head1");
  const anchor = anchorAt(before, "d.ts", "RIGHT", 12);

  const reindented = BEFORE.replace("+  log(delay);", "+      log(delay);");
  const result = reanchor(anchor, diffOf([{ path: "d.ts", patch: reindented }]));

  assert.equal(result.status, "moved");
  assert.equal(result.confidence, DRIFT_CONFIDENCE.trimmed);
  assert.equal(result.how, "trimmed-text");
  assert.equal(result.proposedAnchor?.kind === "line" && result.proposedAnchor.line, 12);
});

test("a range shifted down as a unit keeps its length", () => {
  const block = ["@@ -1,2 +1,5 @@", " head", "+alpha", "+beta", "+gamma", " tail"].join("\n");
  const before = diffOf([{ path: "d.ts", patch: block }], "head1");
  const anchor = anchorAt(before, "d.ts", "RIGHT", 4, 2);
  assert.equal(anchor.fingerprint.blockLines, 3);

  const shifted = ["@@ -1,2 +1,6 @@", "+prelude", " head", "+alpha", "+beta", "+gamma", " tail"].join("\n");
  const result = reanchor(anchor, diffOf([{ path: "d.ts", patch: shifted }]));

  assert.equal(result.status, "moved");
  // The end line was unique, so the range came from step 3 with its start derived by length and then
  // confirmed by the block hash — no confidence penalty, and no trip through step 6.
  assert.equal(result.how, "unique-text");
  assert.equal(result.detail, undefined);
  assert.equal(result.proposedAnchor?.kind === "line" && result.proposedAnchor.line, 5);
  assert.equal(result.proposedAnchor?.kind === "line" && result.proposedAnchor.startLine, 3);
  // The rebuilt fingerprint covers the same three lines in their new home.
  assert.equal(result.proposedAnchor?.kind === "line" && result.proposedAnchor.fingerprint.blockLines, 3);
});

test("a range whose end line is ambiguous is resolved by its whole body", () => {
  // The case block matching exists for. The last line (`log`) occurs four times, and two of those
  // occurrences have byte-identical context windows, so scoring cannot separate them. The range's
  // body reaches further back than a three-line context window does, and only one window carries
  // `UNIQ`.
  /** @param {string} header @param {boolean} shifted */
  const periodic = (header, shifted) =>
    [
      header,
      ...(shifted ? ["+shift"] : []),
      "+UNIQ",
      "+a",
      "+log",
      " y",
      "+a",
      "+log",
      " y",
      "+a",
      "+log",
      " y",
      "+a",
      "+log",
      " y",
    ].join("\n");

  const before = diffOf([{ path: "d.ts", patch: periodic("@@ -1,4 +1,13 @@", false) }], "head1");
  const anchor = anchorAt(before, "d.ts", "RIGHT", 6, 1);
  assert.equal(anchor.fingerprint.rawText, "log");
  assert.equal(anchor.fingerprint.blockLines, 6);

  const after = diffOf([{ path: "d.ts", patch: periodic("@@ -1,4 +1,14 @@", true) }]);

  // Establish that the end line really is undecidable on its own before asserting the rescue.
  // Without this the test would keep passing for the wrong reason if scoring ever changed.
  const endAlone = reanchor(
    {
      ...anchor,
      startLine: undefined,
      startSide: undefined,
      fingerprint: { ...anchor.fingerprint, blockHash: undefined, blockLines: undefined },
    },
    after,
  );
  assert.equal(endAlone.status, "ambiguous");

  const result = reanchor(anchor, after);
  assert.equal(result.status, "moved");
  assert.equal(result.how, "block-hash");
  assert.equal(result.confidence, DRIFT_CONFIDENCE.block);
  assert.equal(result.proposedAnchor?.kind === "line" && result.proposedAnchor.startLine, 2);
  assert.equal(result.proposedAnchor?.kind === "line" && result.proposedAnchor.line, 7);
});

test("a range whose length survives but whose body changed is proposed at reduced confidence", () => {
  const block = ["@@ -1,2 +1,5 @@", " head", "+alpha", "+beta", "+gamma", " tail"].join("\n");
  const before = diffOf([{ path: "d.ts", patch: block }], "head1");
  const anchor = anchorAt(before, "d.ts", "RIGHT", 4, 2);

  const edited = block.replace("+beta", "+BETA");
  const result = reanchor(anchor, diffOf([{ path: "d.ts", patch: edited }]));

  // Same path, same numbers — and still NOT `unchanged`, because `unchanged` is auto-acceptable and
  // the lines inside the range are not the ones the reviewer read.
  assert.equal(result.status, "moved");
  assert.equal(result.confidence, DRIFT_CONFIDENCE.trimmed);
  assert.equal(result.detail, "range-length-preserved-but-body-changed");
  assert.equal(canAutoAccept(result), false);
  assert.equal(result.proposedAnchor?.kind === "line" && result.proposedAnchor.startLine, 2);
});

test("a renamed file rewrites the path and stays auto-acceptable", () => {
  const before = diffOf([{ path: "src/old.ts", patch: BEFORE }], "head1");
  const anchor = anchorAt(before, "src/old.ts", "RIGHT", 12);

  const renamed = diffOf([{ path: "src/new.ts", patch: BEFORE, previousPath: "src/old.ts" }]);
  const result = reanchor(anchor, renamed);

  assert.equal(result.status, "moved");
  assert.equal(result.pathRewritten, true);
  assert.equal(result.confidence, 1);
  assert.equal(result.proposedAnchor?.path, "src/new.ts");
  // A pure rename is the one inferred move that is certain, so the user is not asked about it.
  assert.equal(canAutoAccept(result), true);
  // Unless a suggestion rides along: those re-point an edit, so they always need a human.
  assert.equal(canAutoAccept(result, { hasSuggestion: true }), false);
});

test("a file dropped from the PR is reported as file-gone, not orphaned", () => {
  const before = diffOf([{ path: "src/retry.ts", patch: BEFORE }], "head1");
  const anchor = anchorAt(before, "src/retry.ts", "RIGHT", 12);
  const result = reanchor(anchor, diffOf([{ path: "other.ts", patch: BEFORE }]));

  assert.equal(result.status, "file-gone");
  assert.equal(result.detail, "src/retry.ts");
  assert.match(describeDrift(result), /no longer part of this PR/);
});

test("a file whose patch stopped parsing certifies nothing", () => {
  const before = diffOf([{ path: "src/retry.ts", patch: BEFORE }], "head1");
  const anchor = anchorAt(before, "src/retry.ts", "RIGHT", 12);

  // Counts that do not reconcile with the body: the parser marks the file degraded, and drift must
  // fail closed rather than trust a half-understood patch.
  const broken = diffOf([{ path: "src/retry.ts", patch: "@@ -10,99 +10,99 @@\n   let delay = base;" }]);
  assert.equal(broken.byPath.get("src/retry.ts")?.degraded, true);

  const result = reanchor(anchor, broken);
  assert.equal(result.status, "file-degraded");
  assert.equal(result.proposedAnchor, undefined);
});

test("a deletion re-anchors on LEFT by its old number", () => {
  const patch = ["@@ -5,4 +5,3 @@", " keep", "-gone", " also", " tail"].join("\n");
  const before = diffOf([{ path: "d.ts", patch }], "head1");
  const anchor = anchorAt(before, "d.ts", "LEFT", 6);
  assert.equal(anchor.fingerprint.rawText, "gone");

  const shifted = ["@@ -5,5 +5,4 @@", " keep", " extra", "-gone", " also", " tail"].join("\n");
  const result = reanchor(anchor, diffOf([{ path: "d.ts", patch: shifted }]));

  assert.equal(result.status, "moved");
  assert.equal(result.proposedAnchor?.kind === "line" && result.proposedAnchor.side, "LEFT");
  assert.equal(result.proposedAnchor?.kind === "line" && result.proposedAnchor.line, 7);
});

test("a text anchor keeps its quote when the line survives, and degrades openly when it does not", () => {
  const before = diffOf([{ path: "d.ts", patch: BEFORE }], "head1");
  const file = before.byPath.get("d.ts");
  assert.ok(file);
  const endLine = lineAt(file, "RIGHT", 12);
  assert.ok(endLine);

  /** @type {import("../src/anchor/anchor.js").TextAnchor} */
  const anchor = {
    kind: "text",
    path: "d.ts",
    side: "RIGHT",
    line: 12,
    startOffset: 2,
    endOffset: 5,
    quote: "log",
    prefix: "  ",
    suffix: "(delay);",
    fingerprint: buildFingerprint({ file, endLine, headSha: "head1" }),
  };

  const shifted = BEFORE.replace("   let delay = base;", "   let delay = base;\n+  assertFinite(base);");
  const moved = reanchor(anchor, diffOf([{ path: "d.ts", patch: shifted.replace("-10,6 +10,7", "-10,6 +10,8") }]));
  assert.equal(moved.status, "moved");
  assert.equal(moved.proposedAnchor?.kind, "text");
  assert.equal(moved.proposedAnchor?.kind === "text" && moved.proposedAnchor.line, 13);
  assert.equal(moved.proposedAnchor?.kind === "text" && moved.proposedAnchor.quote, "log");

  // Now keep the line's identity by its trimmed text but remove the quoted substring from it.
  const requoted = BEFORE.replace("+  log(delay);", "+      report(delay);");
  const degraded = reanchor(
    { ...anchor, quote: "log", prefix: "", suffix: "" },
    diffOf([{ path: "d.ts", patch: requoted }]),
  );
  assert.equal(degraded.status, "orphaned", "a different word on the line is a different line");
});

test("reanchorAll keys results by the caller's ids", () => {
  const before = diffOf([{ path: "d.ts", patch: BEFORE }], "head1");
  const after = diffOf([{ path: "d.ts", patch: BEFORE }]);
  const results = reanchorAll(
    [
      { id: "c_1", anchor: anchorAt(before, "d.ts", "RIGHT", 12) },
      { id: "c_2", anchor: { kind: "file", path: "nope.ts" } },
    ],
    after,
  );
  assert.deepEqual(Object.keys(results).sort(), ["c_1", "c_2"]);
  assert.equal(results.c_1.status, "unchanged");
  assert.equal(results.c_2.status, "file-gone");
});

test("findFileForAnchor follows a rename in both directions", () => {
  const renamed = diffOf([{ path: "new.ts", patch: BEFORE, previousPath: "old.ts" }]);
  assert.equal(findFileForAnchor("new.ts", renamed)?.renamed, false);
  assert.equal(findFileForAnchor("old.ts", renamed)?.renamed, true);
  assert.equal(findFileForAnchor("other.ts", renamed), null);
});

test("a file anchor needs only the file to exist", () => {
  const after = diffOf([{ path: "d.ts", patch: BEFORE }]);
  assert.equal(reanchor({ kind: "file", path: "d.ts" }, after).status, "unchanged");
  assert.equal(reanchor({ kind: "file", path: "gone.ts" }, after).status, "file-gone");
});

test("every drift status has a human description", () => {
  /** @type {import("../src/anchor/drift.js").DriftStatus[]} */
  const statuses = ["unchanged", "moved", "ambiguous", "orphaned", "file-gone", "file-degraded"];
  for (const status of statuses) {
    const text = describeDrift({ status, confidence: 0.9, how: "x", candidates: [] });
    assert.equal(typeof text, "string");
    assert.ok(text.length > 0, `${status} must describe itself`);
  }
});

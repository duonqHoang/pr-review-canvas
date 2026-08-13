import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { fileAnchorHash, fileAnchorId } from "../src/anchor/file-anchor.js";
import {
  blobLinkFor,
  blobPermalink,
  encodePathForUrl,
  filesViewPermalink,
  lineSuffix,
  repoWebUrl,
} from "../src/shared/permalink.js";

const ref = { host: "github.com", owner: "cli", repo: "cli" };

test("the file anchor hash matches the digests verified against shasum", () => {
  // Values checked independently at a shell prompt with `printf … | shasum -a 256`, not derived
  // from this implementation — otherwise the test only proves the code agrees with itself.
  assert.equal(fileAnchorHash("AGENTS.md"), "a54ff182c7e8acf56acfd6e4b9c3ff41e2c41a31c9b211b2deb9df75d9a478f9");
  assert.equal(fileAnchorHash("dir/ünïcode.md"), "19f17d1eb6b3c493d57d13596bff1ccf4689d8cecd68b936e064d7d74bff3ccf");
  assert.equal(fileAnchorHash(""), "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
  assert.equal(fileAnchorId("AGENTS.md"), `diff-${fileAnchorHash("AGENTS.md")}`);
});

test("the hash is over the path with NO trailing newline", () => {
  // The negative half, and the reason it is here: `echo 'AGENTS.md' | shasum -a 256` is what anyone
  // reaches for at a prompt, and it appends a newline. Asserting the wrong digest is *not* produced
  // means that mistake cannot come back without failing a test.
  const withNewline = createHash("sha256").update("AGENTS.md\n", "utf8").digest("hex");
  assert.equal(withNewline, "954ec5dad7eaf581ad4bfa090369b244ac0120b43722ef2efff5ba89fc52046f");
  assert.notEqual(fileAnchorHash("AGENTS.md"), withNewline);
});

test("the anchor hash is over raw bytes while the URL carries the encoded path", () => {
  // The asymmetry that breaks links for paths with spaces. Both halves of one URL, asserted
  // together so neither can be "fixed" into agreement with the other.
  const path = "src/some dir/ünïcode.md";
  const url = filesViewPermalink({ ref, number: 9000, sha: "4b8c3ae", anchorId: fileAnchorId(path) });
  assert.ok(url.includes(fileAnchorHash(path)), "the fragment must use the raw-path hash");
  assert.notEqual(fileAnchorHash(path), fileAnchorHash(encodePathForUrl(path)));
});

test("encodePathForUrl preserves separators and encodes segments", () => {
  assert.equal(encodePathForUrl("src/a b/ünï.md"), "src/a%20b/%C3%BCn%C3%AF.md");
  assert.equal(encodePathForUrl("plain.md"), "plain.md");
  // A `#` or `?` inside a filename would otherwise truncate the URL.
  assert.equal(encodePathForUrl("weird/na#me?.md"), "weird/na%23me%3F.md");
});

test("blob links carry only #L and collapse a one-line range", () => {
  assert.equal(repoWebUrl(ref), "https://github.com/cli/cli");
  assert.equal(
    blobPermalink({ ref, sha: "abc", path: "a.md", line: 5 }),
    "https://github.com/cli/cli/blob/abc/a.md#L5",
  );
  assert.equal(blobPermalink({ ref, sha: "abc", path: "a.md", line: 9, startLine: 5 }).endsWith("#L5-L9"), true);
  // Same start and end is one line, not a degenerate range.
  assert.equal(blobPermalink({ ref, sha: "abc", path: "a.md", line: 5, startLine: 5 }).endsWith("#L5"), true);
  // Reversed input still produces an ascending range.
  assert.equal(blobPermalink({ ref, sha: "abc", path: "a.md", line: 5, startLine: 9 }).endsWith("#L5-L9"), true);
  assert.equal(blobPermalink({ ref, sha: "abc", path: "a.md" }), "https://github.com/cli/cli/blob/abc/a.md");
});

test("a LEFT blob link changes both the SHA and the path", () => {
  // The one place `previousPath` is correct: the base revision predates the rename. Changing only
  // one of the two produces a 404 that reads like a permissions error.
  const file = { path: "new/name.md", previousPath: "old/name.md" };
  const left = blobLinkFor({ ref, headSha: "head", baseSha: "base", file, side: "LEFT", line: 17 });
  assert.equal(left, "https://github.com/cli/cli/blob/base/old/name.md#L17");
  const right = blobLinkFor({ ref, headSha: "head", baseSha: "base", file, side: "RIGHT", line: 42 });
  assert.equal(right, "https://github.com/cli/cli/blob/head/new/name.md#L42");
});

test("a LEFT blob link for a file that was not renamed keeps its path", () => {
  const file = { path: "same.md", previousPath: null };
  const left = blobLinkFor({ ref, headSha: "head", baseSha: "base", file, side: "LEFT", line: 3 });
  assert.equal(left, "https://github.com/cli/cli/blob/base/same.md#L3");
});

test("lineSuffix marks the side and collapses a one-line range", () => {
  assert.equal(lineSuffix("RIGHT", 42), "R42");
  assert.equal(lineSuffix("LEFT", 17), "L17");
  assert.equal(lineSuffix("RIGHT", 50, 42), "R42-R50");
  assert.equal(lineSuffix("LEFT", 20, 20), "L20");
  assert.equal(lineSuffix("RIGHT", 42, 50), "R42-R50");
});

test("the files-view link pins the SHA in the path", () => {
  // `/files` without a SHA drifts as the branch moves, which defeats the point of a permalink.
  const anchorId = fileAnchorId("AGENTS.md");
  assert.equal(
    filesViewPermalink({ ref, number: 9000, sha: "4b8c3ae", anchorId, side: "RIGHT", line: 50, startLine: 42 }),
    `https://github.com/cli/cli/pull/9000/files/4b8c3ae#${anchorId}R42-R50`,
  );
  // Without a line it addresses the file as a whole.
  assert.equal(
    filesViewPermalink({ ref, number: 9000, sha: "4b8c3ae", anchorId }),
    `https://github.com/cli/cli/pull/9000/files/4b8c3ae#${anchorId}`,
  );
  // A side with no line is not a location either.
  assert.equal(
    filesViewPermalink({ ref, number: 1, sha: "s", anchorId, side: "RIGHT" }),
    `https://github.com/cli/cli/pull/1/files/s#${anchorId}`,
  );
});

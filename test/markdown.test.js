import assert from "node:assert/strict";
import test from "node:test";
import { parseInline, parseMarkdown, renderMarkdown, safeHref } from "../src/shared/markdown.js";

/**
 * Markdown for comment bodies.
 *
 * The security half of this file asserts on the **parse tree**, not on rendered output, and that is
 * the point of the design being tested: there is no node type that can carry raw HTML, so a
 * `<script>` in a comment body is not filtered out — it is un-representable. Asserting that every
 * node in a tree is one of a closed set of types is a much stronger statement than checking that some
 * output string happens not to contain a tag.
 */

/** Every node type the renderer knows how to build. Anything else must never be produced. */
const BLOCK_TYPES = new Set(["paragraph", "heading", "codeblock", "list", "quote", "rule"]);
const INLINE_TYPES = new Set(["text", "code", "strong", "em", "link", "jump", "break"]);

/**
 * Walk a tree, asserting every node is of a known type, and collect the hrefs.
 *
 * @param {any[]} blocks
 * @returns {{ hrefs: string[], text: string }}
 */
function audit(blocks) {
  /** @type {string[]} */
  const hrefs = [];
  let text = "";
  /** @param {any[]} inlines */
  const walkInline = (inlines) => {
    for (const inline of inlines) {
      assert.ok(INLINE_TYPES.has(inline.type), `unknown inline type: ${inline.type}`);
      if (inline.type === "link") {
        hrefs.push(inline.href);
        walkInline(inline.children);
      } else if (inline.type === "strong" || inline.type === "em") {
        walkInline(inline.children);
      } else if (inline.type === "text" || inline.type === "code") {
        text += inline.value;
      } else if (inline.type === "jump") {
        text += inline.label;
      }
    }
  };
  /** @param {any[]} list */
  const walk = (list) => {
    for (const block of list) {
      assert.ok(BLOCK_TYPES.has(block.type), `unknown block type: ${block.type}`);
      if (block.type === "quote") walk(block.children);
      else if (block.type === "list") for (const item of block.items) walkInline(item);
      else if (block.type === "codeblock") text += block.value;
      else if (block.children) walkInline(block.children);
    }
  };
  walk(blocks);
  return { hrefs, text };
}

// ---------------------------------------------------------------------------
// The XSS corpus
// ---------------------------------------------------------------------------

const HOSTILE = [
  `<script>alert(1)</script>`,
  `<img src=x onerror="alert(1)">`,
  `<IMG SRC=x OnErRoR=alert(1)>`,
  `<svg/onload=alert(1)>`,
  `<a href="javascript:alert(1)">click</a>`,
  `[click](javascript:alert(1))`,
  `[click](JaVaScRiPt:alert(1))`,
  `[click]( javascript:alert(1))`,
  `[click](data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==)`,
  `[click](vbscript:msgbox(1))`,
  `![x](javascript:alert(1))`,
  `![x](https://evil.example/track.gif)`,
  `<iframe src="https://evil.example"></iframe>`,
  `<style>body{display:none}</style>`,
  "`<script>alert(1)</script>`",
  "```html\n<script>alert(1)</script>\n```",
  "```\nunclosed fence with <img onerror=alert(1)>",
  `**<script>alert(1)</script>**`,
  `> <script>alert(1)</script>`,
  `- <script>alert(1)</script>`,
  `# <script>alert(1)</script>`,
  `[a](https://ok.example "onmouseover=alert(1)")`,
  `<!-- --><script>alert(1)</script>`,
  `&lt;script&gt;alert(1)&lt;/script&gt;`,
];

test("no hostile input produces a node type outside the closed set", () => {
  for (const input of HOSTILE) {
    // If this ever fails it means a node type was added that the renderer might treat as markup.
    audit(parseMarkdown(input));
  }
});

test("no hostile input produces a dangerous href", () => {
  for (const input of HOSTILE) {
    const { hrefs } = audit(parseMarkdown(input));
    for (const href of hrefs) {
      assert.match(href, /^(https?:|mailto:|[#/])/, `${input} produced href ${href}`);
      assert.doesNotMatch(href, /^javascript:/i);
      assert.doesNotMatch(href, /^data:/i);
      assert.doesNotMatch(href, /^vbscript:/i);
    }
  }
});

test("raw HTML survives as literal text, never as structure", () => {
  // Not stripped: someone writing about `<script>` in a review is making a point, and deleting their
  // words is its own kind of wrong. It just never becomes an element.
  const { text } = audit(parseMarkdown(`<script>alert(1)</script>`));
  assert.match(text, /<script>alert\(1\)<\/script>/);
});

test("a refused link keeps its label as readable text", () => {
  const blocks = parseMarkdown(`[click me](javascript:alert(1))`);
  const { hrefs, text } = audit(blocks);
  assert.deepEqual(hrefs, [], "no href at all, rather than a neutered one");
  assert.match(text, /click me/);
});

test("safeHref allows only what can be navigated to safely", () => {
  assert.equal(safeHref("https://github.com/a/b"), "https://github.com/a/b");
  assert.equal(safeHref("http://localhost:4391/x"), "http://localhost:4391/x");
  assert.ok(safeHref("mailto:a@b.com"));
  assert.equal(safeHref("#anchor"), "#anchor");
  assert.equal(safeHref("/relative/path"), "/relative/path");
  assert.equal(safeHref("javascript:alert(1)"), null);
  assert.equal(safeHref("  javascript:alert(1)"), null);
  assert.equal(safeHref("data:text/html,<script>"), null);
  assert.equal(safeHref("vbscript:x"), null);
  assert.equal(safeHref("file:///etc/passwd"), null);
  assert.equal(safeHref(""), null);
  assert.equal(safeHref("not a url"), null);
});

test("an image becomes a link, because the CSP forbids remote images", () => {
  // Rendering an <img> would guarantee a broken icon and an attempted request to a third party. The
  // link keeps the information and keeps `img-src 'self'` honest rather than aspirational.
  const blocks = parseMarkdown(`![a diagram](https://example.com/x.png)`);
  const { hrefs, text } = audit(blocks);
  assert.deepEqual(hrefs, ["https://example.com/x.png"]);
  assert.match(text, /a diagram/);
});

// ---------------------------------------------------------------------------
// Code, which is what a review comment is mostly made of
// ---------------------------------------------------------------------------

test("a fenced block keeps its content verbatim and records its language", () => {
  const blocks = parseMarkdown("before\n\n```js\nconst a = 1;\n  indented\n```\n\nafter");
  assert.equal(blocks.length, 3);
  assert.equal(blocks[1].type, "codeblock");
  if (blocks[1].type !== "codeblock") return;
  assert.equal(blocks[1].lang, "js");
  assert.equal(blocks[1].value, "const a = 1;\n  indented");
  assert.equal(blocks[1].closed, true);
});

test("markdown inside a fence is not parsed", () => {
  const blocks = parseMarkdown("```\n**not bold** and [not a link](https://x.example)\n```");
  assert.equal(blocks[0].type, "codeblock");
  if (blocks[0].type !== "codeblock") return;
  assert.equal(blocks[0].value, "**not bold** and [not a link](https://x.example)");
  assert.deepEqual(audit(blocks).hrefs, []);
});

test("a longer fence can contain a shorter one", () => {
  // The case an agent explaining a ```suggestion block runs into immediately.
  const blocks = parseMarkdown("````\n```suggestion\nconst a = 2;\n```\n````");
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].type, "codeblock");
  if (blocks[0].type !== "codeblock") return;
  assert.equal(blocks[0].value, "```suggestion\nconst a = 2;\n```");
});

test("an unclosed fence runs to the end and says it was unclosed", () => {
  const blocks = parseMarkdown("```js\nconst a = 1;\nmore");
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].type, "codeblock");
  if (blocks[0].type !== "codeblock") return;
  assert.equal(blocks[0].value, "const a = 1;\nmore");
  assert.equal(blocks[0].closed, false);
});

test("an inline code span is not further parsed", () => {
  const inlines = parseInline("use `**a** [b](c)` here");
  assert.deepEqual(inlines, [
    { type: "text", value: "use " },
    { type: "code", value: "**a** [b](c)" },
    { type: "text", value: " here" },
  ]);
});

test("a code span may contain backticks by using a longer delimiter", () => {
  assert.deepEqual(parseInline("``a ` b``"), [{ type: "code", value: "a ` b" }]);
});

test("an unmatched backtick is literal", () => {
  assert.deepEqual(parseInline("a ` b"), [{ type: "text", value: "a ` b" }]);
});

// ---------------------------------------------------------------------------
// Ordinary prose
// ---------------------------------------------------------------------------

test("emphasis nests and does not leak across a code span", () => {
  assert.deepEqual(parseInline("**bold**"), [{ type: "strong", children: [{ type: "text", value: "bold" }] }]);
  assert.deepEqual(parseInline("_it_"), [{ type: "em", children: [{ type: "text", value: "it" }] }]);
  // The backticks inside must not be mistaken for the closing marker.
  const mixed = parseInline("*a `x*y` b*");
  assert.equal(mixed[0].type, "em");
});

test("an unclosed emphasis marker is literal", () => {
  assert.deepEqual(parseInline("a * b"), [{ type: "text", value: "a * b" }]);
  assert.deepEqual(parseInline("**"), [{ type: "text", value: "**" }]);
  assert.deepEqual(parseInline("*"), [{ type: "text", value: "*" }]);
});

test("arithmetic and identifiers are not mistaken for emphasis", () => {
  // The reason the flanking rules are implemented rather than skipped. This is a code review tool:
  // silently italicising an identifier inside a comment about that identifier is worse than having no
  // emphasis at all.
  assert.deepEqual(parseInline("2 * 3 * 4"), [{ type: "text", value: "2 * 3 * 4" }]);
  assert.deepEqual(parseInline("snake_case_name"), [{ type: "text", value: "snake_case_name" }]);
  assert.deepEqual(parseInline("MAX_BLOB_BYTES and MAX_LINE_CHARS"), [
    { type: "text", value: "MAX_BLOB_BYTES and MAX_LINE_CHARS" },
  ]);
  assert.deepEqual(parseInline("a ** b"), [{ type: "text", value: "a ** b" }]);
  // But real emphasis still works right next to punctuation.
  assert.deepEqual(parseInline("(**bold**)"), [
    { type: "text", value: "(" },
    { type: "strong", children: [{ type: "text", value: "bold" }] },
    { type: "text", value: ")" },
  ]);
  assert.deepEqual(parseInline("_leading_ word"), [
    { type: "em", children: [{ type: "text", value: "leading" }] },
    { type: "text", value: " word" },
  ]);
});

test("a backslash escapes a marker", () => {
  assert.deepEqual(parseInline("\\*not em\\*"), [{ type: "text", value: "*not em*" }]);
});

test("a soft line break is a space; two trailing spaces is a real break", () => {
  // A hard-wrapped paragraph must not become a column of short lines.
  assert.deepEqual(parseInline("one\ntwo"), [{ type: "text", value: "one two" }]);
  const hard = parseInline("one  \ntwo");
  assert.equal(hard[1].type, "break");
});

test("headings, rules, lists and quotes parse", () => {
  const blocks = parseMarkdown("# Title\n\n---\n\n- one\n- two\n\n1. first\n2. second\n\n> quoted");
  assert.deepEqual(
    blocks.map((block) => block.type),
    ["heading", "rule", "list", "list", "quote"],
  );
  const [heading, , bullets, ordered, quote] = blocks;
  if (heading.type === "heading") assert.equal(heading.level, 1);
  if (bullets.type === "list") {
    assert.equal(bullets.ordered, false);
    assert.equal(bullets.items.length, 2);
  }
  if (ordered.type === "list") {
    assert.equal(ordered.ordered, true);
    assert.equal(ordered.start, 1);
  }
  if (quote.type === "quote") assert.equal(quote.children[0].type, "paragraph");
});

test("a quote can contain a code block", () => {
  // Quoting a snippet is the single most common thing a reviewer does.
  const blocks = parseMarkdown("> look:\n> ```js\n> const a = 1;\n> ```");
  assert.equal(blocks[0].type, "quote");
  if (blocks[0].type !== "quote") return;
  assert.deepEqual(
    blocks[0].children.map((child) => child.type),
    ["paragraph", "codeblock"],
  );
});

test("a link with parentheses in the URL survives", () => {
  // GitHub's own anchors contain them.
  const { hrefs } = audit(parseMarkdown("[x](https://e.example/a_(b)_c)"));
  assert.deepEqual(hrefs, ["https://e.example/a_(b)_c"]);
});

test("a link title is dropped rather than shown or trusted", () => {
  const { hrefs, text } = audit(parseMarkdown(`[x](https://ok.example "a title")`));
  assert.deepEqual(hrefs, ["https://ok.example/"]);
  assert.equal(text.includes("a title"), false);
});

test("empty and blank input produce nothing rather than an empty paragraph", () => {
  assert.deepEqual(parseMarkdown(""), []);
  assert.deepEqual(parseMarkdown("\n\n  \n"), []);
  assert.deepEqual(parseMarkdown(/** @type {any} */ (null)), []);
});

test("a paragraph ends where a block starts, with no blank line needed", () => {
  const blocks = parseMarkdown("text\n```\ncode\n```");
  assert.deepEqual(
    blocks.map((block) => block.type),
    ["paragraph", "codeblock"],
  );
});

test("a realistic agent answer parses into the shapes it looks like", () => {
  const answer = [
    "Đây là handler cho nút **fold/unfold**.",
    "",
    "```js",
    "const fold = target.closest(\"[data-act='fold-file']\");",
    "```",
    "",
    "Hai điểm:",
    "",
    "- `folding` đọc từ DOM",
    "- `mountFile` tự no-op",
    "",
    "Xem [permalink](https://github.com/o/r/blob/abc/src/a.js#L1).",
  ].join("\n");
  const blocks = parseMarkdown(answer);
  assert.deepEqual(
    blocks.map((block) => block.type),
    ["paragraph", "codeblock", "paragraph", "list", "paragraph"],
  );
  const { hrefs, text } = audit(blocks);
  assert.deepEqual(hrefs, ["https://github.com/o/r/blob/abc/src/a.js#L1"]);
  // Non-ASCII passes through untouched.
  assert.match(text, /Đây là handler/);
});

// ---------------------------------------------------------------------------
// Line references
// ---------------------------------------------------------------------------

test("a path with a line number becomes a jump, single line and range alike", () => {
  const [single] = /** @type {any[]} */ (parseMarkdown("look at src/paths.js:42 first"));
  assert.equal(single.type, "paragraph");
  assert.deepEqual(single.children, [
    { type: "text", value: "look at " },
    { type: "jump", path: "src/paths.js", from: 42, to: 42, label: "src/paths.js:42" },
    { type: "text", value: " first" },
  ]);

  const [range] = parseMarkdown("src/anchor/drift.js:100-118 is the cascade");
  assert.deepEqual(/** @type {any} */ (range).children[0], {
    type: "jump",
    path: "src/anchor/drift.js",
    from: 100,
    to: 118,
    label: "src/anchor/drift.js:100-118",
  });
});

test("a reversed range is normalised but still reads back as written", () => {
  const [block] = /** @type {any[]} */ (parseMarkdown("src/a.js:20-10"));
  // The numbers are ordered so the caller never has to, while the label preserves what was typed —
  // rewriting someone's text to look like something they did not write is its own small dishonesty.
  assert.deepEqual(block.children[0], { type: "jump", path: "src/a.js", from: 10, to: 20, label: "src/a.js:20-10" });
});

test("things that merely look like a line reference are left as prose", () => {
  /** @type {Array<[string, string]>} */
  const cases = [
    ["visit http://localhost:4391/review now", "a URL's port is not a line"],
    ["the meeting is at 10:30", "a time has no file extension"],
    ["set PORT:8080 in the env", "no extension, no jump"],
    ["see foo.js:0 for nothing", "line 0 does not exist"],
    ["https://example.com/a/b.js:12 is a URL", "a scheme's path must not be split off"],
  ];
  for (const [text, why] of cases) {
    const [block] = /** @type {any[]} */ (parseMarkdown(text));
    const kinds = block.children.map((/** @type {any} */ child) => child.type);
    assert.ok(!kinds.includes("jump"), `${why}: ${text} produced ${JSON.stringify(block.children)}`);
  }
});

test("a code span that is only a line reference becomes a jump", () => {
  // Everyone writes a path in backticks, and the agent is instructed to. Treating a span as literal
  // whatever it held meant the most common way of writing a reference was the one way that produced no
  // control — reported from the canvas as "the jump links stopped appearing".
  const [block] = /** @type {any[]} */ (parseMarkdown("see `src/skill.js:25` for the description"));
  assert.deepEqual(block.children, [
    { type: "text", value: "see " },
    { type: "jump", path: "src/skill.js", from: 25, to: 25, label: "src/skill.js:25" },
    { type: "text", value: " for the description" },
  ]);
});

test("a code span holding anything besides the reference stays literal", () => {
  // The exact-match rule is what keeps this true. Inside code is the one place text must not be
  // rewritten, so a command that merely mentions a line stays a command.
  for (const source of ["run `grep -n src/a.js:42` to see", "`// src/a.js:42`", "`src/a.js:42 src/b.js:9`"]) {
    const [block] = /** @type {any[]} */ (parseMarkdown(source));
    const kinds = block.children.map((/** @type {any} */ child) => child.type);
    assert.ok(kinds.includes("code"), `${source} lost its code span: ${JSON.stringify(block.children)}`);
    assert.ok(!kinds.includes("jump"), `${source} produced a control: ${JSON.stringify(block.children)}`);
  }
});

test("a fenced block is never scanned for references", () => {
  // A code block is quoted source. A control inside it would be a button in the middle of code the
  // reader is trying to read literally.
  const blocks = /** @type {any[]} */ (parseMarkdown("```\nsrc/a.js:42\n```"));
  assert.equal(blocks[0].type, "codeblock");
  assert.equal(blocks[0].value, "src/a.js:42");
});

test("a line reference inside a link label is not also a jump", () => {
  // Two interactive elements in one is broken for a keyboard and ambiguous for a mouse.
  const [block] = /** @type {any[]} */ (parseMarkdown("[src/a.js:42](https://example.com)"));
  assert.equal(block.children[0].type, "link");
  const inner = /** @type {any} */ (block.children[0]).children;
  assert.deepEqual(
    inner.map((/** @type {any} */ child) => child.type),
    ["text"],
  );
});

/**
 * The smallest `document` `renderMarkdown` can build against.
 *
 * Enough to record what was built and nothing more: the point of these assertions is the *shape* the
 * renderer produces, and a real DOM would add a serialiser between the claim and the evidence.
 */
function fakeDocument() {
  /** @param {string} tag */
  const createElement = (tag) => ({
    tag,
    attributes: /** @type {Record<string, string>} */ ({}),
    children: /** @type {any[]} */ ([]),
    /** @param {string} name @param {string} value */
    setAttribute(name, value) {
      this.attributes[name] = value;
    },
    /** @param {...any} nodes */
    append(...nodes) {
      this.children.push(...nodes);
    },
  });
  return {
    createElement,
    /** @param {string} value */
    createTextNode: (value) => ({ tag: "#text", value }),
    createDocumentFragment: () => createElement("#fragment"),
  };
}

/** @param {any} node @param {string} tag @returns {any} */
function findTag(node, tag) {
  if (node.tag === tag) return node;
  for (const child of node.children ?? []) {
    const found = /** @type {any} */ (findTag(child, tag));
    if (found) return found;
  }
  return null;
}

/** @param {any} node */
function collectText(node) {
  if (node.tag === "#text") return node.value;
  return (node.children ?? []).map(collectText).join("");
}

test("a jump renders as a button carrying the target, not as a link", () => {
  const document = fakeDocument();
  const tree = renderMarkdown(/** @type {any} */ (document), "see src/paths.js:42-58 here");

  const button = findTag(tree, "button");
  assert.ok(button, "no jump control rendered");
  assert.equal(button.attributes.class, "prc-jump");
  assert.equal(button.attributes["data-jump-path"], "src/paths.js");
  assert.equal(button.attributes["data-jump-from"], "42");
  assert.equal(button.attributes["data-jump-to"], "58");
  assert.equal(collectText(button), "src/paths.js:42-58");

  // No anchor and no href anywhere: there is no URL for "line 42 of this diff", and a `#` would
  // scroll to the top if the handler ever went missing.
  assert.equal(findTag(tree, "a"), null);
  /** @type {string[]} */
  const hrefs = [];
  const walk = (/** @type {any} */ node) => {
    if (node.attributes?.href) hrefs.push(node.attributes.href);
    for (const child of node.children ?? []) walk(child);
  };
  walk(tree);
  assert.deepEqual(hrefs, []);
});

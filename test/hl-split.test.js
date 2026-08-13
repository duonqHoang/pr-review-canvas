import assert from "node:assert/strict";
import test from "node:test";
import hljs from "highlight.js/lib/core";
import javascript from "highlight.js/lib/languages/javascript";
import python from "highlight.js/lib/languages/python";
import xml from "highlight.js/lib/languages/xml";
import { highlightBlock } from "../src/worker/hl-worker.js";
import { decodeEntities, splitHighlightedLines, textOf } from "../src/worker/hl-split.js";
import { EXTENSION_LANGUAGES, LANGUAGE_IDS, languageForPath } from "../src/worker/languages.js";

/**
 * The line splitter.
 *
 * This is the riskiest code in the highlighting layer, so it is tested by property rather than by
 * example wherever possible. The properties that matter:
 *
 * 1. **The line count is preserved exactly.** Results are assigned to table rows positionally, so one
 *    line too few shifts every colour after it onto the wrong line.
 * 2. **The text is unchanged.** Highlighting may only alter how a line is wrapped. If it altered the
 *    characters, a column offset read back out of the DOM would address the wrong place in the line.
 * 3. **Every emitted line is independently balanced**, which is the whole reason the splitter exists.
 */

hljs.registerLanguage("javascript", javascript);
hljs.registerLanguage("python", python);
hljs.registerLanguage("xml", xml);

/** @param {string} code @param {string} language */
const highlight = (code, language) => hljs.highlight(code, { language, ignoreIllegals: true }).value;

/**
 * Whether every `<span>` in one line is closed within that line.
 *
 * @param {string} html
 */
function isBalanced(html) {
  let depth = 0;
  for (const match of html.matchAll(/<(\/?)span\b[^>]*>/g)) {
    depth += match[1] ? -1 : 1;
    if (depth < 0) return false;
  }
  return depth === 0;
}

// ---------------------------------------------------------------------------
// The case the splitter exists for
// ---------------------------------------------------------------------------

test("a span straddling a newline is closed and re-opened", () => {
  const code = "const s = `multi\nline\ntemplate`;\nconst n = 2;";
  const html = highlight(code, "javascript");
  // Confirm the premise, so this test cannot silently stop testing anything if hljs changes.
  assert.ok(html.includes("`multi\nline"), "the highlighter no longer emits a span across newlines");

  const lines = splitHighlightedLines(html);
  assert.equal(lines.length, 4);
  for (const [index, line] of lines.entries()) {
    assert.ok(isBalanced(line), `line ${index} is not balanced: ${line}`);
  }
  // The middle lines are still inside the string, so they carry the class rather than losing it.
  assert.match(lines[1], /class="hljs-string"/);
  assert.match(lines[2], /class="hljs-string"/);
});

test("nested spans unwind and re-nest in the right order", () => {
  // Hand-built rather than harvested, so the nesting is unambiguous.
  const html = `<span class="a">one<span class="b">two\nthree</span>four</span>\nfive`;
  const lines = splitHighlightedLines(html);
  assert.deepEqual(lines, [
    `<span class="a">one<span class="b">two</span></span>`,
    `<span class="a"><span class="b">three</span>four</span>`,
    `five`,
  ]);
  for (const line of lines) assert.ok(isBalanced(line));
});

test("a multi-line block comment keeps its class on every line", () => {
  const code = "a();\n/* one\n   two\n   three */\nb();";
  const lines = splitHighlightedLines(highlight(code, "javascript"));
  assert.equal(lines.length, 5);
  for (const index of [1, 2, 3]) assert.match(lines[index], /hljs-comment/);
});

test("a Python triple-quoted string keeps its class on every line", () => {
  const code = 'def f():\n    """doc\n    more\n    """\n    return 1';
  const lines = splitHighlightedLines(highlight(code, "python"));
  assert.equal(lines.length, 5);
  assert.match(lines[2], /hljs-string/);
});

// ---------------------------------------------------------------------------
// Properties
// ---------------------------------------------------------------------------

const SAMPLES = [
  ["javascript", "const a = 1;"],
  ["javascript", "const s = `a\nb`;\nlet t = 2;"],
  ["javascript", "// only a comment"],
  ["javascript", "/* unterminated comment\nkeeps going"],
  ["javascript", "const re = /a\\/b/g;\nconst s = 'it\\'s';"],
  ["javascript", 'const x = "<div>&amp;</div>";'],
  ["javascript", "\n\n\n"],
  ["javascript", ""],
  ["javascript", "trailing\n"],
  ["javascript", "\nleading"],
  ["javascript", "const o = { a: 1 };\n\nfunction f() {\n  return `${o.a}\n${o.b}`;\n}"],
  ["python", 'x = """a\nb"""\ny = 2'],
  ["python", "# comment\nif True:\n    pass"],
  ["xml", "<div>\n  <span>text &lt; here</span>\n</div>"],
  ["xml", "<!-- comment\nacross lines -->\n<p>after</p>"],
];

test("the line count always matches the source exactly", () => {
  for (const [language, code] of SAMPLES) {
    const lines = splitHighlightedLines(highlight(code, language));
    assert.equal(
      lines.length,
      code.split("\n").length,
      `${language}: ${JSON.stringify(code)} produced ${lines.length} lines, expected ${code.split("\n").length}`,
    );
  }
});

test("the text of every line is byte-identical to the source line", () => {
  // The property that protects anchoring: highlighting changes wrapping, never content.
  for (const [language, code] of SAMPLES) {
    const lines = splitHighlightedLines(highlight(code, language));
    const expected = code.split("\n");
    for (const [index, line] of lines.entries()) {
      assert.equal(textOf(line), expected[index], `${language}: line ${index} of ${JSON.stringify(code)} changed`);
    }
  }
});

test("every line is independently balanced", () => {
  for (const [language, code] of SAMPLES) {
    for (const [index, line] of splitHighlightedLines(highlight(code, language)).entries()) {
      assert.ok(isBalanced(line), `${language}: line ${index} of ${JSON.stringify(code)} is unbalanced: ${line}`);
    }
  }
});

// ---------------------------------------------------------------------------
// Malformed input
// ---------------------------------------------------------------------------

test("empty input is one empty line, not zero lines", () => {
  // Zero lines would leave the first row of the file with no result and shift everything up.
  assert.deepEqual(splitHighlightedLines(""), [""]);
  // Cast, because the guard is for a value arriving from a message port rather than from typed code.
  assert.deepEqual(splitHighlightedLines(/** @type {any} */ (null)), [""]);
});

test("a trailing newline yields a final empty line, matching split()", () => {
  assert.deepEqual(splitHighlightedLines("a\n"), ["a", ""]);
  assert.deepEqual("a\n".split("\n"), ["a", ""]);
});

test("an unmatched closing tag is dropped rather than unbalancing a line", () => {
  assert.deepEqual(splitHighlightedLines("</span>text"), ["text"]);
  const lines = splitHighlightedLines("a</span>\nb");
  assert.deepEqual(lines, ["a", "b"]);
  for (const line of lines) assert.ok(isBalanced(line));
});

test("an unclosed opening tag is closed at the end of the input", () => {
  assert.deepEqual(splitHighlightedLines(`<span class="x">a`), [`<span class="x">a</span>`]);
});

test("a truncated tag is kept as text rather than swallowing the rest", () => {
  // Losing colour is acceptable; losing code is not.
  const lines = splitHighlightedLines("keep<span class=");
  assert.equal(lines.length, 1);
  assert.ok(lines[0].startsWith("keep"));
  assert.ok(lines[0].includes("<span class="));
});

test("a self-closing tag does not open a stack entry", () => {
  // A stack entry that never unwinds would wrap the whole remainder of the file.
  const lines = splitHighlightedLines("a<br/>\nb");
  assert.deepEqual(lines, ["a<br/>", "b"]);
});

test("entities survive the round trip and are not double-decoded", () => {
  assert.equal(decodeEntities("&amp;lt;"), "&lt;");
  assert.equal(decodeEntities("&lt;div&gt;"), "<div>");
  assert.equal(decodeEntities("&quot;q&quot; &#39;a&#39;"), `"q" 'a'`);
  assert.equal(textOf(`<span class="s">&amp;amp;</span>`), "&amp;");
});

// ---------------------------------------------------------------------------
// The worker's own contract
// ---------------------------------------------------------------------------

test("an unknown language yields escaped plain text, one entry per line", async () => {
  const result = await highlightBlock("<b>&\n'x'", null);
  assert.equal(result.highlighted, false);
  assert.deepEqual(result.lines, ["&lt;b&gt;&amp;", "&#39;x&#39;"]);
});

test("a known language is highlighted and still line-for-line", async () => {
  const code = "const s = `a\nb`;";
  const result = await highlightBlock(code, "javascript");
  assert.equal(result.highlighted, true);
  assert.equal(result.lines.length, 2);
  assert.equal(result.lines.map(textOf).join("\n"), code);
});

test("a language that is not on the list is refused rather than guessed at", async () => {
  // Auto-detection is deliberately never used: a wrong guess re-colours a whole file, and a hunk is
  // a fragment with no beginning, which is the input detection handles worst.
  const result = await highlightBlock("SELECT 1", "brainfuck");
  assert.equal(result.highlighted, false);
});

test("plain-text escaping matches the row renderer's, so a swap changes nothing", async () => {
  const { escapeHtml } = await import("../src/shared/escape.js");
  const result = await highlightBlock("a <b> & 'c' \"d\"", null);
  assert.deepEqual(result.lines, [escapeHtml("a <b> & 'c' \"d\"")]);
});

// ---------------------------------------------------------------------------
// Language detection
// ---------------------------------------------------------------------------

test("a language is chosen from the extension", () => {
  assert.equal(languageForPath("src/main.js"), "javascript");
  assert.equal(languageForPath("src/main.tsx"), "typescript");
  assert.equal(languageForPath("a/b/style.SCSS"), "scss");
  assert.equal(languageForPath("go.mod"), null);
  assert.equal(languageForPath("main.go"), "go");
});

test("a well-known filename with no extension is recognised", () => {
  assert.equal(languageForPath("Dockerfile"), "dockerfile");
  assert.equal(languageForPath("deploy/Dockerfile"), "dockerfile");
  assert.equal(languageForPath("Makefile"), "makefile");
  assert.equal(languageForPath("Gemfile"), "ruby");
  assert.equal(languageForPath("CMakeLists.txt"), "cmake");
});

test("a suffixed well-known filename still resolves", () => {
  assert.equal(languageForPath("Dockerfile.dev"), "dockerfile");
});

test("a dotfile resolves on its inner extension", () => {
  assert.equal(languageForPath(".eslintrc.json"), "json");
  assert.equal(languageForPath("config/.prettierrc.yaml"), "yaml");
});

test("an unknown or empty path is plain text, not a guess", () => {
  assert.equal(languageForPath("LICENSE"), null);
  assert.equal(languageForPath("data.bin"), null);
  assert.equal(languageForPath(""), null);
  assert.equal(languageForPath("dir/"), null);
});

test("every mapped language id has a loader in the worker", async () => {
  // Otherwise a file would map to a language that can never be registered, and silently render plain.
  const source = await (
    await import("node:fs/promises")
  ).readFile(new URL("../src/worker/hl-worker.js", import.meta.url), "utf8");
  for (const id of LANGUAGE_IDS) {
    assert.ok(new RegExp(`\\b${id}: \\(\\) =>`).test(source), `no loader for ${id}`);
  }
  // And nothing maps to an id that is not in the registered list.
  for (const id of Object.values(EXTENSION_LANGUAGES)) assert.ok(LANGUAGE_IDS.includes(id), `${id} is unregistered`);
});

test("every registered language actually exists in highlight.js", async () => {
  // A loader for a grammar the package does not ship fails the *bundle*, not the test — which is a
  // late and confusing place to find out. `hcl` was exactly this: mapped, loader written, no such
  // module. Resolving each one here names the offender directly.
  for (const id of LANGUAGE_IDS) {
    const module = await import(`highlight.js/lib/languages/${id}`);
    assert.equal(typeof module.default, "function", `highlight.js has no usable grammar for ${id}`);
  }
});

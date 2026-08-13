import hljs from "highlight.js/lib/core";
import { splitHighlightedLines } from "./hl-split.js";
import { LANGUAGE_IDS } from "./languages.js";

/**
 * The syntax-highlighting worker.
 *
 * It runs off the main thread for one reason: highlighting a 60-file pull request is a few hundred
 * milliseconds of regex work, and doing it on the main thread would stall scrolling and typing —
 * during a review, where the user is doing both constantly. A worker makes it invisible instead of
 * merely fast.
 *
 * The protocol is deliberately dumb. A request is `{ id, language, code }` and a reply is
 * `{ id, lines }` — one HTML string per input line, always exactly as many as the input had. The
 * worker never sees the DOM, the anchors or the diff; it transforms text into text, so the thing that
 * decides where a comment goes is not affected by whether highlighting arrived, failed or was slow.
 */

/** Registered lazily: a grammar costs parse time even when the review has no file that needs it. */
const registered = new Set();

/** @param {string} language */
async function ensureLanguage(language) {
  if (registered.has(language)) return true;
  if (!LANGUAGE_IDS.includes(language)) return false;
  try {
    // A static list of dynamic imports, so esbuild can see and bundle every one of them.
    const module = await LOADERS[/** @type {keyof typeof LOADERS} */ (language)]?.();
    if (!module) return false;
    hljs.registerLanguage(language, module.default);
    registered.add(language);
    return true;
  } catch {
    // A grammar that will not load means plain text for that file. Not worth reporting: the diff is
    // still completely readable.
    return false;
  }
}

/**
 * Every grammar, as a lazily-invoked import.
 *
 * Written out rather than built from a template string because a dynamic import with a computed
 * specifier cannot be statically analysed, and esbuild would either bundle every language in the
 * package or none of them.
 */
const LOADERS = {
  bash: () => import("highlight.js/lib/languages/bash"),
  c: () => import("highlight.js/lib/languages/c"),
  cmake: () => import("highlight.js/lib/languages/cmake"),
  cpp: () => import("highlight.js/lib/languages/cpp"),
  csharp: () => import("highlight.js/lib/languages/csharp"),
  css: () => import("highlight.js/lib/languages/css"),
  dart: () => import("highlight.js/lib/languages/dart"),
  diff: () => import("highlight.js/lib/languages/diff"),
  dockerfile: () => import("highlight.js/lib/languages/dockerfile"),
  go: () => import("highlight.js/lib/languages/go"),
  graphql: () => import("highlight.js/lib/languages/graphql"),
  groovy: () => import("highlight.js/lib/languages/groovy"),
  ini: () => import("highlight.js/lib/languages/ini"),
  java: () => import("highlight.js/lib/languages/java"),
  javascript: () => import("highlight.js/lib/languages/javascript"),
  json: () => import("highlight.js/lib/languages/json"),
  kotlin: () => import("highlight.js/lib/languages/kotlin"),
  less: () => import("highlight.js/lib/languages/less"),
  lua: () => import("highlight.js/lib/languages/lua"),
  makefile: () => import("highlight.js/lib/languages/makefile"),
  markdown: () => import("highlight.js/lib/languages/markdown"),
  perl: () => import("highlight.js/lib/languages/perl"),
  php: () => import("highlight.js/lib/languages/php"),
  protobuf: () => import("highlight.js/lib/languages/protobuf"),
  python: () => import("highlight.js/lib/languages/python"),
  r: () => import("highlight.js/lib/languages/r"),
  ruby: () => import("highlight.js/lib/languages/ruby"),
  rust: () => import("highlight.js/lib/languages/rust"),
  scala: () => import("highlight.js/lib/languages/scala"),
  scss: () => import("highlight.js/lib/languages/scss"),
  sql: () => import("highlight.js/lib/languages/sql"),
  swift: () => import("highlight.js/lib/languages/swift"),
  typescript: () => import("highlight.js/lib/languages/typescript"),
  xml: () => import("highlight.js/lib/languages/xml"),
  yaml: () => import("highlight.js/lib/languages/yaml"),
};

/**
 * Highlight a block and split it into lines.
 *
 * The line count of the result always equals the line count of the input, including when the language
 * is unknown or the highlighter throws. The caller assigns results to rows positionally, so a short
 * array would shift colouring onto the wrong lines — worse than no colouring at all.
 *
 * @param {string} code
 * @param {string | null} language
 * @returns {Promise<{ lines: string[], highlighted: boolean }>}
 */
export async function highlightBlock(code, language) {
  const source = String(code ?? "");
  const plain = source.split("\n").map(escapeHtml);
  if (!language || !(await ensureLanguage(language))) return { lines: plain, highlighted: false };
  try {
    // `ignoreIllegals` because a diff hunk is a fragment: it can legitimately begin in the middle of
    // a construct, which some grammars would otherwise refuse outright.
    const { value } = hljs.highlight(source, { language, ignoreIllegals: true });
    const lines = splitHighlightedLines(value);
    if (lines.length !== plain.length) return { lines: plain, highlighted: false };
    return { lines, highlighted: true };
  } catch {
    return { lines: plain, highlighted: false };
  }
}

/**
 * Escaped the same way the row renderer escapes, so an un-highlighted line is byte-identical to what
 * the server produced and swapping it in changes nothing.
 *
 * @param {string} value
 */
function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// The worker half. Guarded so this module can be imported and tested in Node, where there is no
// `self` and no message port.
if (typeof self !== "undefined" && typeof self.postMessage === "function") {
  self.addEventListener("message", async (event) => {
    const request = /** @type {any} */ (event).data ?? {};
    const { lines, highlighted } = await highlightBlock(request.code ?? "", request.language ?? null);
    self.postMessage({ id: request.id, lines, highlighted });
  });
}

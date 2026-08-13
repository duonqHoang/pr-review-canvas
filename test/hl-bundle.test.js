import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";
import { textOf } from "../src/worker/hl-split.js";

/**
 * The **built** highlighting worker.
 *
 * Everything else in this area tests the source modules, which leaves one real gap: the worker is the
 * only bundle whose entry point is never imported by anything else, and its grammars are loaded
 * through dynamic `import()` that esbuild has to inline. A build that resolved those wrongly — or a
 * language mapped to a grammar the package does not ship — produces a file that loads fine and then
 * silently highlights nothing. That is invisible to every source-level test.
 *
 * So this runs the actual output file, with a fake `self`, and asserts it answers a message the way
 * the client expects.
 *
 * A browser would be the more complete check, and it is not usable here: the review page holds an SSE
 * connection open for the life of the session, so headless Chrome's `--dump-dom` never sees the page
 * go idle and never returns. That is a note for the E2E harness, not a reason to leave the bundle
 * unexercised.
 */

const BUNDLE = new URL("../src/client/prc-hl-worker.js", import.meta.url);

/**
 * Load the bundle with a minimal `self`, and return a function that posts a message and resolves
 * with the reply.
 */
async function loadWorkerBundle() {
  const code = await readFile(BUNDLE, "utf8");
  /** @type {Array<(event: { data: unknown }) => unknown>} */
  const listeners = [];
  /** @type {Array<(value: any) => void>} */
  const replies = [];

  const self = {
    /** @param {string} type @param {(event: { data: unknown }) => unknown} handler */
    addEventListener(type, handler) {
      if (type === "message") listeners.push(handler);
    },
    /** @param {unknown} message */
    postMessage(message) {
      replies.shift()?.(message);
    },
  };

  const context = vm.createContext({ self, console, TextDecoder, TextEncoder, URL, setTimeout, clearTimeout });
  vm.runInContext(code, context, { filename: "prc-hl-worker.js" });
  assert.equal(listeners.length, 1, "the bundle did not register a message listener");

  /**
   * @param {{ code: string, language: string | null, id?: number }} request
   * @returns {Promise<{ id: number, lines: string[], highlighted: boolean }>}
   */
  return (request) =>
    new Promise((resolve, reject) => {
      replies.push(resolve);
      const timer = setTimeout(() => reject(new Error("the worker never answered")), 10_000);
      Promise.resolve(listeners[0]({ data: { id: 1, ...request } })).catch(reject);
      // Not unref'd: the promise resolves first in every passing run, and a hang should fail loudly.
      timer.unref?.();
    });
}

test("the built bundle registers a listener and highlights JavaScript", async () => {
  const post = await loadWorkerBundle();
  const code = "const x = 1; // note";
  const reply = await post({ code, language: "javascript" });
  assert.equal(reply.id, 1);
  assert.equal(reply.highlighted, true, "the bundled grammars did not load");
  assert.equal(reply.lines.length, 1);
  assert.match(reply.lines[0], /hljs-keyword/);
  assert.match(reply.lines[0], /hljs-comment/);
  assert.equal(reply.lines.map(textOf).join("\n"), code);
});

test("the built bundle splits a construct that spans lines", async () => {
  // The whole point of the worker, verified through the real artefact.
  const post = await loadWorkerBundle();
  const code = "const s = `a\nb\nc`;\nconst n = 2;";
  const reply = await post({ code, language: "javascript" });
  assert.equal(reply.highlighted, true);
  assert.equal(reply.lines.length, 4);
  assert.equal(reply.lines.map(textOf).join("\n"), code);
  for (const line of reply.lines) {
    let depth = 0;
    for (const match of line.matchAll(/<(\/?)span\b[^>]*>/g)) depth += match[1] ? -1 : 1;
    assert.equal(depth, 0, `unbalanced line from the bundle: ${line}`);
  }
});

test("the built bundle can load more than one grammar", async () => {
  // Registration is cached per language, so a second one exercises a different path than the first.
  const post = await loadWorkerBundle();
  for (const [language, source, expected] of [
    ["python", 'x = """a\nb"""', /hljs-string/],
    ["yaml", "key: value\nother: 2", /hljs-attr/],
    ["go", "func main() {}", /hljs-keyword/],
  ]) {
    const reply = await post({ code: /** @type {string} */ (source), language: /** @type {string} */ (language) });
    assert.equal(reply.highlighted, true, `${language} did not highlight`);
    assert.match(reply.lines.join("\n"), /** @type {RegExp} */ (expected), `${language} produced no tokens`);
    assert.equal(reply.lines.map(textOf).join("\n"), source);
  }
});

test("the built bundle falls back to escaped plain text for an unknown language", async () => {
  const post = await loadWorkerBundle();
  const reply = await post({ code: "<b>&\n'x'", language: null });
  assert.equal(reply.highlighted, false);
  // `Array.from`, because the reply crosses a VM realm: the array is structurally identical but has
  // a different `Array` prototype, which strict deep equality rejects.
  assert.deepEqual(Array.from(reply.lines), ["&lt;b&gt;&amp;", "&#39;x&#39;"]);
});

test("the built bundle never returns a different number of lines than it was given", async () => {
  const post = await loadWorkerBundle();
  for (const code of ["", "\n", "a\n\n\nb", "one line", "/* open\ncomment"]) {
    const reply = await post({ code, language: "javascript" });
    // Results are applied to rows positionally, so a count mismatch would shift colours onto the
    // wrong lines. The worker falls back to plain text rather than let that happen.
    assert.equal(reply.lines.length, code.split("\n").length, `wrong line count for ${JSON.stringify(code)}`);
  }
});

/**
 * Splitting highlighted HTML back into one string per source line.
 *
 * This is the genuinely hard part of syntax-highlighting a diff, and the reason it exists is worth
 * stating precisely.
 *
 * A highlighter has to see a whole continuous block of code to be correct: a template literal, a
 * block comment or a heredoc spans lines, and a highlighter given one line at a time cannot know it
 * is inside one. So the block is highlighted as a whole — and comes back as HTML in which a single
 * `<span>` may contain newlines:
 *
 *     <span class="hljs-string">`multi\nline`</span>
 *
 * A diff, however, is a table: each line is a separate cell. Cutting that HTML on `\n` would leave
 * the first line with an unclosed `<span>` and the second beginning inside a span it never opened —
 * which the browser then "fixes" by inventing a structure of its own, usually by colouring the rest
 * of the file like a string.
 *
 * So this walks the HTML keeping a stack of open tags, and at every newline closes the whole stack,
 * ends the line, and re-opens the same stack on the next one. Each emitted line is independently
 * well-formed, and the colouring is still the colouring of the whole block.
 *
 * No DOM, no dependencies: it runs in a worker.
 */

/**
 * @param {string} html output of a highlighter for a block of code
 * @returns {string[]} one well-formed HTML string per source line
 */
export function splitHighlightedLines(html) {
  const source = String(html ?? "");
  /** @type {string[]} */
  const lines = [];
  /** @type {string[]} */
  const stack = [];
  /** @type {string[]} */
  let current = [];

  const endLine = () => {
    // Close what is open, innermost first, so this line stands alone...
    for (let depth = stack.length - 1; depth >= 0; depth -= 1) current.push("</span>");
    lines.push(current.join(""));
    // ...and re-open the same nesting on the next one, outermost first.
    current = stack.slice();
  };

  let index = 0;
  while (index < source.length) {
    const next = source.indexOf("<", index);
    if (next === -1) {
      pushText(source.slice(index));
      break;
    }
    if (next > index) pushText(source.slice(index, next));
    const close = source.indexOf(">", next);
    if (close === -1) {
      // A truncated tag. Treat the remainder as text rather than dropping it: losing code is worse
      // than losing colour.
      pushText(source.slice(next));
      break;
    }
    const tag = source.slice(next, close + 1);
    index = close + 1;

    if (tag.startsWith("</")) {
      // An unmatched closing tag is ignored rather than emitted, which keeps every output line
      // balanced even if the input was not.
      if (stack.length > 0) {
        stack.pop();
        current.push(tag);
      }
      continue;
    }
    current.push(tag);
    // The stack holds opening tags verbatim, because re-opening a line means emitting them again
    // with their classes intact. A self-closing tag opens nothing: a highlighter does not emit one,
    // but a stack entry that never unwinds would wrap the whole rest of the file.
    if (!tag.endsWith("/>")) stack.push(tag);
  }

  lines.push(closeAll(current, stack));
  return lines;

  /** @param {string} text */
  function pushText(text) {
    let start = 0;
    for (;;) {
      const breakAt = text.indexOf("\n", start);
      if (breakAt === -1) {
        if (start < text.length) current.push(text.slice(start));
        return;
      }
      if (breakAt > start) current.push(text.slice(start, breakAt));
      endLine();
      start = breakAt + 1;
    }
  }
}

/**
 * @param {string[]} current
 * @param {string[]} stack
 */
function closeAll(current, stack) {
  const parts = current.slice();
  for (let depth = stack.length - 1; depth >= 0; depth -= 1) parts.push("</span>");
  return parts.join("");
}

/**
 * The text a highlighted line represents, with tags removed and entities decoded.
 *
 * Exported because it is how the split is *verified*: the invariant that matters is that
 * highlighting changes only how a line is wrapped, never what it says. If this ever disagrees with
 * the original source line, an anchor computed from the DOM would point at the wrong column.
 *
 * @param {string} html
 * @returns {string}
 */
export function textOf(html) {
  return decodeEntities(String(html ?? "").replace(/<[^>]*>/g, ""));
}

/** @param {string} value */
export function decodeEntities(value) {
  /** @type {Record<string, string>} */
  const entities = {
    "&lt;": "<",
    "&gt;": ">",
    "&quot;": '"',
    "&#x27;": "'",
    "&#39;": "'",
    "&nbsp;": " ",
    "&amp;": "&",
  };
  // One pass is load-bearing: an escaped `&amp;lt;` must become `&lt;`, not decode twice to `<`.
  return value.replace(/&(?:lt|gt|quot|#x27|#39|nbsp|amp);/g, (entity) => entities[entity]);
}

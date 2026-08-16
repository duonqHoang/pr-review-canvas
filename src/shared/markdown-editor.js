/**
 * Pure text edits for the comment composer.
 *
 * The browser must never hand review prose to a rich-text model that can normalize or discard it.
 * These operations only splice the textarea value and return an explicit selection, so formatting is
 * reversible with the browser's native undo and the Markdown sent to GitHub is exactly what is shown.
 */

/** @typedef {{ value: string, selectionStart: number, selectionEnd: number }} MarkdownEdit */

/**
 * @param {string} value
 * @param {number} selectionStart
 * @param {number} selectionEnd
 * @param {string} before
 * @param {string} after
 * @param {string} placeholder
 * @returns {MarkdownEdit}
 */
function wrap(value, selectionStart, selectionEnd, before, after, placeholder) {
  const selected = value.slice(selectionStart, selectionEnd);
  const content = selected || placeholder;
  const replacement = `${before}${content}${after}`;
  const start = selectionStart + before.length;
  return {
    value: value.slice(0, selectionStart) + replacement + value.slice(selectionEnd),
    selectionStart: start,
    selectionEnd: start + content.length,
  };
}

/**
 * Prefix every selected line without changing any characters the reviewer wrote.
 *
 * @param {string} value
 * @param {number} selectionStart
 * @param {number} selectionEnd
 * @param {(index: number) => string} prefix
 * @returns {MarkdownEdit}
 */
function prefixLines(value, selectionStart, selectionEnd, prefix) {
  const start = value.lastIndexOf("\n", Math.max(0, selectionStart - 1)) + 1;
  // A selection that ends immediately after a newline does not include the next line. Treating its
  // endpoint as part of that line would format prose the reviewer did not select.
  const selectedEnd =
    selectionEnd > selectionStart && value[selectionEnd - 1] === "\n" ? selectionEnd - 1 : selectionEnd;
  const newline = value.indexOf("\n", selectedEnd);
  const end = newline < 0 ? value.length : newline;
  const lines = value.slice(start, end).split("\n");
  const replacement = lines.map((line, index) => `${prefix(index)}${line}`).join("\n");
  return {
    value: value.slice(0, start) + replacement + value.slice(end),
    selectionStart: start,
    selectionEnd: start + replacement.length,
  };
}

/**
 * @param {string} value
 * @param {number} selectionStart
 * @param {number} selectionEnd
 * @param {string} action
 * @returns {MarkdownEdit}
 */
export function editMarkdown(value, selectionStart, selectionEnd, action) {
  if (action === "bold") return wrap(value, selectionStart, selectionEnd, "**", "**", "bold text");
  if (action === "italic") return wrap(value, selectionStart, selectionEnd, "_", "_", "italic text");
  if (action === "code") return wrap(value, selectionStart, selectionEnd, "`", "`", "code");
  if (action === "link") return wrap(value, selectionStart, selectionEnd, "[", "](url)", "link text");
  if (action === "heading") return prefixLines(value, selectionStart, selectionEnd, () => "### ");
  if (action === "quote") return prefixLines(value, selectionStart, selectionEnd, () => "> ");
  if (action === "bullet") return prefixLines(value, selectionStart, selectionEnd, () => "- ");
  if (action === "ordered") return prefixLines(value, selectionStart, selectionEnd, (index) => `${index + 1}. `);
  return { value, selectionStart, selectionEnd };
}

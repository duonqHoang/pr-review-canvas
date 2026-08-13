/**
 * HTML escaping, defined **once**.
 *
 * lavish has two copies of this — one in the server and one in the browser client — because its
 * client file cannot use `import`. We bundle the client instead, precisely so security-relevant
 * helpers like this one have a single definition that cannot drift.
 *
 * @param {unknown} value
 * @returns {string}
 */
export function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * Serialize a value for embedding inside `<script type="application/json">`.
 *
 * `<` and `>` must be escaped so the payload cannot close the script element early, and the two
 * Unicode line separators must be escaped because they are literal line terminators in JS source
 * but legal inside a JSON string.
 *
 * @param {unknown} value
 * @returns {string}
 */
export function jsonScript(value) {
  return (
    JSON.stringify(value ?? null)
      .replace(/&/g, "\\u0026")
      .replace(/</g, "\\u003c")
      .replace(/>/g, "\\u003e")
      // Written as escapes, NOT as the literal characters. U+2028 and U+2029 are line terminators
      // in JavaScript source, so a literal one here would terminate this very regex — which is
      // exactly the hazard this function exists to neutralise.
      .replace(/\u2028/g, "\\u2028")
      .replace(/\u2029/g, "\\u2029")
  );
}

/**
 * Escape a string for use inside an attribute value that is quoted with `"`.
 *
 * @param {unknown} value
 */
export function attr(value) {
  return escapeHtml(value);
}

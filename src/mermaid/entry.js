import mermaid from "mermaid";

/**
 * Mermaid, in its own bundle.
 *
 * Kept out of `prc-client.js` on purpose: mermaid is 3.3 MB minified, twenty times the rest of the
 * client put together, and most reviews contain no diagram at all. This file is fetched the first time
 * a ```mermaid block appears and never otherwise, so the cost falls on the page that asked for it.
 *
 * It is bundled rather than loaded from a CDN because the page's CSP is `script-src 'self'` — a remote
 * script cannot execute here, which is the point of the CSP and not an obstacle to route around.
 *
 * What leaves this file is an SVG *string*. The caller does not put it on the page: `sanitizeSvg` in
 * the client rebuilds it node by node against an allowlist first. `securityLevel: "strict"` is mermaid's
 * own sanitisation and is set here too, because two independent filters is the right number for markup
 * that can originate in a pull request comment written by a stranger.
 */

let ready = false;

/**
 * Two settings here are not preferences but requirements of how the output is consumed.
 *
 * `htmlLabels: false` — mermaid's default puts node labels in a `foreignObject`, which is HTML inside
 * SVG and therefore the one thing `svg-policy.js` will never allow through. With labels as HTML the
 * diagram arrived as unlabelled boxes. As `<text>` it survives.
 *
 * The theme is `base` and left deliberately plain, because mermaid ships its colours as an inline
 * `<style>` block: the page's CSP is `style-src 'self'`, and the sanitiser drops `style` elements in any
 * case, so a themed diagram would come out black-on-black. `prc.css` styles the classes mermaid puts on
 * its own elements instead — which has the side benefit that a diagram follows the page's light and dark
 * tokens without being re-rendered.
 *
 */
function configure() {
  mermaid.initialize({
    startOnLoad: false,
    securityLevel: "strict",
    theme: "base",
    htmlLabels: false,
    flowchart: { htmlLabels: false, useMaxWidth: false },
    sequence: { useMaxWidth: false },
    er: { useMaxWidth: false },
    class: { htmlLabels: false, useMaxWidth: false },
    // The font is declared here rather than in CSS because mermaid *measures* text to size its boxes
    // and route its arrows. Restyling the type afterwards made every label wider than the box mermaid
    // had computed for it, and the arrows — aimed at the old boundaries — ran through the words.
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
    themeVariables: { fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace", fontSize: "12px" },
  });
  ready = true;
}

/**
 * @param {string} id unique per render; mermaid uses it for the SVG's own element ids
 * @param {string} source the diagram as written in the fence
 * @returns {Promise<string>} SVG markup, still to be sanitised by the caller
 */
async function render(id, source) {
  configure();
  const { svg } = await mermaid.render(id, source);
  return svg;
}

/** @param {string} source @returns {Promise<boolean>} */
async function parses(source) {
  if (!ready) configure();
  try {
    await mermaid.parse(source);
    return true;
  } catch {
    return false;
  }
}

Object.defineProperty(window, "__prcMermaid", { value: { render, parses }, writable: false });

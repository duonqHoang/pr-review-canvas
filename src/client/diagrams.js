import { isSafeSvgAttr, isSafeSvgTag } from "../shared/svg-policy.js";

/**
 * Diagrams in a comment or a chat message.
 *
 * A ```mermaid fence is rendered to SVG by the separate `prc-mermaid.js` asset, which is fetched the
 * first time one appears and never otherwise. What comes back is a *string*, and it is not put on the
 * page as markup: `sanitizeSvg` re-creates it node by node against `shared/svg-policy.js`. Mermaid's
 * own `securityLevel: "strict"` already filters labels, so this is the second of two filters — the
 * right number for markup whose source can be a pull request comment written by a stranger.
 *
 * A diagram that fails to parse stays a code block. Someone reading a review is better served by the
 * text they wrote than by an error where their diagram should be.
 */

const SVG_NS = "http://www.w3.org/2000/svg";
const XHTML_NS = "http://www.w3.org/1999/xhtml";

/** @type {Promise<any> | null} */
let loading = null;
let counter = 0;

/**
 * Load `prc-mermaid.js` once, and hand back what it published on `window`.
 *
 * @returns {Promise<any>}
 */
function loadMermaid() {
  if (loading) return loading;
  loading = new Promise((resolve, reject) => {
    const existing = /** @type {any} */ (window).__prcMermaid;
    if (existing) {
      resolve(existing);
      return;
    }
    const script = document.createElement("script");
    script.src = "/assets/prc-mermaid.js";
    script.addEventListener("load", () => {
      const api = /** @type {any} */ (window).__prcMermaid;
      if (api) resolve(api);
      else reject(new Error("prc-mermaid.js loaded without publishing an API"));
    });
    script.addEventListener("error", () => reject(new Error("could not load the diagram renderer")));
    document.head.append(script);
  });
  return loading;
}

/**
 * Rebuild an SVG string as DOM, keeping only what the policy allows.
 *
 * Parsed as `image/svg+xml` rather than as HTML: the XML parser does not run scripts, does not
 * execute anything on the way in, and reports malformed input instead of guessing at it. Nothing from
 * the parsed tree is reused — every node is created fresh, so an exotic node type that neither the
 * policy nor this walk knows about cannot ride along by being carried over intact.
 *
 * @param {string} svgText
 * @returns {SVGElement | null}
 */
export function sanitizeSvg(svgText) {
  const parsed = new DOMParser().parseFromString(String(svgText ?? ""), "image/svg+xml");
  if (parsed.getElementsByTagNameNS(XHTML_NS, "parsererror").length > 0) return null;
  const root = parsed.documentElement;
  if (!root || !isSafeSvgTag(root.localName)) return null;
  const rebuilt = rebuild(root);
  return /** @type {SVGElement | null} */ (rebuilt);
}

/**
 * @param {Element} source
 * @returns {Element | null}
 */
function rebuild(source) {
  if (!isSafeSvgTag(source.localName)) return null;
  const node = document.createElementNS(SVG_NS, source.localName);
  for (const attr of [...source.attributes]) {
    // `attr.name` keeps the prefix (`xml:space`), which is what the policy is written against.
    if (isSafeSvgAttr(attr.name, attr.value)) node.setAttribute(attr.name, attr.value);
  }
  for (const child of [...source.childNodes]) {
    if (child.nodeType === 3) {
      // Text, the only node type carried across as-is. `textContent` cannot introduce markup.
      node.append(document.createTextNode(child.nodeValue ?? ""));
      continue;
    }
    if (child.nodeType !== 1) continue; // comments, CDATA, processing instructions: dropped
    const rebuiltChild = rebuild(/** @type {Element} */ (child));
    if (rebuiltChild) node.append(rebuiltChild);
  }
  return node;
}

/**
 * Show one diagram in the shared dialog.
 *
 * The SVG is cloned rather than moved: the copy in the message stays where it is, so closing the dialog
 * needs no restoration step and a failure halfway through cannot leave a message with a hole in it. The
 * clone is of already-sanitised DOM, so nothing re-enters through this path.
 *
 * @param {Element} figure the `figure.prc-diagram` whose button was pressed
 */
export function zoomDiagram(figure) {
  const svg = figure.querySelector("svg");
  const dialog = /** @type {HTMLDialogElement | null} */ (document.getElementById("prcDiagramDialog"));
  const host = document.getElementById("prcDiagramZoom");
  if (!svg || !dialog || !host) return;
  host.textContent = "";
  host.append(svg.cloneNode(true));
  dialog.showModal();
}

/**
 * Turn every ```mermaid block inside `root` into a diagram.
 *
 * Asynchronous and deliberately not awaited by callers: the message is on screen immediately as its
 * source text, and the picture replaces it when the renderer arrives. A review is readable throughout.
 *
 * @param {ParentNode} root
 */
export function upgradeDiagrams(root) {
  const blocks = [...root.querySelectorAll('pre.prc-md-code > code[data-lang="mermaid"]')];
  if (blocks.length === 0) return;

  loadMermaid()
    .then(async (mermaid) => {
      for (const block of blocks) {
        const pre = block.parentElement;
        if (!pre || !pre.isConnected) continue;
        const source = block.textContent ?? "";
        try {
          counter += 1;
          // No theme is passed: `prc.css` colours the result, so a diagram needs no re-render when the
          // reader switches between light and dark.
          const svgText = await mermaid.render(`prc-diagram-${counter}`, source);
          const svg = sanitizeSvg(svgText);
          if (!svg) continue;
          const figure = document.createElement("figure");
          // Two classes with two jobs: `prc-diagram` is this box — border, padding, its own scrollbar —
          // while `prc-mermaid` is the palette the SVG's own class names are styled through. The enlarged
          // view reuses the second one, which is why they are not the same class.
          figure.className = "prc-diagram prc-mermaid";
          // A diagram is often wider than the column it lands in — a sequence diagram is 1200px and the
          // chat panel is 360 — so scrolling inside the figure is the reading of last resort and this is
          // the one that actually works. The button is in the figure rather than the toolbar because it
          // acts on this diagram, and there can be several in one message.
          const zoom = document.createElement("button");
          zoom.type = "button";
          zoom.className = "prc-diagram-zoom";
          zoom.setAttribute("data-act", "zoom-diagram");
          zoom.setAttribute("title", "View this diagram enlarged");
          zoom.setAttribute("aria-label", "View this diagram enlarged");
          zoom.textContent = "⤢";
          figure.append(zoom, svg);
          pre.replaceWith(figure);
        } catch {
          // Left as a code block: the source is what the author wrote, and it says more than a
          // rendering error would.
        }
      }
    })
    .catch(() => {
      // The renderer could not be fetched. Every diagram stays a code block, which is exactly the
      // behaviour of a page that never had mermaid at all.
    });
}

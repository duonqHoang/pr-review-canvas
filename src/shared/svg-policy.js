/**
 * What may survive from a rendered diagram.
 *
 * Mermaid turns a fenced block into SVG markup, and that markup goes on a page which also shows pull
 * request comments written by strangers. Two things follow. First, the SVG string is never assigned to
 * `innerHTML`: the client rebuilds it node by node with `createElementNS`, and this file is the
 * allowlist that walk consults. Second, the policy is stated as *what is permitted* rather than what is
 * stripped — a denylist is a promise that nobody will ever invent a new way in.
 *
 * The rules are here, in `shared/`, and pure: they take strings and return booleans, so they can be
 * tested without a DOM. The twenty lines of DOM walking that use them live in the client.
 */

/** Elements a diagram is allowed to be made of. Anything else — `script`, `foreignObject`, `use`,
 * `image`, `iframe`, `style` — is dropped along with its subtree. `foreignObject` is the notable one:
 * it embeds arbitrary HTML inside SVG, which would reintroduce exactly the hole `markdown.js` closes by
 * having no node type that can hold raw HTML. Mermaid can emit it for HTML labels, so a dropped label
 * is the price of not having that hole. */
export const SVG_TAGS = new Set([
  "svg",
  "g",
  "defs",
  "marker",
  "path",
  "line",
  "polyline",
  "polygon",
  "rect",
  "circle",
  "ellipse",
  "text",
  "tspan",
  "title",
  "desc",
  "linearGradient",
  "radialGradient",
  "stop",
  "clipPath",
  "pattern",
]);

/** Attributes that carry geometry, text and colour. No `on*` appears here, and none can: the check
 * below is membership in this set, so an event handler is not rejected by a rule that could be
 * forgotten — it is simply never permitted in the first place. */
export const SVG_ATTRS = new Set([
  "viewBox",
  "xmlns",
  "width",
  "height",
  "x",
  "y",
  "x1",
  "x2",
  "y1",
  "y2",
  "cx",
  "cy",
  "r",
  "rx",
  "ry",
  "d",
  "points",
  "transform",
  "fill",
  "fill-opacity",
  "fill-rule",
  "stroke",
  "stroke-width",
  "stroke-linecap",
  "stroke-linejoin",
  "stroke-dasharray",
  "stroke-opacity",
  "opacity",
  "class",
  "id",
  "text-anchor",
  "dominant-baseline",
  "alignment-baseline",
  "font-family",
  "font-size",
  "font-weight",
  "font-style",
  "letter-spacing",
  "dx",
  "dy",
  "marker-end",
  "marker-start",
  "marker-mid",
  "markerWidth",
  "markerHeight",
  "markerUnits",
  "refX",
  "refY",
  "orient",
  "offset",
  "stop-color",
  "stop-opacity",
  "gradientUnits",
  "patternUnits",
  "clip-path",
  "clip-rule",
  "preserveAspectRatio",
  "xml:space",
]);

/** A `url(...)` reference that stays inside this document. `marker-end="url(#arrow)"` is how an arrow
 * head is attached and has to work; `url(http://…)` is a request to somewhere else. */
const LOCAL_URL_RE = /^url\(\s*['"]?#[\w.:-]+['"]?\s*\)$/;

/**
 * Whether one attribute may be copied onto a rebuilt node.
 *
 * @param {string} name
 * @param {string} value
 * @returns {boolean}
 */
export function isSafeSvgAttr(name, value) {
  const attr = String(name ?? "");
  const text = String(value ?? "");
  // Case-insensitively, because `oNcLiCk` is an event handler too and attribute names arrive
  // lowercased from HTML parsing but case-preserved from XML.
  const lower = attr.toLowerCase();
  if (lower.startsWith("on")) return false;
  // `xlink:href` and `href` can both navigate, and `use` was already excluded — there is no attribute
  // here that needs to point anywhere, so neither is allowed at all.
  if (lower === "href" || lower.endsWith(":href")) return false;
  if (lower === "style") return false;
  if (!SVG_ATTRS.has(attr)) return false;
  // A permitted attribute may still carry a fetch: `fill="url(https://evil/x)"` is a request off this
  // machine from a page whose CSP exists to prevent exactly that.
  if (/url\s*\(/i.test(text)) return LOCAL_URL_RE.test(text.trim());
  return true;
}

/**
 * Whether an element may be rebuilt at all. A false answer drops the element *and its children*.
 *
 * @param {string} tagName
 * @returns {boolean}
 */
export function isSafeSvgTag(tagName) {
  return SVG_TAGS.has(String(tagName ?? ""));
}

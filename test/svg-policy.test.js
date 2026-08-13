import assert from "node:assert/strict";
import test from "node:test";
import { isSafeSvgAttr, isSafeSvgTag, SVG_ATTRS, SVG_TAGS } from "../src/shared/svg-policy.js";

/**
 * The allowlist a rendered diagram has to pass.
 *
 * Mermaid is a 3.4 MB dependency that turns text into markup, and the text can come from a pull request
 * comment written by anyone. Its own `securityLevel: "strict"` is the first filter; this is the second,
 * and the reason there are two is that the first one is code nobody here maintains.
 *
 * These tests are about the *policy* — pure string predicates, no DOM. The walk that applies them
 * (`src/client/diagrams.js`) rebuilds every node with `createElementNS` and never assigns markup, which
 * is what makes an allowlist sufficient rather than merely helpful.
 */

test("an event handler is not rejected by a rule but by never being permitted", () => {
  // The distinction matters: a denylist of `on*` would have to anticipate every handler name. Here the
  // question is membership of SVG_ATTRS, and no handler is a member.
  for (const attr of SVG_ATTRS) assert.ok(!attr.toLowerCase().startsWith("on"), `${attr} is an event handler`);
  for (const name of ["onclick", "onload", "onmouseover", "oNcLiCk", "ONFOCUS"]) {
    assert.equal(isSafeSvgAttr(name, "alert(1)"), false, `${name} was allowed`);
  }
});

test("nothing may point anywhere", () => {
  // `use` and `image` are not permitted elements, so no allowed attribute needs a target. That makes
  // href a flat no rather than a scheme check that could be tricked.
  for (const name of ["href", "xlink:href", "XLINK:HREF"]) {
    assert.equal(isSafeSvgAttr(name, "#local"), false, `${name} was allowed`);
    assert.equal(isSafeSvgAttr(name, "javascript:alert(1)"), false, `${name} was allowed`);
  }
  assert.equal(isSafeSvgAttr("style", "fill:red"), false, "style was allowed");
});

test("a url() may only reference this document", () => {
  // Arrow heads genuinely need `marker-end="url(#id)"`, so the check is where the URL points rather
  // than whether one appears at all.
  assert.equal(isSafeSvgAttr("marker-end", "url(#arrow)"), true);
  assert.equal(isSafeSvgAttr("marker-end", "url('#arrow')"), true);
  assert.equal(isSafeSvgAttr("fill", "url(#grad1)"), true);
  for (const value of ["url(https://evil.example/x)", "url(//evil.example/x)", "url(data:image/svg+xml,x)"]) {
    assert.equal(isSafeSvgAttr("fill", value), false, `${value} was allowed`);
  }
});

test("the elements that can carry markup or fetch are absent", () => {
  // `foreignObject` is the one worth naming: it embeds HTML inside SVG, which would put back exactly the
  // hole markdown.js closes by having no node type that can hold raw HTML. Mermaid emits it for HTML
  // labels, so a plainer label is the price.
  for (const tag of ["script", "foreignObject", "use", "image", "iframe", "style", "a", "animate", "set"]) {
    assert.equal(isSafeSvgTag(tag), false, `${tag} is allowed`);
    assert.ok(!SVG_TAGS.has(tag), `${tag} is in SVG_TAGS`);
  }
});

test("an ordinary diagram's vocabulary is allowed", () => {
  // The negative half of this file is worthless if the positive half fails: a policy that rejects
  // everything passes every security test and renders nothing.
  for (const tag of ["svg", "g", "path", "rect", "text", "tspan", "marker", "defs", "line", "polygon"]) {
    assert.equal(isSafeSvgTag(tag), true, `${tag} is refused`);
  }
  for (const [name, value] of [
    ["viewBox", "0 0 100 50"],
    ["d", "M0 0 10 10"],
    ["transform", "translate(4,8)"],
    ["stroke-width", "1.5"],
    ["text-anchor", "middle"],
    ["class", "node label"],
  ]) {
    assert.equal(isSafeSvgAttr(name, value), true, `${name}="${value}" is refused`);
  }
});

test("an attribute nobody listed is refused, whatever it holds", () => {
  assert.equal(isSafeSvgAttr("onbogus", "x"), false);
  assert.equal(isSafeSvgAttr("data-anything", "x"), false);
  assert.equal(isSafeSvgAttr("requiredExtensions", "x"), false);
});

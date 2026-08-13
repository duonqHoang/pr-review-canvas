/**
 * Markdown for review comments.
 *
 * Hand-written rather than `marked` + `DOMPurify`, and the reason is not size (though 60 kB for this
 * is a poor trade): those two put an HTML *string* in the middle of the pipeline, and then try to
 * clean it. Everything here is structural instead. The parser produces a tree of plain objects with
 * a closed set of node types, and there is **no node type that can carry raw HTML** — so a `<script>`
 * in a comment body is not sanitised away, it is simply un-representable. That is a much stronger
 * claim than "we filtered the dangerous parts", and it is the right claim to want when the text comes
 * from strangers on the internet.
 *
 * Two layers, deliberately:
 *
 * - `parseMarkdown` is pure and DOM-free, which is what keeps this module importable by Node and by
 *   the browser alike, and lets the security tests assert on the tree directly.
 * - `renderMarkdown` takes a `document` and builds real nodes. It sets text through `textContent` and
 *   attributes through `setAttribute`, so nothing it produces can be reinterpreted as markup.
 *
 * What is deliberately NOT supported, with reasons:
 *
 * - **Raw HTML.** See above. Passed through as literal text.
 * - **Images.** The page's CSP is `img-src 'self' data:`, so a remote image cannot load; rendering one
 *   would produce a broken icon and leak a request attempt. `![alt](url)` becomes a link instead,
 *   which is honest and keeps the CSP truthful rather than aspirational.
 * - **Tables.** Common in prose, rare in review comments, and a large amount of parser for the value.
 */

/**
 * @typedef {{ type: "text", value: string }
 *   | { type: "code", value: string }
 *   | { type: "strong", children: Inline[] }
 *   | { type: "em", children: Inline[] }
 *   | { type: "link", href: string, children: Inline[] }
 *   | { type: "jump", path: string, from: number, to: number, label: string }
 *   | { type: "break" }} Inline
 */

/**
 * @typedef {{ type: "paragraph", children: Inline[] }
 *   | { type: "heading", level: number, children: Inline[] }
 *   | { type: "codeblock", lang: string, value: string, closed: boolean }
 *   | { type: "list", ordered: boolean, start: number, items: Inline[][] }
 *   | { type: "quote", children: Block[] }
 *   | { type: "rule" }} Block
 */

/** Schemes allowed to become an `href`. */
const SAFE_SCHEMES = new Set(["http:", "https:", "mailto:"]);

/**
 * A URL that may become an `href`, or null.
 *
 * Escaping is not enough on its own: `javascript:alert(1)` contains no character `escapeHtml` would
 * touch, so an escaped-but-unvalidated URL is still an injection. `data:` is excluded too — a
 * `data:text/html` link navigates to attacker-authored markup.
 *
 * @param {string} value
 * @returns {string | null}
 */
export function safeHref(value) {
  const raw = String(value ?? "").trim();
  if (!raw) return null;
  // A relative link has no scheme and cannot carry one; anchors and paths are fine as-is.
  if (/^[#/]/.test(raw)) return raw;
  try {
    const url = new URL(raw);
    return SAFE_SCHEMES.has(url.protocol) ? url.href : null;
  } catch {
    return null;
  }
}

/**
 * A reference to a line of this diff, written the way anyone already writes one: `src/paths.js:42` or
 * `src/paths.js:42-58`.
 *
 * Deliberately *not* a new syntax. The agent is asked to name lines constantly, and inventing a
 * markup for it would mean the one form that reads naturally in a sentence — and the form it would
 * emit anyway — stayed dead text.
 *
 * The extension is required, and that is what keeps this from firing on prose. `localhost:4391` and
 * `10:30` have no extension; `http://host:8080/x` is excluded separately by the preceding-character
 * check, because a scheme's `//` must not be read as part of a path.
 */
const JUMP_RE = /(^|[\s([{<'"])([\w.+-]+(?:\/[\w.+-]+)*\.[A-Za-z0-9]{1,12}):(\d{1,7})(?:-(\d{1,7}))?(?![\w:/-])/;

const FENCE_RE = /^(\s{0,3})(`{3,}|~{3,})\s*([^\s`]*)/;
const HEADING_RE = /^(\s{0,3})(#{1,6})\s+(.*)$/;
const RULE_RE = /^\s{0,3}([-*_])(?:\s*\1){2,}\s*$/;
const BULLET_RE = /^(\s*)([-*+])\s+(.*)$/;
const ORDERED_RE = /^(\s*)(\d{1,9})[.)]\s+(.*)$/;
const QUOTE_RE = /^\s{0,3}>\s?(.*)$/;

/**
 * Parse markdown into a block tree.
 *
 * @param {string} text
 * @returns {Block[]}
 */
export function parseMarkdown(text) {
  const lines = String(text ?? "").split("\n");
  /** @type {Block[]} */
  const blocks = [];
  let index = 0;

  while (index < lines.length) {
    const line = lines[index];

    if (!line.trim()) {
      index += 1;
      continue;
    }

    const fence = FENCE_RE.exec(line);
    if (fence) {
      const marker = fence[2];
      const lang = fence[3] ?? "";
      /** @type {string[]} */
      const body = [];
      index += 1;
      let closed = false;
      while (index < lines.length) {
        // The closing fence must be at least as long as the opening one and of the same character,
        // which is what lets a fenced block contain a shorter fence — the case a ```suggestion inside
        // an explanation runs into.
        const candidate = new RegExp(`^\\s{0,3}${marker[0]}{${marker.length},}\\s*$`).test(lines[index]);
        if (candidate) {
          closed = true;
          index += 1;
          break;
        }
        body.push(lines[index]);
        index += 1;
      }
      // An unclosed fence runs to the end of the input rather than being abandoned: the text is still
      // code, and reparsing it as prose would mangle it.
      blocks.push({ type: "codeblock", lang, value: body.join("\n"), closed });
      continue;
    }

    const heading = HEADING_RE.exec(line);
    if (heading) {
      blocks.push({
        type: "heading",
        level: heading[2].length,
        children: parseInline(heading[3].replace(/\s+#+\s*$/, "")),
      });
      index += 1;
      continue;
    }

    if (RULE_RE.test(line)) {
      blocks.push({ type: "rule" });
      index += 1;
      continue;
    }

    const quote = QUOTE_RE.exec(line);
    if (quote) {
      /** @type {string[]} */
      const inner = [];
      while (index < lines.length) {
        const next = QUOTE_RE.exec(lines[index]);
        if (!next) break;
        inner.push(next[1]);
        index += 1;
      }
      // Recursion, so a quoted code block or list still works — quoting a snippet is the single most
      // common thing a reviewer does.
      blocks.push({ type: "quote", children: parseMarkdown(inner.join("\n")) });
      continue;
    }

    const bullet = BULLET_RE.exec(line);
    const ordered = ORDERED_RE.exec(line);
    if (bullet || ordered) {
      const isOrdered = Boolean(ordered);
      const start = isOrdered ? Number(/** @type {RegExpExecArray} */ (ordered)[2]) : 1;
      /** @type {Inline[][]} */
      const items = [];
      while (index < lines.length) {
        const asBullet = BULLET_RE.exec(lines[index]);
        const asOrdered = ORDERED_RE.exec(lines[index]);
        const match = isOrdered ? asOrdered : asBullet;
        if (!match) {
          // A plain indented line continues the item it follows.
          if (items.length > 0 && /^\s+\S/.test(lines[index]) && lines[index].trim()) {
            items[items.length - 1].push({ type: "text", value: ` ${lines[index].trim()}` });
            index += 1;
            continue;
          }
          break;
        }
        items.push(parseInline(match[3]));
        index += 1;
      }
      blocks.push({ type: "list", ordered: isOrdered, start, items });
      continue;
    }

    /** @type {string[]} */
    const paragraph = [];
    while (index < lines.length) {
      const current = lines[index];
      if (
        !current.trim() ||
        FENCE_RE.test(current) ||
        HEADING_RE.test(current) ||
        RULE_RE.test(current) ||
        QUOTE_RE.test(current) ||
        BULLET_RE.test(current) ||
        ORDERED_RE.test(current)
      ) {
        break;
      }
      paragraph.push(current);
      index += 1;
    }
    blocks.push({ type: "paragraph", children: parseInline(paragraph.join("\n")) });
  }

  return blocks;
}

/**
 * Parse the inline content of one block.
 *
 * Code spans are consumed first and never re-examined, which is what makes `` `**not bold**` ``
 * behave and stops a fence's contents being reinterpreted.
 *
 * @param {string} text
 * @param {{ jumps?: boolean }} [options]
 * @returns {Inline[]}
 */
export function parseInline(text, options = {}) {
  const source = String(text ?? "");
  // Disabled inside a link's label: a jump control nested in an anchor is two interactive elements in
  // one, which is broken for a keyboard and ambiguous for a mouse.
  const jumps = options.jumps !== false;
  /** @type {Inline[]} */
  const out = [];
  let buffer = "";
  let index = 0;

  const flush = () => {
    if (!buffer) return;
    if (jumps) out.push(...splitJumps(buffer));
    else out.push({ type: "text", value: buffer });
    buffer = "";
  };

  while (index < source.length) {
    const char = source[index];

    // A backslash escape makes the next character literal.
    if (char === "\\" && index + 1 < source.length && /[\\`*_[\]()#!>-]/.test(source[index + 1])) {
      buffer += source[index + 1];
      index += 2;
      continue;
    }

    if (char === "\n") {
      // Two trailing spaces, or a trailing backslash, is a hard break; anything else is a soft one,
      // and a soft break in a review comment reads better as a space than as a new line.
      const hard = /(\s\s|\\)$/.test(buffer);
      if (hard) {
        buffer = buffer.replace(/(\s\s|\\)$/, "");
        flush();
        out.push({ type: "break" });
      } else {
        buffer += " ";
      }
      index += 1;
      continue;
    }

    if (char === "`") {
      const run = /^`+/.exec(source.slice(index))?.[0] ?? "`";
      const closeAt = source.indexOf(run, index + run.length);
      // An unmatched run of backticks is literal text, not the start of a span that never ends.
      if (closeAt === -1) {
        buffer += run;
        index += run.length;
        continue;
      }
      flush();
      const code = source.slice(index + run.length, closeAt);
      // A code span that is *nothing but* a line reference is a reference, not code. Everyone writes
      // `src/cli.js:126` with backticks — the agent is told to, in so many words — and a span was the
      // one place `splitJumps` never looked, so the most common way of writing a reference was the one
      // way that produced no control. Only an exact match converts: a span with prose or code around
      // the reference stays literal, because inside code is the one place text must not be rewritten.
      const asJump = jumps ? splitJumps(code) : [];
      if (asJump.length === 1 && asJump[0].type === "jump") out.push(asJump[0]);
      else out.push({ type: "code", value: code });
      index = closeAt + run.length;
      continue;
    }

    // An image becomes a link: the CSP forbids remote images, so rendering one would guarantee a
    // broken icon and an attempted request.
    if (char === "!" && source[index + 1] === "[") {
      const link = matchLink(source, index + 1);
      if (link) {
        flush();
        const href = safeHref(link.href);
        const label = link.text || link.href;
        if (href) out.push({ type: "link", href, children: [{ type: "text", value: label }] });
        else out.push({ type: "text", value: label });
        index = link.end;
        continue;
      }
    }

    if (char === "[") {
      const link = matchLink(source, index);
      if (link) {
        flush();
        const href = safeHref(link.href);
        // A refused scheme keeps its label as plain text. Dropping the text entirely would hide part
        // of what someone wrote, which is worse than showing an unclickable phrase.
        if (href) out.push({ type: "link", href, children: parseInline(link.text, { jumps: false }) });
        else out.push(...parseInline(link.text));
        index = link.end;
        continue;
      }
    }

    if (char === "*" || char === "_") {
      const double = source.startsWith(char.repeat(2), index);
      const marker = double ? char.repeat(2) : char;
      const closeAt = canOpenEmphasis(source, index, marker)
        ? findEmphasisClose(source, index + marker.length, marker)
        : -1;
      if (closeAt !== -1) {
        flush();
        const inner = parseInline(source.slice(index + marker.length, closeAt));
        out.push(double ? { type: "strong", children: inner } : { type: "em", children: inner });
        index = closeAt + marker.length;
        continue;
      }
    }

    buffer += char;
    index += 1;
  }

  flush();
  return out;
}

/**
 * Split a run of plain text into text and line references.
 *
 * @param {string} text
 * @returns {Inline[]}
 */
export function splitJumps(text) {
  /** @type {Inline[]} */
  const out = [];
  let rest = String(text ?? "");
  for (;;) {
    const match = JUMP_RE.exec(rest);
    if (!match) break;
    const [whole, lead, path, fromRaw, toRaw] = match;
    const before = rest.slice(0, match.index) + lead;
    const from = Number(fromRaw);
    const to = toRaw === undefined ? from : Number(toRaw);
    rest = rest.slice(match.index + whole.length);
    // Line 0 does not exist, so `foo.js:0` is prose about a file, not a reference to a line in it.
    if (from < 1 || to < 1) {
      out.push({ type: "text", value: `${before}${whole.slice(lead.length)}` });
      continue;
    }
    if (before) out.push({ type: "text", value: before });
    out.push({
      type: "jump",
      path,
      from: Math.min(from, to),
      to: Math.max(from, to),
      // The label is what was written, not what it was normalised to: a reversed range should still
      // read back as the person typed it.
      label: `${path}:${fromRaw}${toRaw === undefined ? "" : `-${toRaw}`}`,
    });
  }
  if (rest) out.push({ type: "text", value: rest });
  return out;
}

/**
 * @param {string} source
 * @param {number} at index of `[`
 * @returns {{ text: string, href: string, end: number } | null}
 */
function matchLink(source, at) {
  if (source[at] !== "[") return null;
  let depth = 0;
  let close = -1;
  for (let index = at; index < source.length; index += 1) {
    if (source[index] === "\\") {
      index += 1;
      continue;
    }
    if (source[index] === "[") depth += 1;
    if (source[index] === "]") {
      depth -= 1;
      if (depth === 0) {
        close = index;
        break;
      }
    }
  }
  if (close === -1 || source[close + 1] !== "(") return null;
  // Balanced parens, so a URL containing one — which GitHub's own anchors do — survives.
  let parens = 0;
  let end = -1;
  for (let index = close + 1; index < source.length; index += 1) {
    if (source[index] === "(") parens += 1;
    if (source[index] === ")") {
      parens -= 1;
      if (parens === 0) {
        end = index;
        break;
      }
    }
  }
  if (end === -1) return null;
  const target = source.slice(close + 2, end).trim();
  // A title after the URL is dropped rather than shown.
  const href = target.split(/\s+/)[0] ?? "";
  return { text: source.slice(at + 1, close), href, end: end + 1 };
}

/**
 * Whether a marker at this position may *open* emphasis.
 *
 * A simplified form of CommonMark's flanking rules, and the reason it is here rather than omitted for
 * brevity is that this is a code review tool. Without these two checks:
 *
 *   `2 * 3 * 4`          becomes "2 <em> 3 </em> 4"
 *   `snake_case_name`    becomes "snake<em>case</em>name"
 *
 * Both are common in the code being discussed, and silently italicising an identifier in a comment
 * about that identifier is worse than not supporting emphasis at all.
 *
 * @param {string} source
 * @param {number} at index of the first marker character
 * @param {string} marker
 */
function canOpenEmphasis(source, at, marker) {
  const after = source[at + marker.length];
  // Nothing, or whitespace, immediately after an opening marker means it is not one.
  if (after === undefined || /\s/.test(after)) return false;
  if (marker[0] === "_") {
    // `_` never emphasises inside a word, which is what protects snake_case.
    const before = source[at - 1];
    if (before !== undefined && /[\p{L}\p{N}]/u.test(before)) return false;
  }
  return true;
}

/**
 * @param {string} source
 * @param {number} from
 * @param {string} marker
 */
function findEmphasisClose(source, from, marker) {
  for (let index = from; index < source.length; index += 1) {
    if (source[index] === "\\") {
      index += 1;
      continue;
    }
    // A code span inside emphasis must be skipped whole, or its backticks could look like a close.
    if (source[index] === "`") {
      const run = /^`+/.exec(source.slice(index))?.[0] ?? "`";
      const closeAt = source.indexOf(run, index + run.length);
      if (closeAt !== -1) {
        index = closeAt + run.length - 1;
        continue;
      }
    }
    if (source.startsWith(marker, index)) {
      // An empty span is not emphasis.
      if (index === from) return -1;
      // Whitespace immediately before a closing marker means it is not one — the other half of the
      // flanking rule, and what stops `a * b * c` closing on the second star.
      if (/\s/.test(source[index - 1])) continue;
      if (marker[0] === "_") {
        // Symmetrically to opening: `_` cannot close inside a word.
        const next = source[index + marker.length];
        if (next !== undefined && /[\p{L}\p{N}]/u.test(next)) continue;
      }
      return index;
    }
  }
  return -1;
}

/**
 * Render markdown into a document fragment.
 *
 * The `document` is a parameter so this stays testable and so the module never reaches for a global.
 * Text goes in through `textContent` and URLs through `setAttribute`, which means no string produced
 * here is ever parsed as markup.
 *
 * @param {Document} document
 * @param {string} text
 * @returns {DocumentFragment}
 */
export function renderMarkdown(document, text) {
  const fragment = document.createDocumentFragment();
  for (const block of parseMarkdown(text)) fragment.append(renderBlock(document, block));
  return fragment;
}

/**
 * @param {Document} document
 * @param {Block} block
 * @returns {Element}
 */
function renderBlock(document, block) {
  switch (block.type) {
    case "codeblock": {
      const pre = document.createElement("pre");
      pre.className = "prc-md-code";
      const code = document.createElement("code");
      if (block.lang) code.setAttribute("data-lang", block.lang);
      // Never highlighted here: this is someone's comment, and the diff's own highlighter works on
      // parsed diff lines rather than arbitrary text.
      code.textContent = block.value;
      pre.append(code);
      return pre;
    }
    case "heading": {
      // Clamped to h3..h6: a comment is nested inside the page's own heading structure, so an <h1>
      // in a comment body would outrank the pull request's title.
      const element = document.createElement(`h${Math.min(6, block.level + 2)}`);
      element.append(renderInlines(document, block.children));
      return element;
    }
    case "rule":
      return document.createElement("hr");
    case "list": {
      const list = document.createElement(block.ordered ? "ol" : "ul");
      if (block.ordered && block.start !== 1) list.setAttribute("start", String(block.start));
      for (const item of block.items) {
        const li = document.createElement("li");
        li.append(renderInlines(document, item));
        list.append(li);
      }
      return list;
    }
    case "quote": {
      const quote = document.createElement("blockquote");
      for (const child of block.children) quote.append(renderBlock(document, child));
      return quote;
    }
    default: {
      const paragraph = document.createElement("p");
      paragraph.append(renderInlines(document, block.children));
      return paragraph;
    }
  }
}

/**
 * @param {Document} document
 * @param {Inline[]} inlines
 * @returns {DocumentFragment}
 */
function renderInlines(document, inlines) {
  const fragment = document.createDocumentFragment();
  for (const inline of inlines) {
    switch (inline.type) {
      case "code": {
        const code = document.createElement("code");
        code.textContent = inline.value;
        fragment.append(code);
        break;
      }
      case "strong": {
        const strong = document.createElement("strong");
        strong.append(renderInlines(document, inline.children));
        fragment.append(strong);
        break;
      }
      case "em": {
        const em = document.createElement("em");
        em.append(renderInlines(document, inline.children));
        fragment.append(em);
        break;
      }
      case "link": {
        const anchor = document.createElement("a");
        // Validated at parse time; set through the DOM API, so it cannot become markup.
        anchor.setAttribute("href", inline.href);
        anchor.setAttribute("target", "_blank");
        anchor.setAttribute("rel", "noreferrer noopener");
        anchor.append(renderInlines(document, inline.children));
        fragment.append(anchor);
        break;
      }
      case "jump": {
        // A button, not an anchor. There is no URL for "line 42 of this diff" — the row may not even
        // be mounted yet — so an `href` would either be a lie or a `#` that scrolls to the top when
        // the handler is missing. A button is honestly a control, and it is focusable and operable
        // from the keyboard for free.
        const button = document.createElement("button");
        button.setAttribute("type", "button");
        button.setAttribute("class", "prc-jump");
        button.setAttribute("data-jump-path", inline.path);
        button.setAttribute("data-jump-from", String(inline.from));
        button.setAttribute("data-jump-to", String(inline.to));
        button.setAttribute("title", `Go to ${inline.label} in the diff`);
        button.append(document.createTextNode(inline.label));
        fragment.append(button);
        break;
      }
      case "break":
        fragment.append(document.createElement("br"));
        break;
      default:
        fragment.append(document.createTextNode(inline.value));
        break;
    }
  }
  return fragment;
}

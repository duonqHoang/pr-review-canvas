import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

/**
 * The stylesheet's own consistency check.
 *
 * This suite exists because of a specific bug that happened three times while building the review
 * canvas: a misspelled custom property. `color: var(--prc-code-size)` when the token is really
 * `--prc-code` does not throw, does not warn, and does not show up in a diff review — the rule is
 * simply dropped and the element inherits something plausible. Nothing else in the project fails
 * silently like that, so nothing else needs a test of this shape.
 *
 * The contrast half is here for the same reason: a colour pair is only wrong when someone tries to
 * read it, which is exactly the moment nobody is running tests.
 */

const srcDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src");
const css = await readFile(path.join(srcDir, "prc.css"), "utf8");
const highlightCss = await readFile(path.join(srcDir, "prc-hl.css"), "utf8");
/** The client source, not the bundle: the bundle may be stale, and this is a source-level agreement. */
const clientSource = await readFile(path.join(srcDir, "client", "main.js"), "utf8");

/**
 * Custom properties declared in one `{ ... }` body.
 *
 * @param {string} body
 * @returns {Map<string, string>}
 */
function declarations(body) {
  /** @type {Map<string, string>} */
  const out = new Map();
  for (const match of body.matchAll(/(--prc-[\w-]+)\s*:\s*([^;]+);/g)) out.set(match[1], match[2].trim());
  return out;
}

/**
 * The body of the first `:root` block at the top level, and of the one inside the
 * `prefers-color-scheme: dark` media query.
 *
 * A deliberately small parser: token blocks are flat lists of declarations with no nested braces,
 * so matching up to the first `}` is exact rather than merely convenient.
 *
 * @param {string} source
 */
function rootBlocks(source) {
  const base = /(?:^|\n):root\s*\{([^}]*)\}/.exec(source);
  const dark = /@media \(prefers-color-scheme: dark\)\s*\{\s*:root[^{]*\{([^}]*)\}/.exec(source);
  const chosen = /(?:^|\n):root\[data-theme="dark"\]\s*\{([^}]*)\}/.exec(source);
  assert.ok(base, "no top-level :root block");
  assert.ok(dark, "no dark-scheme :root block");
  assert.ok(chosen, 'no :root[data-theme="dark"] block');
  return { base: declarations(base[1]), dark: declarations(dark[1]), chosen: declarations(chosen[1]) };
}

/**
 * Both stylesheets' tokens, merged.
 *
 * The two files are separate documents but one cascade: `prc-hl.css` defines the syntax palette and
 * `prc.css` everything else, and a `var()` in either can legally reference a token from the other. So
 * the check has to see them together, or it would report false failures and miss real ones.
 */
const layers = [rootBlocks(css), rootBlocks(highlightCss)];
const base = new Map(layers.flatMap((layer) => [...layer.base]));
const dark = new Map(layers.flatMap((layer) => [...layer.dark]));
const allCss = `${css}\n${highlightCss}`;

test("every token referenced with var() is defined", () => {
  /** @type {Set<string>} */
  const referenced = new Set();
  // `var(--x, fallback)` is legal, so stop at a comma as well as at the closing paren.
  for (const match of allCss.matchAll(/var\(\s*(--prc-[\w-]+)\s*[,)]/g)) referenced.add(match[1]);

  const missing = [...referenced].filter((token) => !base.has(token)).sort();
  assert.deepEqual(missing, [], `referenced but never defined: ${missing.join(", ")}`);
  // The reverse direction is not asserted: an unused token is dead weight, not a bug, and failing
  // the build for one would punish adding a token before the rule that uses it.
});

test("no sticky element sits inside a clipped scroll container", () => {
  // The actual cause of "I can't see the expand-up button", after one wrong diagnosis: `.prc-file` used
  // `overflow: hidden`, which establishes a scroll container — and `position: sticky` resolves against
  // the nearest scroll container rather than the viewport. The sticky `.prc-file-header` was therefore
  // offset by its `top` *inside* its own section: pushed permanently down over the first rows of its
  // table, leaving a band of blank space above the diff and hiding the hunk range and the expand band.
  //
  // `overflow: clip` clips identically and creates no scroll container. The distinction is invisible
  // until something inside is sticky, which is exactly why it needs a test rather than a comment.
  const blockOf = (/** @type {string} */ selector) => {
    const match = new RegExp(`(^|\\})\\s*${selector.replace(".", "\\.")}\\s*\\{([^}]*)\\}`, "m").exec(css);
    return match ? match[2] : null;
  };
  for (const [ancestor, stickyChild] of [
    [".prc-file", ".prc-file-header"],
    [".prc-layout", ".prc-tree"],
  ]) {
    const body = blockOf(ancestor);
    assert.ok(body != null, `no rule found for ${ancestor}`);
    assert.doesNotMatch(
      /** @type {string} */ (body),
      /overflow(-y)?\s*:\s*(hidden|auto|scroll)/,
      `${ancestor} would become a scroll container, breaking the sticky ${stickyChild} inside it`,
    );
  }
});

test("a nominal height is never used as a sticky offset", () => {
  // `--prc-header-h` is a *floor* (`min-height`) — it says how short the header may be, not how tall it
  // is. The header carries the pull request's title, so a long title makes it taller. Using the nominal
  // value as `top` for the sticky file headers stuck them underneath the real header, which hid the
  // first rows of every table: the hunk range and the expand-up band. That is what "I can't see the
  // expand up button" turned out to be, and removing the `top` outright was the user's own workaround.
  //
  // Positional offsets must use `--prc-chrome-h`, which the client measures.
  for (const match of css.matchAll(/(top|scroll-margin-top)\s*:\s*([^;]+);/g)) {
    assert.doesNotMatch(
      match[2],
      /--prc-header-h/,
      `${match[1]} must use the measured --prc-chrome-h, not the nominal --prc-header-h: ${match[0].trim()}`,
    );
  }
  // And the nominal token is only ever a floor.
  for (const match of css.matchAll(/([\w-]+)\s*:\s*var\(--prc-header-h\)/g)) {
    assert.equal(match[1], "min-height", `--prc-header-h used as ${match[1]}`);
  }
});

/** The offsets the client measures at runtime. Anything else used as a `top` is a guess. */
const MEASURED_OFFSETS = ["--prc-chrome-h", "--prc-toolbar-top", "--prc-footer-h", "--prc-aside-top"];

test("every sticky offset comes from a variable the client measures", () => {
  // The general form of the bug above, which the earlier version of this test only caught for one
  // token. There are two sticky layers now — the header and the toolbar under it — so there are two
  // measured offsets, and a third layer added with a guessed height would hide rows in exactly the
  // same way. Stated as "which variables may appear in a `top`" so the next one cannot be added
  // without measuring it.
  /**
   * A spacing token is a constant by nature, so `calc(measured + space)` is fine. What must never
   * appear is another *height*, which would be a guess about how tall the chrome is.
   *
   * @param {string} declaration
   * @param {string} where
   */
  const check = (declaration, where) => {
    const used = [...declaration.matchAll(/var\((--prc-[\w-]+)/g)].map((match) => match[1]);
    if (used.length === 0) return; // a literal offset such as `top: 0` claims nothing
    for (const token of used) {
      const allowed = MEASURED_OFFSETS.includes(token) || /^--prc-space-\d$/.test(token);
      assert.ok(allowed, `${where} uses ${token}, which is neither measured nor a spacing constant`);
    }
    assert.ok(
      used.some((token) => MEASURED_OFFSETS.includes(token)),
      `${where} offsets by ${used.join(" + ")} with no measured height in it: ${declaration.trim()}`,
    );
  };

  // Only inside rules that are actually sticky. An absolutely positioned `top` — the skip link's, for
  // instance — is a placement, not an offset under the chrome, and holding it to this rule would be a
  // false positive that teaches people to widen the exception list.
  let sticky = 0;
  for (const rule of css.matchAll(/([^{}]+)\{([^}]*)\}/g)) {
    if (!/position\s*:\s*sticky/.test(rule[2])) continue;
    sticky += 1;
    const top = /(?:^|[\s;])top\s*:\s*([^;]+);/.exec(rule[2]);
    if (top) check(top[1], `the sticky ${rule[1].trim()}'s top`);
    // The same question at the other end of the column. A sticky panel sized against the whole viewport
    // extends under the fixed review bar, which is how the chat's Send button ended up behind it — the
    // top offset was right and the height was a guess.
    const height = /(?:^|[\s;])max-height\s*:\s*([^;]+);/.exec(rule[2]);
    if (height) check(height[1], `the sticky ${rule[1].trim()}'s max-height`);
  }
  assert.ok(sticky >= 3, `only ${sticky} sticky rules found — the scan is broken, not the CSS`);

  // `scroll-margin-top` is the same question from the other side: how far below the chrome a target
  // must land when something scrolls to it.
  for (const match of css.matchAll(/scroll-margin-top\s*:\s*([^;]+);/g)) check(match[1], "scroll-margin-top");

  // And each of them really is set from JS, so the CSS fallback is only ever a first paint.
  for (const token of MEASURED_OFFSETS) {
    assert.match(
      clientSource,
      new RegExp(`setProperty\\(\\s*"${token}"`),
      `${token} is used as a sticky offset but never measured by the client`,
    );
  }
});

test("every class the client toggles for styling has a rule to style it", () => {
  // The bug this guards is a mismatch, not a typo: `paintSelection` set `prc-selected` on a `<tr>`
  // while the stylesheet had moved to `.prc-code.prc-selected`, so the range highlight silently did
  // nothing in both layouts. Neither file was wrong on its own; they disagreed. Nothing else in the
  // project fails that quietly — a class that no rule matches produces no error anywhere.
  //
  // Scanned out of the client rather than listed by hand, so adding a class to the JS without a rule
  // fails here instead of in someone's eyes.
  const client = clientSource;
  /** @type {Set<string>} */
  const toggled = new Set();
  for (const match of client.matchAll(/classList\.(?:add|toggle)\(([^)]*)\)/g)) {
    for (const name of match[1].matchAll(/"(prc-[a-z-]+)"/g)) toggled.add(name[1]);
  }
  assert.ok(toggled.size > 0, "no toggled classes found — the scan is broken, not the CSS");

  const styled = `${css}\n${highlightCss}`;
  const missing = [...toggled].filter((name) => !new RegExp(`\\.${name}\\b`).test(styled)).sort();
  assert.deepEqual(missing, [], `toggled by the client but never styled: ${missing.join(", ")}`);
});

test("an element the client hides is hidden on screen", () => {
  // `[hidden]` is a UA rule at the lowest possible weight, so any class that sets `display` silently
  // overrides it. The drafts index was hidden with `.hidden = true` and stayed visible, showing an
  // empty "0 drafts" heading, because `.prc-drafts` sets `display: flex`. The client hides eleven
  // different elements this way, so the rule has to win globally rather than per component.
  assert.match(css, /\[hidden\]\s*\{[^}]*display:\s*none\s*!important/);
  assert.match(clientSource, /\.hidden = /, "nothing hides an element in JS — the scan is broken");
});

test("no syntax-highlight class sets a background", () => {
  // Not a style preference — a correctness constraint. The background of a code cell is what says
  // whether a line was added, removed or unchanged, and every stock highlight theme paints
  // backgrounds on a few token types, each of which punches a hole in the diff's own colouring.
  /** @type {string[]} */
  const offenders = [];
  // Rule bodies, so a `background` in a comment or in a `--prc-hl-*` token value is not a hit.
  for (const match of highlightCss.matchAll(/([^{}]+)\{([^}]*)\}/g)) {
    const selector = match[1].replace(/\/\*[\s\S]*?\*\//g, "").trim();
    if (!selector.includes(".hljs")) continue;
    if (/(^|[\s;])background(-color)?\s*:/.test(match[2])) offenders.push(selector);
  }
  assert.deepEqual(offenders, [], `these paint over the diff's own colours: ${offenders.join(" | ")}`);
});

test("the syntax palette is defined for both schemes", () => {
  const highlightTokens = [...base.keys()].filter((token) => token.startsWith("--prc-hl-"));
  assert.ok(highlightTokens.length > 0, "no syntax palette found");
  for (const token of highlightTokens) {
    // A token defined only in light would fall back to the light colour on a dark background, which
    // is the one combination guaranteed to be unreadable.
    assert.ok(dark.has(token), `${token} has no dark-scheme value`);
  }
});

test("both dark blocks say exactly the same thing", () => {
  // Dark is written out twice — once under `prefers-color-scheme` for the reader who has not chosen,
  // once under `[data-theme="dark"]` for the reader who has — because CSS cannot join a media-scoped
  // selector to an unscoped one. A token added to one and not the other is invisible until someone
  // toggles the theme and finds a single colour left behind at its light value.
  for (const [file, layer] of /** @type {Array<[string, ReturnType<typeof rootBlocks>]>} */ ([
    ["prc.css", layers[0]],
    ["prc-hl.css", layers[1]],
  ])) {
    assert.deepEqual(
      Object.fromEntries([...layer.chosen].sort()),
      Object.fromEntries([...layer.dark].sort()),
      `${file}: the two dark blocks have drifted apart`,
    );
  }
});

test("the dark scheme only overrides tokens the light scheme defines", () => {
  // A dark-only token resolves to nothing in light mode — the same silent failure as a typo, just
  // conditional on the reader's OS setting, which is strictly harder to notice.
  const orphans = [...dark.keys()].filter((token) => !base.has(token)).sort();
  assert.deepEqual(orphans, [], `defined only in dark: ${orphans.join(", ")}`);
});

test("both schemes resolve every colour token to a hex literal", () => {
  // The contrast checks below can only be trusted if the values really are literals. A token that
  // became `var(--something-else)` or `color-mix(...)` would silently drop out of coverage.
  for (const [name, theme] of /** @type {Array<[string, Map<string, string>]>} */ ([
    ["light", base],
    ["dark", dark],
  ])) {
    for (const token of COLOUR_TOKENS) {
      const value = theme.get(token) ?? base.get(token);
      assert.ok(value, `${name}: ${token} is not defined`);
      assert.match(value, /^#[0-9a-f]{6}$/i, `${name}: ${token} is not a 6-digit hex literal (${value})`);
    }
  }
});

/** Every colour token the contrast assertions read. */
const COLOUR_TOKENS = [
  "--prc-fg",
  "--prc-fg-muted",
  "--prc-fg-subtle",
  "--prc-accent",
  "--prc-attention",
  "--prc-bg",
  "--prc-bg-inset",
  "--prc-bg-elevated",
  "--prc-diff-add-bg",
  "--prc-diff-del-bg",
  "--prc-diff-add-num-bg",
  "--prc-diff-del-num-bg",
  "--prc-diff-expanded-bg",
];

/** @param {string} hex */
export function relativeLuminance(hex) {
  const digits = hex.replace("#", "");
  const channels = [0, 2, 4]
    .map((offset) => parseInt(digits.slice(offset, offset + 2), 16) / 255)
    .map((channel) => (channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4));
  return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
}

/** @param {string} a @param {string} b */
export function contrastRatio(a, b) {
  const [lighter, darker] = [relativeLuminance(a), relativeLuminance(b)].sort((x, y) => y - x);
  return (lighter + 0.05) / (darker + 0.05);
}

test("contrastRatio matches the WCAG reference pairs", () => {
  // Anchoring the maths itself, so a mistake in it cannot make every other assertion vacuously
  // pass. Black on white is exactly 21:1, and any colour against itself is exactly 1:1.
  assert.equal(Number(contrastRatio("#000000", "#ffffff").toFixed(2)), 21);
  assert.equal(Number(contrastRatio("#1f2328", "#1f2328").toFixed(2)), 1);
});

test("every pull request state badge keeps white text readable", () => {
  // Colour reinforces the visible state word rather than replacing it, but the badge still has to
  // remain readable in either theme. These fills are deliberately shared across themes so a bright
  // dark-mode text token cannot accidentally become a low-contrast badge background.
  for (const token of ["--prc-state-open", "--prc-state-merged", "--prc-state-closed", "--prc-state-draft"]) {
    const ratio = contrastRatio(colour(base, token), "#ffffff");
    assert.ok(ratio >= 4.5, `${token} under white text is ${ratio.toFixed(2)}:1`);
  }
});

/** Backgrounds that code and prose sit on. */
const TEXT_BACKGROUNDS = [
  "--prc-bg",
  "--prc-bg-inset",
  "--prc-bg-elevated",
  "--prc-diff-add-bg",
  "--prc-diff-del-bg",
  "--prc-diff-expanded-bg",
];

/** Backgrounds only ever behind a line number. */
const NUMBER_BACKGROUNDS = ["--prc-diff-add-num-bg", "--prc-diff-del-num-bg", "--prc-bg-inset"];

/** @param {Map<string, string>} theme @param {string} token */
const colour = (theme, token) => /** @type {string} */ (theme.get(token) ?? base.get(token));

for (const [name, theme] of /** @type {Array<[string, Map<string, string>]>} */ ([
  ["light", base],
  ["dark", dark],
])) {
  test(`${name}: code text clears 4.5:1 on every diff background`, () => {
    for (const background of [...TEXT_BACKGROUNDS, ...NUMBER_BACKGROUNDS]) {
      const ratio = contrastRatio(colour(theme, "--prc-fg"), colour(theme, background));
      assert.ok(ratio >= 4.5, `--prc-fg on ${background} is ${ratio.toFixed(2)}:1`);
    }
  });

  test(`${name}: line numbers and secondary text clear 4.5:1`, () => {
    // --prc-fg-muted carries the line numbers, which sit on the tinted number cells. That pairing
    // is the reason the dark add/del number backgrounds are darker than GitHub's.
    for (const background of [...TEXT_BACKGROUNDS, ...NUMBER_BACKGROUNDS]) {
      const ratio = contrastRatio(colour(theme, "--prc-fg-muted"), colour(theme, background));
      assert.ok(ratio >= 4.5, `--prc-fg-muted on ${background} is ${ratio.toFixed(2)}:1`);
    }
  });

  test(`${name}: links clear 4.5:1 where links appear`, () => {
    // Not checked against the number backgrounds: nothing links from inside a line-number cell.
    for (const background of TEXT_BACKGROUNDS) {
      const ratio = contrastRatio(colour(theme, "--prc-accent"), colour(theme, background));
      assert.ok(ratio >= 4.5, `--prc-accent on ${background} is ${ratio.toFixed(2)}:1`);
    }
  });

  test(`${name}: the drift warning clears 4.5:1 where it is used`, () => {
    // The drift strip is the one place a comment is held out of a submission, so its text is the
    // last thing that should be hard to read. It sits on the elevated and inset surfaces only —
    // never in the diff itself — so those are the pairings asserted.
    for (const background of ["--prc-bg-elevated", "--prc-bg-inset"]) {
      const ratio = contrastRatio(colour(theme, "--prc-attention"), colour(theme, background));
      assert.ok(ratio >= 4.5, `--prc-attention on ${background} is ${ratio.toFixed(2)}:1`);
    }
  });

  test(`${name}: the subtle token stays above the 3:1 non-text floor`, () => {
    // --prc-fg-subtle is deliberately below the text threshold: it marks glyphs, rails and the
    // dimmed numbers of non-commentable rows, where dimness *is* the signal. WCAG 1.4.11 puts the
    // bar for such non-text content at 3:1, and light mode currently sits at 3.01:1 — so this
    // assertion is genuinely load-bearing. Any further lightening of the token, or any darkening
    // of a background it sits on, fails here rather than in someone's eyes.
    for (const background of TEXT_BACKGROUNDS) {
      const ratio = contrastRatio(colour(theme, "--prc-fg-subtle"), colour(theme, background));
      assert.ok(ratio >= 3, `--prc-fg-subtle on ${background} is ${ratio.toFixed(2)}:1`);
    }
  });
}

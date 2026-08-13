/**
 * The languages highlighting knows about.
 *
 * An explicit list, not `highlight.js/lib/common` and certainly not the full bundle: every language
 * registered here is bytes the browser downloads before it can show a diff. This set covers what
 * turns up in review; anything else renders as plain text, which is a perfectly good outcome and
 * much better than a megabyte of grammars.
 *
 * Detection is by extension only. `highlight.js` can guess a language from content, and it must not
 * be asked to: a wrong guess re-colours a whole file, and a diff hunk is a fragment with no
 * beginning, which is exactly the input auto-detection is worst at.
 */

/** Extension (lowercase, no dot) → highlight.js language id. */
export const EXTENSION_LANGUAGES = {
  js: "javascript",
  jsx: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  ts: "typescript",
  tsx: "typescript",
  mts: "typescript",
  cts: "typescript",
  json: "json",
  jsonc: "json",
  css: "css",
  scss: "scss",
  less: "less",
  html: "xml",
  htm: "xml",
  xml: "xml",
  svg: "xml",
  vue: "xml",
  md: "markdown",
  markdown: "markdown",
  py: "python",
  pyi: "python",
  go: "go",
  rb: "ruby",
  rake: "ruby",
  java: "java",
  kt: "kotlin",
  kts: "kotlin",
  swift: "swift",
  rs: "rust",
  c: "c",
  h: "c",
  cc: "cpp",
  cpp: "cpp",
  cxx: "cpp",
  hpp: "cpp",
  cs: "csharp",
  php: "php",
  sh: "bash",
  bash: "bash",
  zsh: "bash",
  yml: "yaml",
  yaml: "yaml",
  sql: "sql",
  toml: "ini",
  ini: "ini",
  cfg: "ini",
  diff: "diff",
  patch: "diff",
  dart: "dart",
  lua: "lua",
  pl: "perl",
  r: "r",
  scala: "scala",
  gradle: "groovy",
  groovy: "groovy",
  graphql: "graphql",
  gql: "graphql",
  proto: "protobuf",
};

/** Files with no extension whose name identifies the language. */
export const FILENAME_LANGUAGES = {
  dockerfile: "dockerfile",
  makefile: "makefile",
  gemfile: "ruby",
  rakefile: "ruby",
  brewfile: "ruby",
  "cmakelists.txt": "cmake",
};

/** Every language id the worker must register. */
export const LANGUAGE_IDS = [
  ...new Set([...Object.values(EXTENSION_LANGUAGES), ...Object.values(FILENAME_LANGUAGES)]),
].sort();

/**
 * The language for a path, or null for "render as plain text".
 *
 * @param {string} path
 * @returns {string | null}
 */
export function languageForPath(path) {
  const name = String(path ?? "")
    .split("/")
    .pop()
    ?.toLowerCase();
  if (!name) return null;
  if (Object.hasOwn(FILENAME_LANGUAGES, name)) {
    return FILENAME_LANGUAGES[/** @type {keyof typeof FILENAME_LANGUAGES} */ (name)];
  }
  // `Dockerfile.dev` and `.eslintrc.json` both matter, so try progressively shorter suffixes rather
  // than only the last extension.
  const parts = name.split(".");
  for (let start = 1; start < parts.length; start += 1) {
    const extension = parts.slice(start).join(".");
    if (Object.hasOwn(EXTENSION_LANGUAGES, extension)) {
      return EXTENSION_LANGUAGES[/** @type {keyof typeof EXTENSION_LANGUAGES} */ (extension)];
    }
  }
  // `Dockerfile.dev`: the *first* segment can also name the language.
  const stem = parts[0];
  if (Object.hasOwn(FILENAME_LANGUAGES, stem)) {
    return FILENAME_LANGUAGES[/** @type {keyof typeof FILENAME_LANGUAGES} */ (stem)];
  }
  return null;
}

import { chmod, copyFile, mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as esbuild from "esbuild";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dist = path.join(root, "dist");

const pkg = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));

await mkdir(dist, { recursive: true });

// Pass 1 — the CLI. `packages: "external"` keeps express/open/axi-sdk-js as real
// node_modules requires, exactly like lavish: bundling them would be slower to build and
// would defeat npm's dedupe without buying anything.
await esbuild.build({
  entryPoints: [path.join(root, "bin", "pr-review-canvas.js")],
  outfile: path.join(dist, "cli.mjs"),
  bundle: true,
  packages: "external",
  platform: "node",
  format: "esm",
  target: "node22",
  define: {
    "process.env.PR_REVIEW_CANVAS_BUILD_VERSION": JSON.stringify(pkg.version),
  },
});
await chmod(path.join(dist, "cli.mjs"), 0o755);

// Pass 2 — the browser client. Bundled rather than copied (lavish copies its client and so has
// to live without `import`), because the diff row renderer in src/shared/ must be the SAME code
// the server uses. Two renderers drifting apart would put comments on the wrong lines.
//
// It is written into src/client/ rather than dist/ so the server can serve it straight from the
// source tree in development as well as from the published package.
await esbuild.build({
  entryPoints: [path.join(root, "src", "client", "main.js")],
  outfile: path.join(root, "src", "client", "prc-client.js"),
  bundle: true,
  format: "iife",
  platform: "browser",
  target: "es2022",
  minify: process.env.NODE_ENV === "production",
  sourcemap: process.env.NODE_ENV !== "production",
  legalComments: "none",
});

// Pass 3 — the syntax-highlighting worker, with highlight.js and its grammars vendored in.
//
// IIFE with every grammar inlined, rather than ESM with code splitting. Splitting would load each
// grammar on demand, but it needs chunk files with generated names served from a directory, and the
// asset route deliberately serves a fixed allowlist. The saving it would buy is also close to
// worthless here: this is served from 127.0.0.1, so the bundle's size costs a few milliseconds of
// local disk read exactly once.
await esbuild.build({
  entryPoints: [path.join(root, "src", "worker", "hl-worker.js")],
  outfile: path.join(root, "src", "client", "prc-hl-worker.js"),
  bundle: true,
  format: "iife",
  platform: "browser",
  target: "es2022",
  // Always minified, unlike the client: nobody debugs vendored grammars, and unminified they are
  // several megabytes of regular expressions.
  minify: true,
  legalComments: "none",
});

// Pass 4 — mermaid, alone in its own asset.
//
// 3.3 MB minified, twenty times everything else the browser loads here, and most reviews contain no
// diagram at all. Keeping it out of prc-client.js means the page pays for it only when a ```mermaid
// fence actually appears, and the client fetches this file once and caches the promise.
await esbuild.build({
  entryPoints: [path.join(root, "src", "mermaid", "entry.js")],
  outfile: path.join(root, "src", "client", "prc-mermaid.js"),
  bundle: true,
  format: "iife",
  platform: "browser",
  target: "es2022",
  // Always minified, for the same reason as the grammars: nobody steps through vendored code, and
  // unminified this is over ten megabytes.
  minify: true,
  legalComments: "none",
});

// Static assets. The server locates them relative to its own module URL, which resolves to src/
// when running from source and to dist/ when running the bundled CLI — so both copies must exist.
await mkdir(path.join(dist, "client"), { recursive: true });
await copyFile(path.join(root, "src", "prc.css"), path.join(dist, "prc.css"));
await copyFile(path.join(root, "src", "prc-hl.css"), path.join(dist, "prc-hl.css"));
await copyFile(path.join(root, "src", "client", "prc-client.js"), path.join(dist, "client", "prc-client.js"));
await copyFile(path.join(root, "src", "client", "prc-hl-worker.js"), path.join(dist, "client", "prc-hl-worker.js"));
await copyFile(path.join(root, "src", "client", "prc-mermaid.js"), path.join(dist, "client", "prc-mermaid.js"));

console.log("built dist/cli.mjs and the browser client");

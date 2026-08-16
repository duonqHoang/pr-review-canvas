import js from "@eslint/js";
import prettier from "eslint-config-prettier";
import globals from "globals";

export default [
  // The generated browser bundles are not source. They live under src/ so the server can serve them
  // straight from the source tree in development, which is why they need naming here.
  {
    ignores: [
      "dist/**",
      "src/client/prc-client.js",
      "src/client/prc-workspace.js",
      "src/client/prc-hl-worker.js",
      "src/client/prc-mermaid.js",
    ],
  },
  js.configs.recommended,
  prettier,
  {
    files: ["**/*.js"],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: "module",
      globals: { ...globals.node },
    },
    rules: {
      "no-unused-vars": ["error", { argsIgnorePattern: "^_", caughtErrors: "none" }],
      eqeqeq: ["error", "always", { null: "ignore" }],
      "no-var": "error",
      "prefer-const": "error",
    },
  },
  {
    // Browser-side sources. They must never reach for node globals.
    files: ["src/client/**/*.js", "src/shared/**/*.js", "src/mermaid/**/*.js"],
    languageOptions: { globals: { ...globals.browser } },
  },
  {
    files: ["src/worker/**/*.js"],
    languageOptions: { globals: { ...globals.worker } },
  },
];

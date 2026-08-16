# Contributing

Thanks for helping improve pr-review-canvas. Before starting a substantial change, open an issue so the intended
behaviour and security boundaries can be agreed on first.

## Development

Use Node.js 22 or newer and install the locked dependencies:

```sh
npm ci
```

Run the full repository gate before opening a pull request:

```sh
npm run check
```

The gate builds generated assets, verifies the generated skill, checks lint and formatting, type-checks the JSDoc-typed
JavaScript, and runs the test suite. Do not hand-edit generated files; see `AGENTS.md` for the architecture, invariants,
generated-file map, and test conventions.

## Pull requests

- Keep each pull request focused on one outcome.
- Add a regression test that states what would break without it.
- Preserve the division of responsibility: the human writes review prose; the agent only answers questions and relays
  an explicitly armed review.
- Never include credentials, private pull-request content, or local session data in fixtures or screenshots.
- Use a conventional-commit subject for commits.

For suspected security issues, follow `SECURITY.md` instead of opening a public issue.

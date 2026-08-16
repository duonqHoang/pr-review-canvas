# pr-review-canvas

> pr-review-canvas is an independent open-source project and is not affiliated with or endorsed by GitHub, Inc.
> GitHub is a trademark of GitHub, Inc.

Review a GitHub pull request in a local, GitHub-styled diff canvas — highlight lines to ask your
agent about them inline, draft the review comments yourself, and post the whole review to GitHub in
one atomic call when you click Submit.

Reviewing on github.com means your agent cannot see what you are looking at. Asking your agent in a
terminal means you cannot see the diff. This puts both in one place, and keeps the division of labour
honest: **the agent answers questions, you write the review.**

```
you:   pr-review-canvas 219              → the diff opens in your browser
       (highlight a line, "why does this fall back to loopback?")
agent: pr-review-canvas poll 219         → wakes with your question and the code around it
       (answers; it appears under that line, no reload)
you:   draft comments, pick a verdict, Submit
agent: pr-review-canvas submit 219 --token …   → one POST, review live on GitHub
```

## Requirements

- Node 22 or newer.
- [`gh`](https://cli.github.com) on `PATH` and authenticated: `gh auth login`. Every GitHub call goes
  through it, so the review is posted as whoever you are already signed in as.

## Install

```sh
npx skills add duonqHoang/pr-review-canvas
```

Your agent then invokes the tool itself with `npx -y pr-review-canvas …`, fetching the package on
demand — no global install needed. Installing globally and wiring the SessionStart hook is optional;
it surfaces the tool as ambient context at the start of every session for Claude Code, Codex and
OpenCode:

```sh
npm install -g pr-review-canvas
pr-review-canvas setup hooks   # optional: ambient context, not required
```

Run `setup hooks` against the **installed** binary, not a clone. It only writes hooks when it can
tell it is running as the installed CLI, so `node bin/pr-review-canvas.js setup hooks` from a source
checkout does nothing — and still reports success.

## Use it

```sh
npx -y pr-review-canvas 219                # a PR number, from inside the repository
npx -y pr-review-canvas owner/repo#219     # or a full reference, from anywhere
npx -y pr-review-canvas https://github.com/o/r/pull/219/files
npx -y pr-review-canvas open               # the PR for the current branch
```

A PR opened from a fork always resolves to the **base** repository, because that is where the pull
request and its review comments live.

In the browser:

|                                                    |                                   |
| -------------------------------------------------- | --------------------------------- |
| Click a `+` in the gutter, or press `c`            | Comment on that line              |
| Drag down the gutter, or shift-click a second line | Comment on a range                |
| Press `a`                                          | Ask the agent about the selection |
| `j` / `k`, `n` / `p`, `[` / `]`                    | Move by line, by file, by hunk    |
| `t`                                                | Filter files                      |
| `?`                                                | Every shortcut                    |

### Review several PRs together

A named workspace is a control plane over ordinary PR sessions. Each PR keeps its own diff,
drafts, refresh decisions and single-use submit token; the dashboard only coordinates what needs
attention next.

```sh
pr-review-canvas workspace create release-train owner/repo#21 owner/repo#22
pr-review-canvas workspace open release-train
pr-review-canvas poll --workspace release-train

pr-review-canvas workspace add release-train owner/repo#23
pr-review-canvas workspace relate release-train owner/repo#23 depends-on owner/repo#21
pr-review-canvas workspace remove release-train owner/repo#22
```

The dashboard shows review progress, open questions, drafts, agent findings, session alerts,
declared PR relationships and files changed by more than one PR. Workspace polling orders PRs by
priority, returns at most 20 work items with at most five from one PR, and labels every result with
its PR reference. **Refresh all PRs** re-fetches each open member independently, so one failed fetch
does not stop or alter the others. Removing a PR from a workspace never ends or deletes its review
session.

There is deliberately no batch submit. GitHub has no cross-PR atomic review operation, so every PR
must still be armed and submitted separately.

### Agent findings

An agent may surface a risk without turning it into review prose:

```sh
pr-review-canvas finding add owner/repo#21 \
  --title "Fallback bypasses validation" \
  --severity high --confidence 0.9 \
  --path src/validate.js --side RIGHT --line 84 \
  --body-file -
```

A finding is evidence for the reviewer. It is stored separately from drafts and cannot enter a
GitHub payload. **Write comment** navigates to a commentable anchor and opens an empty composer;
the reviewer still writes every word. Findings retain the head SHA they were based on and are
shown as stale after the PR changes.

You can ask about any line the page shows, including context lines and lines you expanded. You can
only _comment_ where GitHub accepts one, so the `+` appears only there. That asymmetry is why Ask and
Comment are separate actions rather than one gesture that fails at the end.

## Why Submit is a two-step

Clicking **Submit** does not post anything. It _arms_ a submission: the server re-validates every
comment against the diff, then mints a single-use token bound to a digest of exactly the payload you
approved. The agent's next poll receives that token, and `submit --token …` is the only path that
reaches GitHub. The token is consumed before `gh` is spawned, so an agent that retries cannot
double-post.

There is deliberately no `comment`, `approve` or `request-changes` command. An agent cannot post a
review with this tool. It can only send the one you approved, unaltered.

If you run Claude Code with a permission hook on `gh api … --method POST`, note that
`pr-review-canvas submit` will not match it — the arming gate above is the replacement, and it shows
you the verdict, the summary and every comment on its own line before you click. To require a prompt
anyway, add to `~/.claude/settings.json`:

```json
{
  "permissions": {
    "ask": ["Bash(pr-review-canvas submit:*)"]
  }
}
```

`--dry-run` prints the payload plus a copy-pasteable `gh api … --input` command. That command
intentionally does trip the usual hook, so the manual path stays auditable.

## Where your drafts live

`~/.pr-review-canvas/sessions/<key>/`, one directory per pull request:

- `drafts.jsonl` — an append-only journal. Every change is appended here _before_ the state file is
  rewritten, so a crash mid-save loses nothing.
- `session.json` — a fold cache of that journal, written atomically (temp file → `fsync` → rename).
- `submitted/<timestamp>.json` — kept forever, so "what exactly did I post?" is always answerable.

Nothing here is deleted by the tool. `refresh` marks anchors stale rather than dropping comments, and
`end` closes a session without removing it. The same PR opened from two clones is one session,
because a draft belongs to the pull request rather than to a checkout.

## When the author pushes

The page notices and offers a Refresh. `refresh` re-fetches the diff and re-anchors every draft by its
**text**, not by its line number: a push that inserts ten lines above yours leaves the number pointing
at unrelated code, so a surviving line number counts as no evidence at all.

Anything that cannot be placed with certainty is marked stale, which holds it out of the next
submission and shows it with the proposed line for you to accept or reject. Only two outcomes apply
themselves: an anchor that did not move, and a file that was renamed under an otherwise identical
anchor. A comment posted onto code you never read is a worse outcome than a comment that needs one
more click.

## Environment

|                                    |                                                                                                                                                                          |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `PR_REVIEW_CANVAS_PORT`            | Server port. Default 4391; when unset, up to ten ports above it are tried if something else is listening. Setting it is an instruction, so a conflict then fails loudly. |
| `PR_REVIEW_CANVAS_HOST`            | Bind address. Default `127.0.0.1`.                                                                                                                                       |
| `PR_REVIEW_CANVAS_LINK_HOST`       | Hostname written into review links.                                                                                                                                      |
| `PR_REVIEW_CANVAS_ALLOWED_HOSTS`   | Extra allowed `Host` headers; `*` disables the check.                                                                                                                    |
| `PR_REVIEW_CANVAS_STATE_DIR`       | State directory. Default `~/.pr-review-canvas`.                                                                                                                          |
| `PR_REVIEW_CANVAS_IDLE_TIMEOUT_MS` | Idle self-shutdown. `0` or `off` disables it.                                                                                                                            |

The server binds to loopback, rejects unrecognised `Host` headers before any body parser runs,
requires same-origin on every browser-originated mutation, and serves the page under a CSP with no
remote origins at all — no CDN, no fonts, no remote images. The review URL carries a random 128-bit
id rather than the session key, which is only a hash of public data and therefore guessable.

## Develop

```sh
npm install
npm run check     # build, lint, format, typecheck, test
node bin/pr-review-canvas.js 219
```

Tests are `node --test`, with no test framework. The live acceptance tests are opt-in, because they
need a real pull request:

```sh
PRC_LIVE=1 PRC_LIVE_PR=owner/repo#123 node --test test/live-github.test.js
```

They ask GitHub what it actually accepts for each anchor shape, which is the only way to be sure: the
documentation has been wrong about this twice already. Each probe is posted as a `PENDING` review —
a draft nobody but its author can see — and deleted immediately, so nothing is ever published. Use a
scratch PR you own.

## Licence

MIT.

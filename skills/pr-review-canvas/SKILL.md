---
name: pr-review-canvas
description: >-
  Review a GitHub pull request together with the user in a local GitHub-styled canvas: they highlight lines to ask you questions inline and draft their own review comments, then the whole review is posted to GitHub in one atomic call when they approve it. Use ONLY when the user explicitly asks for this canvas — `/pr-review-canvas`, "review canvas", "pr-review-canvas", "open the PR diff in my browser", "let's review this PR together in the canvas". Do NOT use for an ordinary review request such as "review this PR", "review my diff", "review the code", or a security/audit pass — those are reviews you write yourself, with no canvas.
argument-hint: <pull request URL, owner/repo#123, or a PR number>
metadata:
  tags: [github, pull-request, code-review, diff]
  category: development
---

# PR review canvas

Review a GitHub PR in a local GitHub-styled diff canvas: ask your agent inline, draft comments, and submit the whole review with gh.

## How to invoke

Run the tool with `npx -y pr-review-canvas <pr>` — it does not need to be installed globally. If a command's output
shows a follow-up starting with `pr-review-canvas`, run it as `npx -y pr-review-canvas …` instead. In a sandbox where
`npx -y` exits opaquely (for example status 216), use an installed copy directly:
`node "$(npm root -g)/pr-review-canvas/dist/cli.mjs" <pr>` after `npm install -g pr-review-canvas`, or the bare `pr-review-canvas`
bin.

## When to use this skill

- **Use it when** the user named this canvas — `/pr-review-canvas`, "review canvas", "open the PR diff in my browser" — or asked to review a PR _together_ so they can comment on the lines themselves.
- **Not this skill:** "review this PR", "review my diff / branch / code", "what is wrong with this PR", "security review", "audit this file". Those ask for _your_ findings: read the diff and report. No canvas, no server, no browser.
- **If unsure, do the normal review** and offer the canvas in one line — "want the diff in a canvas so you can write the comments?" — rather than opening a session to find out.

## Request

$ARGUMENTS

If the request above names a pull request, open it now with the workflow below. If it is empty, ask
the user which PR they mean, or run `npx -y pr-review-canvas open` to use the one for the current branch.

## Workflow

1. `npx -y pr-review-canvas <pr>` — fetches the diff and opens the review canvas in the user's browser. Give them the
   URL it prints; they may already be looking at it.
2. `npx -y pr-review-canvas poll <pr>` — waits for them. This blocks, silently, until they ask something or click
   Submit. Leave it running.
3. When a question arrives, answer it with
   `npx -y pr-review-canvas answer <pr> --thread <id> --body-file -` and the answer on stdin. Stdin is the documented
   path because an answer contains backticks and code fences, which do not survive a shell argument
   reliably. The answer appears inline under that line of the diff without a reload.
4. When `poll` returns `action: submit_requested`, run `npx -y pr-review-canvas submit <pr> --token <token>`
   immediately. One atomic POST creates the review with every comment the user approved.
5. Poll again if they are still reviewing. `npx -y pr-review-canvas end <pr>` when they are done.

If the user says the author has pushed, run `npx -y pr-review-canvas refresh <pr>`. It re-fetches the diff and
re-checks every draft's anchor; anything it cannot place with certainty is held out of the submission
and surfaced in the browser for the user to accept or reject. Report the list and wait — moving their
comment is their decision, not yours.

## Rules

- **The human writes the review.** Never draft, reword, shorten or improve a review comment. Your job is to answer questions and relay their text to GitHub byte for byte.
- **Only `submit` posts anything**, and only with a token the user minted by clicking Submit in the browser. There is no command that lets you comment, approve or request changes on your own.
- **Never retry a failed submit.** The review POST is atomic, so a failure means nothing was posted. Report the `path:line` it named and wait for the user to fix the anchor in the browser.
- **Do not read the whole diff into your context.** The user reads the diff; you answer the lines they ask about, and each question arrives with the code excerpt already attached.
- **Do not edit files during a review** unless the user asks in so many words. A review is a conversation about a change, not an invitation to make one.
- **Leave the poll running.** It is silent by design and stays open for as long as the user is reading. A poll that returns nothing is working correctly.

## How your reply is rendered

- **Markdown, with two things worth reaching for.** `path:line` or `path:line-line` (for example `src/anchor/drift.js:100-118`) becomes a control that scrolls the diff to that range, so naming lines beats quoting code back. A fenced block tagged `mermaid` is drawn as a diagram — reach for it when a flow or a sequence would otherwise be a paragraph of prose, and the reader can click it open full-size.
- **What is not rendered:** raw HTML, images and tables. Not filtered out — un-representable, by design. A diagram that fails to parse stays a code block, so a malformed one costs the reader nothing.
- **Pass bodies on stdin** with `--body-file -`. An answer that contains backticks or a fence does not survive a shell argument, and both are normal in an answer about code.

## Commands

- `npx -y pr-review-canvas <pr>` — Open or resume a review session for a PR (URL, `owner/repo#123`, or `123` inside the repo).
- `npx -y pr-review-canvas poll <pr>` — Long-poll until the user asks something or clicks Submit.
- `npx -y pr-review-canvas answer <pr> --thread <id>` — Answer one of the user's questions; it appears inline under that line of the diff.
- `npx -y pr-review-canvas submit <pr> --token <t>` — Submit the review the user approved in the browser.
- `npx -y pr-review-canvas refresh <pr>` — Re-fetch after the author pushes and re-check every draft's anchor. Nothing is moved without the user.
- `npx -y pr-review-canvas end <pr>` — End the review session as the agent.
- `npx -y pr-review-canvas server` — Run the local review server (normally spawned automatically).
- `npx -y pr-review-canvas stop` — Shut down the background server.

## Requirements

- `gh` on PATH and authenticated (`gh auth login`). Every GitHub call goes through it, so it uses
  whatever account the user is already signed in as.
- Run the first command from inside the repository when passing a bare PR number, so it can be
  resolved. A full URL or `owner/repo#123` works from anywhere.

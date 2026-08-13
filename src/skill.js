import { BIN, createHomeOutput, DESCRIPTION } from "./cli.js";

/**
 * The installable skill.
 *
 * Generated from `createHomeOutput()` rather than written by hand, and checked in CI, so the skill an
 * agent loads cannot describe a command surface the CLI no longer has. That is the same reason lavish
 * generates its own: a stale skill is worse than none, because it is confidently wrong.
 */

/**
 * The skill's directory name and its frontmatter `name`, which is also its slash command.
 *
 * The same string as the binary on purpose: a skill called `pr-review` reads like *the* review skill and
 * gets loaded for every "review this PR", which is the one request this tool cannot serve.
 */
export const SKILL_NAME = BIN;

/**
 * What an agent matches on to decide this skill applies.
 *
 * Deliberately explicit-only. The canvas inverts who writes the review, so loading it for an ordinary
 * review request leaves the user with a browser tab and no findings.
 */
export const SKILL_DESCRIPTION =
  "Review a GitHub pull request together with the user in a local GitHub-styled canvas: they highlight " +
  "lines to ask you questions inline and draft their own review comments, then the whole review is " +
  "posted to GitHub in one atomic call when they approve it. Use ONLY when the user explicitly asks for " +
  `this canvas — \`/${SKILL_NAME}\`, "review canvas", "${BIN}", "open the PR diff in my browser", ` +
  '"let\'s review this PR together in the canvas". Do NOT use for an ordinary review request such as ' +
  '"review this PR", "review my diff", "review the code", or a security/audit pass — those are reviews ' +
  "you write yourself, with no canvas.";

/** @param {string[]} items */
function bullets(items) {
  return items.map((item) => `- ${item}`).join("\n");
}

/**
 * When this skill applies, restated for an agent that has already loaded it.
 *
 * The frontmatter description is matched before the body is read, and matching is fuzzy. This is the
 * second gate: an agent that got here on a plain "review this PR" is meant to back out before it opens a
 * session, because a canvas nobody asked for is a browser tab and no findings.
 */
export const SKILL_SCOPE = [
  "**Use it when** the user named this canvas — `/" +
    SKILL_NAME +
    '`, "review canvas", "open the PR diff in my browser" — or asked to review a PR _together_ so they ' +
    "can comment on the lines themselves.",
  '**Not this skill:** "review this PR", "review my diff / branch / code", "what is wrong with this PR", ' +
    '"security review", "audit this file". Those ask for _your_ findings: read the diff and report. No ' +
    "canvas, no server, no browser.",
  "**If unsure, do the normal review** and offer the canvas in one line — " +
    '"want the diff in a canvas so you can write the comments?" — rather than opening a session to find out.',
];

/**
 * What the browser does with a reply.
 *
 * Here because the alternative is a feature nobody uses: the panel has rendered mermaid blocks since the
 * diagram work landed, and no agent ever wrote one, for the simple reason that nothing told it to. The same
 * string is in the `next_step` of both answer paths — an agent that reads only the tool output still learns
 * it, and one that reads only the skill does too.
 */
export const RENDERING = [
  "**Markdown, with two things worth reaching for.** `path:line` or `path:line-line` (for example " +
    "`src/anchor/drift.js:100-118`) becomes a control that scrolls the diff to that range, so naming lines " +
    "beats quoting code back. A fenced block tagged `mermaid` is drawn as a diagram — reach for it when a flow or " +
    "a sequence would otherwise be a paragraph of prose, and the reader can click it open full-size.",
  "**What is not rendered:** raw HTML, images and tables. Not filtered out — un-representable, by design. A " +
    "diagram that fails to parse stays a code block, so a malformed one costs the reader nothing.",
  "**Pass bodies on stdin** with `--body-file -`. An answer that contains backticks or a fence does not " +
    "survive a shell argument, and both are normal in an answer about code.",
];

/**
 * The rules that make this tool safe to hand an agent.
 *
 * Stated as prohibitions rather than as description because each one is a failure that has actually
 * happened in a review tool: an agent that "helpfully" rewrites a comment, retries a failed submit,
 * or summarises a diff nobody asked it to read.
 */
export const AGENT_RULES = [
  "**The human writes the review.** Never draft, reword, shorten or improve a review comment. Your job " +
    "is to answer questions and relay their text to GitHub byte for byte.",
  "**Only `submit` posts anything**, and only with a token the user minted by clicking Submit in the " +
    "browser. There is no command that lets you comment, approve or request changes on your own.",
  "**Never retry a failed submit.** The review POST is atomic, so a failure means nothing was posted. " +
    "Report the `path:line` it named and wait for the user to fix the anchor in the browser.",
  "**Do not read the whole diff into your context.** The user reads the diff; you answer the lines they " +
    "ask about, and each question arrives with the code excerpt already attached.",
  "**Do not edit files during a review** unless the user asks in so many words. A review is a " +
    "conversation about a change, not an invitation to make one.",
  "**Leave the poll running.** It is silent by design and stays open for as long as the user is " +
    "reading. A poll that returns nothing is working correctly.",
];

/**
 * Render `skills/<SKILL_NAME>/SKILL.md`.
 *
 * @returns {string} the full file, including YAML frontmatter
 */
export function createSkillMarkdown() {
  const home = createHomeOutput();
  const commands = Object.entries(/** @type {Record<string, string>} */ (home.commands)).map(
    ([usage, what]) => `\`${usage}\` — ${what}`,
  );

  return `---
name: ${SKILL_NAME}
description: ${SKILL_DESCRIPTION}
argument-hint: <pull request URL, owner/repo#123, or a PR number>
metadata:
  tags: [github, pull-request, code-review, diff]
  category: development
---

# PR review canvas

${DESCRIPTION}

## When to use this skill

${bullets(SKILL_SCOPE)}

## Request

$ARGUMENTS

If the request above names a pull request, open it now with the workflow below. If it is empty, ask
the user which PR they mean, or run \`${BIN} open\` to use the one for the current branch.

## Workflow

1. \`${BIN} <pr>\` — fetches the diff and opens the review canvas in the user's browser. Give them the
   URL it prints; they may already be looking at it.
2. \`${BIN} poll <pr>\` — waits for them. This blocks, silently, until they ask something or click
   Submit. Leave it running.
3. When a question arrives, answer it with
   \`${BIN} answer <pr> --thread <id> --body-file -\` and the answer on stdin. Stdin is the documented
   path because an answer contains backticks and code fences, which do not survive a shell argument
   reliably. The answer appears inline under that line of the diff without a reload.
4. When \`poll\` returns \`action: submit_requested\`, run \`${BIN} submit <pr> --token <token>\`
   immediately. One atomic POST creates the review with every comment the user approved.
5. Poll again if they are still reviewing. \`${BIN} end <pr>\` when they are done.

If the user says the author has pushed, run \`${BIN} refresh <pr>\`. It re-fetches the diff and
re-checks every draft's anchor; anything it cannot place with certainty is held out of the submission
and surfaced in the browser for the user to accept or reject. Report the list and wait — moving their
comment is their decision, not yours.

## Rules

${bullets(AGENT_RULES)}

## How your reply is rendered

${bullets(RENDERING)}

## Commands

${bullets(commands)}

## Requirements

- \`gh\` on PATH and authenticated (\`gh auth login\`). Every GitHub call goes through it, so it uses
  whatever account the user is already signed in as.
- Run the first command from inside the repository when passing a bare PR number, so it can be
  resolved. A full URL or \`owner/repo#123\` works from anywhere.
`;
}

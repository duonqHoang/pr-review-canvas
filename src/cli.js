import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { AxiError, installSessionStartHooks, RESERVED_COMMANDS, runAxiCli } from "./axi.js";
import { assertGhReady } from "./gh.js";
import { buildReviewPayload, manualCommandFor, postReplies, postReview } from "./gh-submit.js";
import { fetchExistingThreads, summarizeThreads } from "./gh-threads.js";
import { buildId } from "./build-id.js";
import { baseUrl as defaultBaseUrl, baseUrlFor, clientHost, portFromEnv, resolvePort, serverLogFile } from "./paths.js";
import { canonicalPrString, displayRef, prWebUrl, resolvePrRef, sessionKey } from "./pr-ref.js";
import { serve } from "./server.js";
import {
  ensureServer,
  fetchHealth,
  fetchJson,
  isOurServer,
  killProcessOnPort,
  processOnPort,
  requestShutdown,
  waitForPortFree,
} from "./server-control.js";
import { newAccessId, SessionStore } from "./session-store.js";
import { buildSnapshot } from "./snapshot.js";

export const BIN = "pr-review-canvas";
export const DESCRIPTION =
  "Review a GitHub PR in a local GitHub-styled diff canvas: ask your agent inline, draft comments, and submit the whole review with gh.";

/**
 * What the panel does with a reply, told to the agent every time it is about to write one.
 *
 * Stated here once and used by both answer paths, because a capability the agent is not told about is a
 * capability that does not exist: the diagram renderer shipped and went unused until this string did.
 */
export const RENDER_HINT =
  "Your reply is rendered as markdown. Two things earn their keep: refer to code as `path:line` or " +
  "`path:line-line` (for example `src/anchor/drift.js:100-118`) and the panel turns it into a control that " +
  "scrolls the diff to that range — far more useful than quoting the code back; and a fenced block tagged `mermaid` is " +
  "drawn as a diagram, which is worth it for a flow or a sequence that prose would labour over. " +
  "No raw HTML, images or tables — those are not rendered by design.";

/** Commands the SDK owns. `update` must pass through argv normalization untouched. */
const RESERVED = /** @type {Set<string>} */ (new Set(RESERVED_COMMANDS));

export const VERSION = await resolveVersion();

// ---------------------------------------------------------------------------
// argv helpers. The SDK does no flag parsing at all, so this is ours.
// ---------------------------------------------------------------------------

/** @param {string} token */
export function isValueFlagToken(token) {
  return token.startsWith("--") && token.includes("=") === false;
}

/**
 * First argument that is not a flag and not the value of a preceding value-flag.
 *
 * @param {string[]} args
 * @param {readonly string[]} [valueFlags] flags that consume the next token
 * @returns {string | undefined}
 */
export function firstPositionalArg(args, valueFlags = []) {
  const consumesValue = new Set(valueFlags);
  for (let i = 0; i < args.length; i += 1) {
    const token = args[i];
    if (token === "--") return args[i + 1];
    if (token.startsWith("-")) {
      if (consumesValue.has(token) && !token.includes("=")) i += 1;
      continue;
    }
    return token;
  }
  return undefined;
}

/**
 * Value of `--flag value` or `--flag=value`.
 *
 * @param {string[]} args
 * @param {string} flag
 * @returns {string | undefined}
 */
export function flagValue(args, flag) {
  for (let i = 0; i < args.length; i += 1) {
    const token = args[i];
    if (token === flag) return args[i + 1];
    if (token.startsWith(`${flag}=`)) return token.slice(flag.length + 1);
  }
  return undefined;
}

/** @param {string[]} args @param {string} flag */
export function hasFlag(args, flag) {
  return args.includes(flag);
}

/** Flags whose value is the next token. Needed so `--repo o/r 219` finds `219` positionally. */
export const VALUE_FLAGS = Object.freeze(["--repo", "--port", "--token", "--thread", "--body", "--body-file"]);

/** @param {string} token */
function isVersionFlagToken(token) {
  return token === "-v" || token === "-V" || token === "--version";
}

/**
 * The SDK dispatches on `argv[0]` and rejects anything that starts with `-`, so
 * `pr-review-canvas 219` would be read as an unknown command named "219". Rewrite a
 * non-command leading token into an explicit `open`.
 *
 * `update` and the other SDK built-ins must pass through untouched, otherwise
 * `pr-review-canvas update` becomes `open update`.
 *
 * @param {string[]} argv
 * @param {Set<string>} [knownCommands]
 * @returns {string[]}
 */
export function normalizeArgv(argv, knownCommands = new Set(COMMAND_NAMES)) {
  if (argv.length === 0) return argv;
  const first = argv[0];
  // Top-level `--help`/`--version` belong to the SDK; prepending `open` would silently turn
  // them into the open subcommand's help.
  if (first === "--help" || isVersionFlagToken(first)) return argv;
  if (knownCommands.has(first) || RESERVED.has(first)) return argv;
  return ["open", ...argv];
}

// ---------------------------------------------------------------------------
// Output builders. Each returns a plain object; the SDK renders it as TOON.
// ---------------------------------------------------------------------------

/**
 * The home view. This object is also the single source of truth for the generated SKILL.md,
 * so guidance written here can never drift from what the CLI actually prints.
 *
 * @returns {Record<string, unknown>}
 */
export function createHomeOutput() {
  return {
    version: VERSION,
    commands: {
      [`${BIN} <pr>`]: "Open or resume a review session for a PR (URL, `owner/repo#123`, or `123` inside the repo).",
      [`${BIN} poll <pr>`]: "Long-poll until the user asks something or clicks Submit.",
      [`${BIN} answer <pr> --thread <id>`]:
        "Answer one of the user's questions; it appears inline under that line of the diff.",
      [`${BIN} submit <pr> --token <t>`]: "Submit the review the user approved in the browser.",
      [`${BIN} refresh <pr>`]:
        "Re-fetch after the author pushes and re-check every draft's anchor. Nothing is moved without the user.",
      [`${BIN} end <pr>`]: "End the review session as the agent.",
      [`${BIN} server`]: "Run the local review server (normally spawned automatically).",
      [`${BIN} stop`]: "Shut down the background server.",
    },
    next_step:
      `Run \`${BIN} <pr>\` to open the review canvas, then \`${BIN} poll <pr>\`. Never draft review ` +
      `comments yourself — the human writes them, and this tool relays them verbatim.`,
  };
}

/**
 * @param {object} input
 * @param {import("./pr-ref.js").PrRef} input.ref
 * @param {string} input.resolvedBy
 * @param {string} [input.key]
 * @param {string} [input.url]
 * @param {import("./snapshot.js").Snapshot} [input.snapshot]
 * @param {import("./gh-threads.js").ThreadsSnapshot} [input.threads]
 * @param {import("./session-store.js").Session | null} [input.session]
 * @returns {Record<string, unknown>}
 */
export function createOpenOutput({ ref, resolvedBy, key, url, snapshot, threads, session }) {
  const label = displayRef(ref);
  /** @type {Record<string, unknown>} */
  const output = {
    session: {
      ref: label,
      key: key ?? sessionKey(ref),
      canonical: canonicalPrString(ref),
      resolved_by: resolvedBy,
      ...(url ? { url } : {}),
      ...(session ? { status: session.status } : {}),
    },
    pr: { host: ref.host, owner: ref.owner, repo: ref.repo, number: ref.number, url: prWebUrl(ref) },
  };

  if (snapshot) {
    output.pr = {
      .../** @type {Record<string, unknown>} */ (output.pr),
      title: snapshot.pr.title,
      state: snapshot.pr.state,
      head_sha: snapshot.headSha,
      base_sha: snapshot.baseSha,
      head_ref: snapshot.pr.headRefName,
      base_ref: snapshot.pr.baseRefName,
    };
    output.snapshot = {
      files: snapshot.counts.files,
      additions: snapshot.counts.additions,
      deletions: snapshot.counts.deletions,
      binary_files: snapshot.counts.binary,
      withheld_files: snapshot.counts.withheld,
      unparseable_files: snapshot.counts.degraded,
      ...(snapshot.fileCountCapped ? { truncated: true } : {}),
    };
  }
  if (threads) {
    // Counts only. These are other people's words; the agent has no reason to read them unless the
    // user brings one up.
    output.existing_threads = {
      ...summarizeThreads(threads.threads),
      ...(threads.graphqlAvailable ? {} : { resolved_state_unavailable: true }),
    };
  }
  if (session) {
    output.drafts = {
      comments: session.comments.filter((comment) => comment.state === "draft").length,
      open_questions: session.threads.filter((thread) => thread.status === "open").length,
      queued_replies: session.replies.filter((reply) => reply.state === "draft").length,
      viewed_files: Object.keys(session.viewed).length,
      verdict: session.review.verdict,
    };
  }

  output.next_step =
    `Do not answer the user yet. Run \`${BIN} poll ${label}\` now. It long-polls until the user acts and ` +
    `stays silent the whole time — that is normal, never kill it. Drafted comments do NOT wake the poll; ` +
    `only a question, a message, or the user clicking Submit does. Do not draft review comments yourself: ` +
    `the human owns the review text, and your job is to relay it verbatim.`;
  return output;
}

/**
 * @param {import("./pr-ref.js").PrRef} ref
 * @param {import("./session-store.js").Session} session
 */
export function createUserEndedOutput(ref, session) {
  const label = displayRef(ref);
  return {
    session: { ref: label, key: session.key, status: "user-ended", ended_by: session.endedBy },
    next_step:
      `The user explicitly ended this review from the browser, so it was not reopened. Do not reopen it ` +
      `unless they ask for more review or something genuinely needs their eyes — deliver routine updates in ` +
      `this conversation instead. When reopening is warranted, run \`${BIN} ${label} --reopen\`.`,
  };
}

/**
 * @param {import("./pr-ref.js").PrRef} ref
 * @param {any} response
 * @returns {Record<string, unknown>}
 */
export function createPollOutput(ref, response) {
  const label = displayRef(ref);
  const status = String(response?.status ?? "waiting");

  if (status === "missing") {
    return {
      session: { ref: label, status: "missing" },
      next_step: `That review session no longer exists. Run \`${BIN} ${label}\` to open a new one.`,
    };
  }
  if (status === "ended") {
    return {
      session: { ref: label, status: "ended", ...(response.endedBy ? { ended_by: response.endedBy } : {}) },
      next_step: `The review is over. Stop polling and do not reopen it uninvited — report what was submitted and finish.`,
    };
  }
  if (status === "waiting") {
    return {
      session: { ref: label, status: "waiting" },
      next_step: `No feedback arrived before the optional timeout. Re-run \`${BIN} poll ${label}\` without --timeout-ms to wait indefinitely — queued work is never lost.`,
    };
  }

  const work = Array.isArray(response.work) ? response.work : [];
  const submitRequest = work.find((/** @type {any} */ item) => item.kind === "submit_requested");
  const session = response.session ?? {};
  const questions = Array.isArray(response.questions) ? response.questions : [];
  /** @type {Array<{ kind: string, detail: string }>} */
  const alertList = Array.isArray(response.alerts) ? response.alerts : [];
  /** @type {Array<{ id: string, text: string, at: string }>} */
  const messages = Array.isArray(response.messages) ? response.messages : [];
  // Rides along with whatever else this poll carries rather than pre-empting it: an alert says the
  // session is in trouble, which is context for the work, not a replacement for it.
  const alerts = alertList.length
    ? { session_alerts: alertList.map((alert) => ({ kind: alert.kind, detail: alert.detail })) }
    : {};
  const alertStep = alertList.length ? ` ${alertAdvice(alertList)}` : "";

  if (response.submitStale && !submitRequest && questions.length === 0) {
    // The user clicked Submit, but the arming that click produced is gone — cancelled, expired, or
    // lost with a server restart, since the raw token is deliberately never written to disk. Saying so
    // is the only useful move: there is nothing to submit and nothing the agent can do to recover it.
    return {
      session: { ref: label, status: "feedback" },
      ...alerts,
      submit: { status: "stale" },
      next_step:
        `The user asked to submit, but that request is no longer valid — the review server restarted, ` +
        `or the arming was cancelled or timed out. Nothing was posted and no drafts were lost. Ask them ` +
        `to click Submit again, then run \`${BIN} poll ${label}\`.${alertStep}`,
    };
  }

  if (alertList.length > 0 && work.length === 0 && questions.length === 0) {
    // Nothing to do but say so. Without this branch an alert-only poll would report as generic
    // queued work with an empty list, which reads as a bug in the tool rather than news about the PR.
    return {
      session: { ref: label, status: "feedback" },
      ...alerts,
      next_step: alertAdvice(alertList),
    };
  }

  if (submitRequest) {
    const submit = session.submit ?? {};
    return {
      session: { ref: label, status: "feedback" },
      ...alerts,
      action: "submit_requested",
      submit: {
        verdict: submit.verdict,
        comments: (submit.commentIds ?? []).length,
        head_sha_at_arm: submit.headShaAtArm,
        digest: submit.digest,
        // The token is the only thing that can authorise a submit, and the user minted it by
        // clicking Submit in the browser.
        token: response.token ?? null,
      },
      next_step:
        `Run \`${BIN} submit ${label} --token <token>\` now. Do not alter the comments — the user approved ` +
        `exactly this text. If it fails validation, report the listed path:line back to them and wait for ` +
        `them to fix the anchors in the browser.${alertStep}`,
    };
  }

  if (messages.length > 0) {
    return {
      session: { ref: label, status: "feedback", ...(response.sessionEnded ? { session_ended: true } : {}) },
      ...alerts,
      messages: messages.map((message) => ({ at: message.at, text: message.text })),
      ...(questions.length > 0 ? { questions } : {}),
      counts: pollCounts(session),
      // The reply goes back through the next poll's `--agent-reply`, which is one round trip rather
      // than two commands, and it means the agent is listening again the moment it has answered.
      next_step:
        `The user is talking to you in the chat panel, not about one line. Answer in the same place: run ` +
        `\`${BIN} poll ${label} --agent-reply "<your answer>"\`, which posts the reply and goes straight back ` +
        `to listening. ${RENDER_HINT} ` +
        (questions.length > 0
          ? `There ${questions.length === 1 ? "is also 1 question" : `are also ${questions.length} questions`} on ` +
            `specific lines above; answer those with \`${BIN} answer\` first. `
          : "") +
        `Do NOT draft review comments: the human owns the review text.${alertStep}`,
    };
  }

  if (questions.length > 0) {
    return {
      session: { ref: label, status: "feedback", ...(response.sessionEnded ? { session_ended: true } : {}) },
      ...alerts,
      questions,
      ...(response.questionsDeferred ? { questions_deferred: response.questionsDeferred } : {}),
      counts: pollCounts(session),
      next_step:
        `Answer each question with \`${BIN} answer ${label} --thread <id> --body-file -\` (pass the answer on ` +
        `stdin so backticks and code fences survive). Answer from the code shown — open the permalink or read ` +
        `the file if you need more. ${RENDER_HINT} Do NOT edit files and do NOT draft review comments: the ` +
        `human owns the review text. Then poll again with \`${BIN} poll ${label}\`` +
        (response.questionsDeferred ? ` — ${response.questionsDeferred} more question(s) are waiting.` : ".") +
        alertStep,
    };
  }

  return {
    session: { ref: label, status: "feedback", ...(response.sessionEnded ? { session_ended: true } : {}) },
    ...alerts,
    work: work.map((/** @type {any} */ item) => ({ kind: item.kind, at: item.at, ref: item.ref })),
    next_step: `Handle the queued work above, then poll again with \`${BIN} poll ${label}\`.${alertStep}`,
  };
}

/**
 * What to tell the agent about an alert.
 *
 * Every one of these means the session is in trouble in a way the user cannot see from the review
 * page alone, and none of them is fixable by the agent. So the advice is always the same shape: say
 * it plainly, then wait — not retry, not work around it.
 *
 * @param {Array<{ kind: string, detail: string }>} alerts
 */
export function alertAdvice(alerts) {
  const kinds = new Set(alerts.map((alert) => alert.kind));
  if (kinds.has("pr-merged") || kinds.has("pr-closed")) {
    const merged = kinds.has("pr-merged");
    return (
      `The pull request was ${merged ? "merged" : "closed"}. A review can no longer be posted to it. Tell the user ` +
      `immediately and stop — do not submit, and do not reopen the PR on their behalf. Their drafts are still saved.`
    );
  }
  if (kinds.has("gh-auth-failed")) {
    return (
      "GitHub CLI authentication failed, so nothing can be fetched or posted. Tell the user to run `gh auth login` " +
      "and say that their drafts are safe on disk in the meantime."
    );
  }
  if (kinds.has("snapshot-fetch-failed")) {
    return (
      "Re-fetching the pull request failed, so the diff on screen may be out of date. Report the error to the user " +
      "and wait; the drafts they have already written are unaffected."
    );
  }
  return `Report the session alert above to the user verbatim and wait for them.`;
}

/**
 * Counts only — never bodies. Draft comments are the user's text bound for GitHub, and putting
 * them in front of the model is both pointless and a way for it to start "helping" with them.
 *
 * @param {any} session
 */
function pollCounts(session) {
  /** @type {any[]} */
  const comments = session.comments ?? [];
  /** @type {any[]} */
  const threads = session.threads ?? [];
  return {
    draft_comments: comments.filter((comment) => comment.state === "draft").length,
    open_questions: threads.filter((thread) => thread.status === "open").length,
    viewed_files: Object.keys(session.viewed ?? {}).length,
  };
}

/**
 * @param {import("./pr-ref.js").PrRef} ref
 * @param {{ id: number, state: string, html_url: string, commit_id: string }} review
 * @param {any} claim
 * @param {{ posted: Array<{ id: string, url: string }>, failed: Array<{ id: string, error: string }> }} [replies]
 */
export function createSubmitOutput(ref, review, claim, replies = { posted: [], failed: [] }) {
  const attempted = replies.posted.length + replies.failed.length;
  /** @type {Record<string, unknown>} */
  const output = {
    review: {
      id: review.id,
      state: review.state,
      url: review.html_url,
      commit_id: review.commit_id,
      comments_posted: (claim?.comments ?? []).length,
    },
  };
  if (attempted > 0) {
    // Reported per reply, because each was its own POST. The ones that succeeded are already live on
    // the PR and cannot be undone, so lumping them into one status would hide what actually happened.
    output.replies = { attempted, posted: replies.posted.length, failed: replies.failed.length };
    if (replies.failed.length) output.replies_failed = replies.failed.map((failure) => failure.error);
  }
  const lead = replies.failed.length
    ? `The review is live, but ${replies.failed.length} of ${attempted} replies to existing threads failed. Tell the ` +
      `user exactly which ones, and that the successful ones are already posted and cannot be taken back. `
    : `The review is live on GitHub. Tell the user the verdict and the link, then `;
  output.next_step = `${lead}Run \`${BIN} poll ${displayRef(ref)}\` again if they are still reviewing, or stop if they are done.`;
  return output;
}

/** @param {{ status: string, port: number }} server */
export function createStopOutput(server) {
  return { server };
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

/** @param {string[]} args */
async function openCommand(args) {
  const resolution = await resolvePrRef({
    input: firstPositionalArg(args, VALUE_FLAGS),
    repoFlag: flagValue(args, "--repo"),
    cwd: process.cwd(),
  });
  const ref = resolution.ref;
  const key = sessionKey(ref);

  await assertGhReady();
  const store = new SessionStore();
  const explicitPort = portFromEnv();
  const running = await ensureServer({
    baseUrlFor: (port) => baseUrlFor(port),
    host: clientHost(),
    port: explicitPort ?? resolvePort(),
    // A named port is an instruction: obey it or fail, rather than quietly using a different one.
    ladder: explicitPort === null,
    preferPort: explicitPort === null ? await store.recordedPort() : null,
    version: VERSION,
    build: await buildId().catch(() => ""),
    entry: serverEntry(),
    logFile: serverLogFile(),
    onPortChosen: (port) => store.recordPort(port),
  });
  const base = running.baseUrl;

  const existing = await store.load(key);
  const reopen = hasFlag(args, "--reopen");

  // A session the human explicitly ended is not reopened uninvited: they closed it for a reason,
  // and routine updates belong in the agent's own conversation instead.
  if (existing?.status === "ended" && existing.endedBy === "user" && !reopen) {
    return createUserEndedOutput(ref, existing);
  }

  // Both fetches at once: the diff and the existing conversation are independent, and a review is
  // not usable until both are on screen.
  const [snapshot, threads] = await Promise.all([
    buildSnapshot(ref),
    // Existing threads are context, not the review surface itself, so a failure here degrades the
    // page rather than blocking it.
    fetchExistingThreads(ref).catch((error) => ({
      threads: [],
      fetchedAt: new Date().toISOString(),
      graphqlAvailable: false,
      graphqlError: String(/** @type {{ message?: unknown }} */ (error)?.message || error),
    })),
  ]);
  const accessId = newAccessId();
  const url = `${base}/review/${accessId}`;

  await postJson(`${base}/api/agent/sessions`, {
    ref,
    key,
    accessId,
    url,
    displayRef: displayRef(ref),
    headSha: snapshot.headSha,
    localRepo: process.cwd(),
    reopen: true,
  });
  // Written after the session exists so the page can never render against a missing snapshot.
  await store.saveSnapshot(key, snapshot);
  await store.saveThreads(key, threads);

  if (!hasFlag(args, "--no-open") && !process.env.PR_REVIEW_CANVAS_NO_OPEN) {
    try {
      const { default: open } = await import("open");
      await open(url);
    } catch {
      // A headless environment is fine; the URL is in the output either way.
    }
  }

  return createOpenOutput({ ...resolution, key, url, snapshot, threads, session: await store.load(key) });
}

/** @param {string[]} args */
async function pollCommand(args) {
  const { ref, key, base } = await locateSession(args);
  const timeoutMs = flagValue(args, "--timeout-ms");
  const reply = flagValue(args, "--agent-reply");

  if (reply) {
    await postJson(`${base}/api/agent/sessions/${key}/agent-reply`, { text: reply }).catch(() => {});
  }

  const query = timeoutMs ? `&timeoutMs=${encodeURIComponent(timeoutMs)}` : "";
  // The no-timeout poll writes an immediate stderr banner so it is visibly not hung. stdout stays
  // reserved for the final TOON response.
  if (!timeoutMs) {
    process.stderr.write(
      `Waiting for review feedback on ${displayRef(ref)}. This stays silent until the user acts - do not kill it.\n`,
    );
  }
  const response = /** @type {any} */ (await fetchJson(`${base}/api/agent/poll?key=${key}${query}`));
  return createPollOutput(ref, response);
}

/** @param {string[]} args */
async function submitCommand(args) {
  const { ref, key, base } = await locateSession(args);
  const token = flagValue(args, "--token");
  if (!token) {
    throw new AxiError("`submit` needs the token from the poll response", "VALIDATION_ERROR", [
      `Run \`${BIN} poll ${displayRef(ref)}\` and use the token it reports`,
      "The token exists so that only a submission the user approved in the browser can be sent",
    ]);
  }

  const dryRun = hasFlag(args, "--dry-run");
  // Claiming marks the token consumed BEFORE gh is spawned, so an agent retry loop cannot
  // double-post. A 409 here means the submission was not armed, or was already used.
  //
  // A dry run must NOT consume it: burning the single use to print a preview would leave the real
  // submit unable to proceed and force the user back to the browser to re-approve.
  const claim = /** @type {any} */ (
    await postJson(`${base}/api/agent/sessions/${key}/submit/claim`, { token, dryRun })
  );

  /** @type {ReturnType<typeof buildReviewPayload>} */
  let payload;
  try {
    payload = buildReviewPayload({
      headSha: claim.headSha,
      verdict: claim.verdict,
      body: claim.body,
      comments: claim.comments,
    });
  } catch (error) {
    // Claiming has already consumed the token, so the browser is now waiting on a submission that can
    // never happen. Without telling it, the Submit button stays disabled behind a banner promising
    // something that will never arrive, and only a reload escapes — the same dead end as a lost token.
    // A dry run consumed nothing, so it has nothing to report.
    if (!dryRun) {
      const message = String(/** @type {{ message?: unknown }} */ (error)?.message || error);
      await postJson(`${base}/api/agent/sessions/${key}/submit/result`, { error: message }).catch(() => {});
    }
    throw error;
  }

  /** @type {Array<{ id: string, inReplyTo: number, body: string }>} */
  const replies = claim.replies ?? [];

  if (dryRun) {
    return {
      dry_run: true,
      payload,
      ...(replies.length
        ? {
            replies: replies.map((reply) => ({ in_reply_to: reply.inReplyTo, chars: reply.body.length })),
            replies_note:
              `${replies.length} repl${replies.length === 1 ? "y" : "ies"} to existing threads would be posted ` +
              `after the review, one call each.`,
          }
        : {}),
      manual_command: manualCommandFor(ref, payload),
      next_step:
        `Nothing was posted and the token is still valid. Re-run without --dry-run to submit, or run the ` +
        `manual command above if you want the submission to go through your own approval prompt.`,
    };
  }

  try {
    // Review first, replies second, and the order is load-bearing: the review POST is the atomic
    // part, so a 422 there means nothing has been published. A reply is live the moment it is made.
    const review = await postReview(ref, payload);
    const outcome = replies.length ? await postReplies(ref, replies) : { posted: [], failed: [] };
    await postJson(`${base}/api/agent/sessions/${key}/submit/result`, {
      review,
      commentIds: claim.commentIds,
      posted: outcome.posted,
      failed: outcome.failed,
    });
    return createSubmitOutput(ref, review, claim, outcome);
  } catch (error) {
    const message = String(/** @type {{ message?: unknown }} */ (error)?.message || error);
    await postJson(`${base}/api/agent/sessions/${key}/submit/result`, { error: message }).catch(() => {});
    throw error;
  }
}

/**
 * @param {import("./pr-ref.js").PrRef} ref
 * @param {any} result
 */
export function createAnswerOutput(ref, result) {
  return {
    thread: result?.thread ?? {},
    next_step:
      `The answer is now inline under that line in the user's browser — they did not have to reload. Answer any ` +
      `remaining questions, then run \`${BIN} poll ${displayRef(ref)}\` again to keep listening.`,
  };
}

/** @param {string[]} args */
async function answerCommand(args) {
  const { ref, key, base } = await locateSession(args);
  const threadId = flagValue(args, "--thread");
  if (!threadId) {
    throw new AxiError("`answer` needs the thread id from the poll response", "VALIDATION_ERROR", [
      `Use the \`id\` of the question, e.g. \`${BIN} answer ${displayRef(ref)} --thread q_… --body-file -\``,
    ]);
  }
  const text = await readBodyArg(args);
  const result = await postJson(`${base}/api/agent/sessions/${key}/answer`, { threadId, text });
  return createAnswerOutput(ref, result);
}

/**
 * The answer text, from `--body`, `--body-file <path>`, or `--body-file -` (stdin).
 *
 * stdin is the documented path for a reason: an answer contains backticks, code fences and
 * newlines, and routing that through a shell argument is how quoting bugs turn into mangled
 * answers. Nothing here ever reaches a shell.
 *
 * @param {string[]} args
 * @returns {Promise<string>}
 */
async function readBodyArg(args) {
  const inline = flagValue(args, "--body");
  const file = flagValue(args, "--body-file");
  if (inline !== undefined && file !== undefined) {
    throw new AxiError("Pass either --body or --body-file, not both", "VALIDATION_ERROR", [
      "--body-file - reads the text from stdin",
    ]);
  }
  if (inline !== undefined) return inline;
  if (file === "-") return readStdin();
  if (file !== undefined) {
    try {
      return await readFile(file, "utf8");
    } catch (error) {
      throw new AxiError(`Could not read --body-file ${file}`, "VALIDATION_ERROR", [
        String(/** @type {{ message?: unknown }} */ (error)?.message ?? error),
      ]);
    }
  }
  throw new AxiError("No answer text was given", "VALIDATION_ERROR", [
    'Pass --body "text", or --body-file - to read it from stdin',
  ]);
}

async function readStdin() {
  /** @type {Buffer[]} */
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}

/**
 * Turn a refresh summary into something worth saying out loud.
 *
 * The counts matter more than the head SHAs here: "4 comments need re-anchoring" is actionable by
 * the user, and "the head moved" on its own is not.
 *
 * @param {import("./pr-ref.js").PrRef} ref
 * @param {import("./refresh.js").RefreshSummary} summary
 */
export function createRefreshOutput(ref, summary) {
  const label = displayRef(ref);
  const stale = summary.stale ?? [];
  /** @type {Record<string, unknown>} */
  const output = {
    head: { old: summary.head.old, new: summary.head.new, changed: summary.head.changed },
    files: { changed: summary.files.changedPaths.length, removed: summary.files.removedPaths.length },
    drafts: {
      kept: summary.driftCounts.unchanged,
      needs_review: stale.length,
    },
  };
  if (stale.length > 0) {
    // Named individually: this is the list the user has to work through in the browser, and a bare
    // count would make them hunt for it.
    output.stale = stale.map((entry) => ({
      at: entry.line == null ? entry.path : `${entry.path}:${entry.line}`,
      status: entry.status,
      detail: entry.detail,
    }));
  }
  if ((summary.alerts ?? []).length > 0) {
    output.session_alerts = summary.alerts.map((alert) => ({ kind: alert.kind, detail: alert.detail }));
  }

  if (!summary.head.changed && stale.length === 0) {
    output.next_step =
      `Nothing moved: the head commit is unchanged and every draft still anchors where it did. Tell the user ` +
      `that, then run \`${BIN} poll ${label}\` to keep listening.`;
    return output;
  }
  if (stale.length === 0) {
    output.next_step =
      `The diff was re-fetched and every draft still anchors cleanly. Tell the user the page now shows the new ` +
      `commit, then run \`${BIN} poll ${label}\`.`;
    return output;
  }
  output.next_step =
    `${stale.length} draft comment(s) no longer anchor cleanly and are held out of any submission until the user ` +
    `deals with them in the browser — each one offers the proposed line, or Discard. Report the list above to them ` +
    `verbatim. Do NOT re-anchor or rewrite anything yourself: the comment text is theirs, and moving it is their ` +
    `call. Then run \`${BIN} poll ${label}\`.`;
  return output;
}

/** @param {string[]} args */
async function refreshCommand(args) {
  const { ref, key, base } = await locateSession(args);
  const summary = /** @type {import("./refresh.js").RefreshSummary} */ (
    await postJson(`${base}/api/agent/sessions/${key}/refresh`, {})
  );
  return createRefreshOutput(ref, summary);
}

/** @param {string[]} args */
async function endCommand(args) {
  const { ref, key, base } = await locateSession(args);
  await postJson(`${base}/api/agent/end`, { key });
  return { session: { ref: displayRef(ref), status: "ended", ended_by: "agent" } };
}

/**
 * Resolve the ref and confirm a session exists for it, without re-fetching the diff.
 *
 * @param {string[]} args
 */
async function locateSession(args) {
  const resolution = await resolvePrRef({
    input: firstPositionalArg(args, VALUE_FLAGS),
    repoFlag: flagValue(args, "--repo"),
    cwd: process.cwd(),
  });
  const ref = resolution.ref;
  const key = sessionKey(ref);
  const store = new SessionStore();
  const session = await store.load(key);
  if (!session) {
    throw new AxiError(`No review session for ${displayRef(ref)}`, "NOT_FOUND", [
      `Run \`${BIN} ${displayRef(ref)}\` first to open the review canvas`,
    ]);
  }
  return { ref, key, base: await activeBaseUrl(store), session };
}

/**
 * Where the server for these sessions actually is.
 *
 * The port ladder means it is not necessarily the default one: a run that found 4391 taken records
 * where it went, and every later command has to dial that rather than start a second server holding
 * none of the state. An explicit `PR_REVIEW_CANVAS_PORT` still wins — it is an instruction.
 *
 * @param {SessionStore} store
 */
async function activeBaseUrl(store) {
  const explicit = portFromEnv();
  if (explicit !== null) return baseUrlFor(explicit);
  const recorded = await store.recordedPort();
  return baseUrlFor(recorded ?? resolvePort());
}

/** @param {string} url @param {unknown} body */
async function postJson(url, body) {
  return fetchJson(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body ?? {}),
  });
}

/** Where to re-exec for `server`: the real bin when running from source, else this bundle. */
function serverEntry() {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const fromSource = path.join(here, "..", "bin", `${BIN}.js`);
  return existsSync(fromSource) ? fromSource : fileURLToPath(import.meta.url);
}

/** @param {string[]} args */
async function serverCommand(args) {
  const port = Number(flagValue(args, "--port") ?? resolvePort());
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new AxiError(`Invalid --port value: ${flagValue(args, "--port")}`, "VALIDATION_ERROR", [
      "Pass an integer between 0 and 65535",
    ]);
  }
  const server = await serve({ port, version: VERSION, debug: hasFlag(args, "--verbose") });
  await server.done;
  // Stdout stays empty: this command is a long-running process, not a report.
  return "";
}

/** @param {string[]} args */
async function stopCommand(args) {
  const flagged = flagValue(args, "--port");
  // Same reasoning as `activeBaseUrl`: stopping "the server" has to mean the one that is running,
  // which after a ladder hop is not the default port.
  const port = Number(flagged ?? portFromEnv() ?? (await new SessionStore().recordedPort()) ?? resolvePort());
  const base = `http://${hostForPort()}:${port}`;

  const health = await fetchHealth(base);
  if (!health) return createStopOutput({ status: "not-running", port });
  if (!isOurServer(health)) {
    const found = await processOnPort(port);
    throw new AxiError(`Port ${port} is occupied by a different server`, "SERVER_ERROR", [
      found ? `Listening process: ${found.command}` : "Could not identify the listening process",
      `Set PR_REVIEW_CANVAS_PORT to use a different port`,
    ]);
  }

  await requestShutdown(base);
  let freed = await waitForPortFree(clientHost(), port, 2000);
  if (!freed) {
    await killProcessOnPort(port);
    freed = await waitForPortFree(clientHost(), port, 3000);
  }
  return createStopOutput({ status: freed ? "stopped" : "stopping", port });
}

async function setupCommand(/** @type {string[]} */ args) {
  const target = firstPositionalArg(args);
  if (target !== "hooks") {
    throw new AxiError("Unknown setup target", "VALIDATION_ERROR", [`Run \`${BIN} setup hooks\``]);
  }
  /** @type {string[]} */
  const problems = [];
  installSessionStartHooks({
    marker: BIN,
    binaryNames: [BIN],
    distEntrypoints: ["dist/cli.mjs"],
    onError: (message) => problems.push(message),
  });
  return {
    hooks: { status: problems.length ? "partial" : "installed" },
    ...(problems.length ? { problems } : {}),
    next_step: "Restart your agent session so the new SessionStart hook takes effect.",
  };
}

// ---------------------------------------------------------------------------
// Help
// ---------------------------------------------------------------------------

const TOP_LEVEL_HELP = [
  `${BIN} - ${DESCRIPTION}`,
  "",
  "Usage:",
  `  ${BIN}                       Show status and usage guidance`,
  `  ${BIN} <pr> [--repo o/r]     Open or resume a review session`,
  `  ${BIN} open                  Review the PR for the current branch`,
  `  ${BIN} poll <pr>             Wait for the user's questions or their Submit`,
  `  ${BIN} answer <pr> --thread <id>  Answer one question inline`,
  `  ${BIN} refresh <pr>          Re-fetch after a push and re-check every draft's anchor`,
  `  ${BIN} server                Run the local review server`,
  `  ${BIN} stop                  Shut down the background server`,
  `  ${BIN} setup hooks           Install SessionStart hooks for supported agents`,
  "",
  "A <pr> may be a full PR URL, `owner/repo#123`, `owner/repo/123`, or just `123` when run",
  "inside the repository. A bare invocation shows status instead of resolving anything, so",
  `use \`${BIN} open\` to review whatever PR the current branch belongs to.`,
  "",
  "Environment:",
  "  PR_REVIEW_CANVAS_PORT             Server port (default 4391)",
  "  PR_REVIEW_CANVAS_HOST             Bind address (default 127.0.0.1)",
  "  PR_REVIEW_CANVAS_LINK_HOST        Hostname written into session links",
  "  PR_REVIEW_CANVAS_ALLOWED_HOSTS    Extra allowed Host headers; `*` disables the check",
  "  PR_REVIEW_CANVAS_STATE_DIR        State directory (default ~/.pr-review-canvas)",
  "  PR_REVIEW_CANVAS_IDLE_TIMEOUT_MS  Idle self-shutdown; `0` or `off` disables",
  "",
].join("\n");

/** @type {Record<string, string>} */
const COMMAND_HELP = {
  open: [
    `${BIN} <pr> [--repo owner/repo]`,
    "",
    "Opens or resumes a review session. Accepted <pr> forms:",
    "  https://github.com/owner/repo/pull/123   (any trailing /files or #discussion_r… is fine)",
    "  owner/repo#123",
    "  owner/repo/123",
    "  123                                      (resolved against the current repository)",
    `  (omitted, i.e. \`${BIN} open\`)     (the PR for the current branch)`,
    "",
    "For a PR opened from a fork, the session always resolves to the base repository, because",
    "that is where the pull request and its review comments live.",
    "",
  ].join("\n"),
  answer: [
    `${BIN} answer <pr> --thread <id> (--body "text" | --body-file <path> | --body-file -)`,
    "",
    "Answers one question the user asked on a line of the diff. The answer appears inline under",
    "that line in their browser, without a reload.",
    "",
    "Prefer `--body-file -` and write the answer on stdin: an answer contains backticks, code",
    "fences and newlines, none of which survive a shell argument reliably.",
    "",
    "Thread ids come from `poll`. Answering a thread again is allowed and appends to it.",
    "",
  ].join("\n"),
  refresh: [
    `${BIN} refresh <pr>`,
    "",
    "Re-fetches the pull request and re-checks where every drafted comment now belongs. Run it",
    "when the user says the author has pushed, or when they ask you to.",
    "",
    "Nothing is deleted and nothing is moved on the user's behalf. A draft whose anchor can no",
    "longer be found is marked stale, which holds it out of any submission and surfaces it in the",
    "browser with the proposed line for them to accept or reject. Report the list to them and",
    "wait - the comment text is theirs, and so is the decision about where it goes.",
    "",
  ].join("\n"),
  server: [
    `${BIN} server [--port N] [--verbose]`,
    "",
    "Runs the review server in the foreground. Normally spawned for you.",
    "",
  ].join("\n"),
  stop: [`${BIN} stop [--port N]`, "", "Shuts down the background server on that port.", ""].join("\n"),
  setup: [`${BIN} setup hooks`, "", "Installs SessionStart hooks for supported agent harnesses.", ""].join("\n"),
};

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/** @type {Record<string, (args: string[]) => Promise<string | Record<string, unknown>>>} */
const COMMANDS = {
  open: openCommand,
  poll: pollCommand,
  answer: answerCommand,
  submit: submitCommand,
  refresh: refreshCommand,
  end: endCommand,
  server: serverCommand,
  stop: stopCommand,
  setup: setupCommand,
};

export const COMMAND_NAMES = Object.freeze(Object.keys(COMMANDS));

/** @param {string[]} argv */
export async function run(argv) {
  await runAxiCli({
    description: DESCRIPTION,
    version: VERSION,
    argv: normalizeArgv(argv),
    topLevelHelp: TOP_LEVEL_HELP,
    home: async () => createHomeOutput(),
    commands: COMMANDS,
    getCommandHelp: (command) => COMMAND_HELP[command] ?? null,
  });
}

function hostForPort() {
  const host = clientHost();
  return host.includes(":") ? `[${host}]` : host;
}

/** Build-time constant when bundled; read from package.json when running from source. */
async function resolveVersion() {
  const injected = process.env.PR_REVIEW_CANVAS_BUILD_VERSION;
  if (injected) return injected;
  try {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const pkg = JSON.parse(await readFile(path.join(here, "..", "package.json"), "utf8"));
    return String(pkg.version || "0.0.0");
  } catch {
    return "0.0.0";
  }
}

export { defaultBaseUrl, RESERVED };

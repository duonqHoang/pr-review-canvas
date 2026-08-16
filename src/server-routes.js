import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { anchorForQuestion, normalizeSelection } from "./anchor/anchor.js";
import { buildSuggestion, setSuggestionRange, stripCr } from "./anchor/suggestion.js";
import { describeFailures, validateBatch } from "./anchor/validate.js";
import { expandedLines, expandRange, loadFileLines } from "./expand.js";
import { fetchPullRequest } from "./gh-fetch.js";
import { fetchExistingThreads } from "./gh-threads.js";
import { isSameOriginRequest } from "./host-guard.js";
import { buildQuestionPayload, MAX_QUESTIONS_PER_POLL } from "./qa-excerpt.js";
import { alertForFetchError, raiseAlert, refreshSession } from "./refresh.js";
import { newId, submitDigest } from "./session-store.js";
import { buildSnapshot } from "./snapshot.js";
import { rowsHtml, tableHtml } from "./shared/diff-rows.js";
import { PRERENDER_FILE_COUNT, renderReviewPage, THEMES } from "./views/page.js";
import { renderWorkspacePage } from "./views/workspace-page.js";

/**
 * The route table.
 *
 * The guard policy is the path prefix, not a per-route judgement call — lavish decides
 * same-origin route by route, which is easy to get wrong by omission:
 *
 * - `/api/ui/*`    browser-originated. **Every non-GET requires same-origin.** Addressed by the
 *                  random `accessId`, never by the (guessable) session key.
 * - `/api/agent/*` CLI-originated. Sends no `Origin`, so same-origin cannot apply.
 *
 * A table-driven test asserts the first rule for every registered route, which is what keeps the
 * convention honest as routes are added.
 */

const here = path.dirname(fileURLToPath(import.meta.url));

/** A message this long is a paste accident, not prose; refuse it before it reaches the journal. */
const MAX_MESSAGE_CHARS = 64 * 1024;

/**
 * How long a head check is reused. Long enough that a browser tab on a 90-second timer costs one
 * `gh pr view` a minute at worst, short enough that a push is noticed before a review is finished.
 */
const HEAD_CHECK_TTL_MS = 45_000;

/**
 * One line of detail for an alert. `AxiError` carries its suggestions separately, and the first of
 * them is usually the actionable half ("Run `gh auth login`"), so it is kept.
 *
 * @param {unknown} error
 */
function describeError(error) {
  const message = String(/** @type {{ message?: unknown }} */ (error)?.message || error);
  const first = /** @type {{ suggestions?: unknown }} */ (error)?.suggestions;
  const hint = Array.isArray(first) && first.length > 0 ? `: ${first[0]}` : "";
  return `${message}${hint}`;
}

/** Assets are read from disk on each request; they are small and this keeps dev edits live. */
const ASSETS = {
  "prc.css": { file: "prc.css", type: "text/css; charset=utf-8" },
  "prc-hl.css": { file: "prc-hl.css", type: "text/css; charset=utf-8" },
  "prc-client.js": { file: path.join("client", "prc-client.js"), type: "text/javascript; charset=utf-8" },
  "prc-workspace.js": { file: path.join("client", "prc-workspace.js"), type: "text/javascript; charset=utf-8" },
  "prc-hl-worker.js": { file: path.join("client", "prc-hl-worker.js"), type: "text/javascript; charset=utf-8" },
  // Fetched only when a diagram appears; see scripts/build.js pass 4.
  "prc-mermaid.js": { file: path.join("client", "prc-mermaid.js"), type: "text/javascript; charset=utf-8" },
};

const CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data:",
  "connect-src 'self'",
  // The syntax highlighter runs in a worker, which needs its own directive: `script-src` does not
  // cover worker creation, and without this the diff would silently render unhighlighted.
  "worker-src 'self'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join("; ");

/**
 * The three network calls a route can make, as an injectable set. `serve()` passes these straight
 * through so a server test can exercise refresh end to end without `gh` and without a network.
 *
 * @typedef {object} RouteSeams
 * @property {typeof buildSnapshot} [buildSnapshotImpl]
 * @property {typeof fetchExistingThreads | null} [fetchThreadsImpl] null skips the fetch entirely
 * @property {typeof fetchPullRequest} [fetchPullRequestImpl]
 */

/**
 * @param {object} deps
 * @param {import("express").Express} deps.app
 * @param {import("./session-store.js").SessionStore} deps.store
 * @param {import("./workspace-store.js").WorkspaceStore} deps.workspaceStore
 * @param {import("node:events").EventEmitter} deps.events
 * @param {Set<import("express").Response>} deps.sseClients
 * @param {Map<string, number>} deps.activePolls
 * @param {Set<string>} deps.deliveredWork
 * @param {() => void} deps.refreshIdleTimer
 * @param {string} deps.version
 * @param {(...args: unknown[]) => void} deps.log
 * @param {typeof buildSnapshot} [deps.buildSnapshotImpl] test seam
 * @param {typeof fetchExistingThreads | null} [deps.fetchThreadsImpl] test seam; null skips the fetch
 * @param {typeof fetchPullRequest} [deps.fetchPullRequestImpl] test seam
 */
export function registerRoutes(deps) {
  const { app, store, workspaceStore, events, sseClients, activePolls, deliveredWork, refreshIdleTimer, version, log } =
    deps;
  // The three network calls a route can make. Injected rather than imported at the call site so a
  // server test can exercise refresh end to end without `gh` and without a network.
  const buildSnapshotImpl = deps.buildSnapshotImpl ?? buildSnapshot;
  const fetchThreadsImpl = deps.fetchThreadsImpl === undefined ? fetchExistingThreads : deps.fetchThreadsImpl;
  const fetchPullRequestImpl = deps.fetchPullRequestImpl ?? fetchPullRequest;

  /** @type {Map<string, string>} accessId -> key */
  const accessIndex = new Map();

  /**
   * Armed submit tokens, **in memory only**, keyed by session.
   *
   * The agent needs the raw token — it is the only thing that authorises `submit` — but writing it
   * to disk would undo the reason `session.submit` stores just a hash. Keeping it here means no
   * copy of a live token ever lands in `session.json` or the journal.
   *
   * The cost is honest and small: if the server restarts between the user clicking Submit and the
   * agent's poll picking it up, the arming is lost and the user clicks Submit again.
   *
   * @type {Map<string, string>}
   */
  const armedTokens = new Map();

  /** @param {import("./session-store.js").Session} session */
  const indexAccess = (session) => {
    accessIndex.set(session.accessId, session.key);
    return session;
  };

  /** @param {string} accessId */
  async function sessionByAccess(accessId) {
    const known = accessIndex.get(accessId);
    if (known) return store.load(known);
    // After a server restart the in-memory map is empty; fall back to the on-disk index.
    for (const entry of await store.listSessions()) {
      const record = /** @type {{ accessId?: string, key?: string }} */ (entry);
      if (record.accessId === accessId && record.key) {
        accessIndex.set(accessId, record.key);
        return store.load(record.key);
      }
    }
    return null;
  }

  /** @param {import("express").Request} req */
  const sameOrigin = (req) =>
    isSameOriginRequest({
      origin: /** @type {string | undefined} */ (req.headers.origin),
      referer: /** @type {string | undefined} */ (req.headers.referer),
      protocol: req.protocol,
      host: req.headers.host,
    });

  // Mechanical enforcement of the prefix policy: one middleware, no per-route decisions.
  app.use("/api/ui", (req, res, next) => {
    if (req.method === "GET" || req.method === "HEAD" || sameOrigin(req)) return next();
    log("rejected cross-origin", req.method, req.originalUrl);
    res.status(403).json({ error: "cross-origin request refused" });
  });

  // ---- agent-facing -------------------------------------------------------

  app.post("/api/agent/sessions", async (req, res, next) => {
    try {
      const body = /** @type {any} */ (req.body ?? {});
      const session = indexAccess(
        await store.upsert({
          ref: body.ref,
          key: body.key,
          accessId: body.accessId,
          url: body.url,
          displayRef: body.displayRef,
          headSha: body.headSha,
          localRepo: body.localRepo,
          reopen: body.reopen === true,
        }),
      );
      res.json({ key: session.key, accessId: session.accessId, status: session.status });
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/agent/workspaces", async (req, res, next) => {
    try {
      const name = String(/** @type {any} */ (req.body ?? {}).name ?? "").trim();
      const workspace = await workspaceStore.create(name);
      res.status(201).json(workspace);
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/agent/workspaces/:id/members", async (req, res, next) => {
    try {
      const keys = Array.isArray(/** @type {any} */ (req.body ?? {}).sessionKeys)
        ? /** @type {any} */ (req.body).sessionKeys.map(String)
        : [];
      for (const key of keys) {
        if (!(await store.load(key))) {
          res.status(404).json({ error: `unknown session: ${key}` });
          return;
        }
      }
      const workspace = await workspaceStore.add(req.params.id, keys);
      events.emit("workspace", workspace.id);
      res.json(workspace);
    } catch (error) {
      next(error);
    }
  });

  app.delete("/api/agent/workspaces/:id/members", async (req, res, next) => {
    try {
      const keys = Array.isArray(/** @type {any} */ (req.body ?? {}).sessionKeys)
        ? /** @type {any} */ (req.body).sessionKeys.map(String)
        : [];
      const workspace = await workspaceStore.remove(req.params.id, keys);
      events.emit("workspace", workspace.id);
      res.json(workspace);
    } catch (error) {
      next(error);
    }
  });

  app.put("/api/agent/workspaces/:id/relations", async (req, res, next) => {
    try {
      const body = /** @type {any} */ (req.body ?? {});
      const kind = String(body.kind);
      if (!["depends-on", "supersedes", "alternative-to"].includes(kind)) {
        res.status(422).json({ error: "unknown relationship kind" });
        return;
      }
      const workspace = await workspaceStore.setRelation(req.params.id, {
        from: String(body.from),
        to: String(body.to),
        kind: /** @type {"depends-on" | "supersedes" | "alternative-to"} */ (kind),
      });
      events.emit("workspace", workspace.id);
      res.json(workspace);
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/agent/poll", async (req, res, next) => {
    try {
      const key = String(req.query.key ?? "");
      const timeoutMs =
        req.query.timeoutMs === undefined ? null : Math.max(0, Math.min(Number(req.query.timeoutMs || 0), 2147483647));

      const immediate = await store.takeWork(key);
      if (immediate.status !== "waiting") {
        if (immediate.status === "work") markWorkDelivered(key);
        res.json(await enrichPoll(key, withArmedToken(key, immediate)));
        return;
      }

      // No timeout means stream: write a space immediately and periodically so the connection is
      // visibly alive. Leading whitespace is valid JSON trivia, so `response.json()` still parses.
      const streaming = timeoutMs === null;
      /** @type {NodeJS.Timeout | null} */
      let heartbeat = null;
      if (streaming) {
        res.status(200).type("application/json");
        res.write(" ");
        heartbeat = setInterval(() => {
          if (!res.writableEnded) res.write(" ");
        }, 15_000);
        heartbeat.unref?.();
      }

      setPollActive(key, true);
      refreshIdleTimer();

      let done = false;
      const cleanup = () => {
        if (done) return;
        done = true;
        if (heartbeat) clearInterval(heartbeat);
        if (timer) clearTimeout(timer);
        events.off("work", onWork);
        setPollActive(key, false);
        refreshIdleTimer();
      };
      const respond = async () => {
        if (res.writableEnded || done) return;
        const result = await store.takeWork(key);
        if (result.status === "waiting" && !expired) return;
        if (result.status === "work") markWorkDelivered(key);
        const payload = await enrichPoll(key, withArmedToken(key, result));
        if (streaming) res.end(JSON.stringify(payload));
        else res.json(payload);
        cleanup();
      };
      let expired = false;
      const timer = streaming
        ? null
        : setTimeout(() => {
            expired = true;
            respond().catch(() => cleanup());
          }, timeoutMs ?? 0);
      /** @param {string} changed */
      const onWork = (changed) => {
        if (changed === key) respond().catch(() => cleanup());
      };
      events.on("work", onWork);
      req.on("close", cleanup);
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/agent/workspace-poll", async (req, res, next) => {
    try {
      const workspace = await workspaceStore.get(String(req.query.workspace ?? ""));
      if (!workspace) {
        res.status(404).json({ error: "unknown workspace" });
        return;
      }
      const memberKeys = workspace.members.map((member) => member.sessionKey);
      const timeoutMs =
        req.query.timeoutMs === undefined ? null : Math.max(0, Math.min(Number(req.query.timeoutMs || 0), 2147483647));
      const immediate = await takeWorkspaceWork(workspace);
      if (immediate.status !== "waiting") {
        res.json(immediate);
        return;
      }

      const streaming = timeoutMs === null;
      /** @type {NodeJS.Timeout | null} */
      let heartbeat = null;
      if (streaming) {
        res.status(200).type("application/json");
        res.write(" ");
        heartbeat = setInterval(() => {
          if (!res.writableEnded) res.write(" ");
        }, 15_000);
        heartbeat.unref?.();
      }
      for (const key of memberKeys) setPollActive(key, true);
      refreshIdleTimer();
      let done = false;
      let expired = false;
      const cleanup = () => {
        if (done) return;
        done = true;
        if (heartbeat) clearInterval(heartbeat);
        if (timer) clearTimeout(timer);
        events.off("work", onWork);
        for (const key of memberKeys) setPollActive(key, false);
        refreshIdleTimer();
      };
      const respond = async () => {
        if (res.writableEnded || done) return;
        const result = await takeWorkspaceWork(workspace);
        if (result.status === "waiting" && !expired) return;
        if (streaming) res.end(JSON.stringify(result));
        else res.json(result);
        cleanup();
      };
      const timer = streaming
        ? null
        : setTimeout(() => {
            expired = true;
            respond().catch(() => cleanup());
          }, timeoutMs ?? 0);
      /** @param {string} changed */
      const onWork = (changed) => {
        if (memberKeys.includes(changed)) respond().catch(() => cleanup());
      };
      events.on("work", onWork);
      req.on("close", cleanup);
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/agent/sessions/:key/findings", async (req, res, next) => {
    try {
      const key = String(req.params.key);
      const session = await store.load(key);
      const snapshot = await store.loadSnapshot(key);
      if (!session || !snapshot) {
        res.status(404).json({ error: "unknown session" });
        return;
      }
      const body = /** @type {any} */ (req.body ?? {});
      const title = String(body.title ?? "").trim();
      const detail = String(body.body ?? "").trim();
      const severity = String(body.severity ?? "medium");
      if (!title || !detail || !["low", "medium", "high", "critical"].includes(severity)) {
        res.status(422).json({ error: "finding needs title, body and a valid severity" });
        return;
      }
      let anchor = null;
      if (body.path != null) {
        const file = snapshot.files.find((candidate) => candidate.path === String(body.path));
        if (!file) {
          res.status(422).json({ error: "finding path is not in the current snapshot" });
          return;
        }
        const line = body.line == null ? undefined : Number(body.line);
        if (line !== undefined && (!Number.isInteger(line) || line < 1)) {
          res.status(422).json({ error: "finding line must be a positive integer" });
          return;
        }
        anchor = {
          path: file.path,
          ...(line === undefined ? {} : { line }),
          ...(body.side === "LEFT" || body.side === "RIGHT" ? { side: body.side } : {}),
        };
      }
      const at = new Date().toISOString();
      const finding = {
        id: newId("f"),
        title,
        body: detail,
        severity: /** @type {"low" | "medium" | "high" | "critical"} */ (severity),
        confidence: Math.max(0, Math.min(1, Number(body.confidence ?? 0.5))),
        anchor,
        headSha: snapshot.headSha,
        status: /** @type {const} */ ("open"),
        createdAt: at,
        updatedAt: at,
      };
      const updated = await store.mutate(key, { op: "finding:add", at, payload: { finding } });
      events.emit("sse", key, "finding-added", { finding });
      for (const workspace of await workspaceStore.list()) {
        if (workspace.members.some((member) => member.sessionKey === key)) events.emit("workspace", workspace.id);
      }
      res
        .status(201)
        .json({ finding, counts: { openFindings: updated.findings.filter((item) => item.status === "open").length } });
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/agent/sessions/:key/answer", async (req, res, next) => {
    try {
      const key = String(req.params.key);
      const body = /** @type {any} */ (req.body ?? {});
      const threadId = String(body.threadId ?? "");
      const text = String(body.text ?? "");
      if (!text.trim()) {
        res.status(422).json({ error: "an answer needs some text" });
        return;
      }
      const session = await store.load(key);
      const thread = session?.threads.find((candidate) => candidate.id === threadId);
      if (!session || !thread) {
        res.status(404).json({ error: `unknown thread: ${threadId}` });
        return;
      }
      const at = new Date().toISOString();
      const message = { role: /** @type {const} */ ("agent"), text, at };
      await store.mutate(key, { op: "thread:message", at, payload: { id: threadId, message } });
      // The browser renders this inline under the anchored line without a reload; there is no
      // `reload` event in this protocol at all, because a reload can destroy a half-written review.
      events.emit("sse", key, "qa-answer", { threadId, message });
      res.json({
        thread: {
          id: threadId,
          path: thread.anchor.path,
          line: thread.anchor.kind === "file" ? null : thread.anchor.line,
          answered_at: at,
        },
      });
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/agent/sessions/:key/agent-reply", async (req, res, next) => {
    try {
      const key = String(req.params.key);
      const text = String(/** @type {any} */ (req.body ?? {}).text ?? "").trim();
      if (!text) {
        res.status(422).json({ error: "an agent reply needs some text" });
        return;
      }
      const at = new Date().toISOString();
      const message = { id: newId("m"), role: /** @type {const} */ ("agent"), text, at };
      await store.mutate(key, { op: "chat:add", at, payload: { message } });
      events.emit("sse", key, "chat-message", { message });
      res.json({ status: "posted" });
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/agent/sessions/:key/submit/claim", async (req, res, next) => {
    try {
      const key = String(req.params.key);
      const body = /** @type {any} */ (req.body ?? {});
      const token = String(body.token ?? "");
      const claim = await store.claimSubmit(key, token, { dryRun: body.dryRun === true });
      if (!claim.ok) {
        res.status(409).json({ error: `submission is not claimable: ${claim.reason}`, reason: claim.reason });
        return;
      }
      const snapshot = await store.loadSnapshot(key);
      if (!snapshot) {
        res.status(404).json({ error: "no snapshot for this session" });
        return;
      }
      const session = claim.session;
      const drafts = session.comments.filter((comment) => session.submit.commentIds.includes(comment.id));
      const batch = validateBatch(drafts, snapshot);
      if (!batch.ok) {
        res.status(422).json({ error: "validation failed", failures: describeFailures(drafts, batch.results) });
        return;
      }
      // Replies travel as their own list because they are their own POSTs. The CLI sends them
      // **after** the review: the review is the atomic part, so if it 422s nothing has leaked out
      // yet, whereas a reply takes effect the instant it is made and cannot be taken back.
      const replies = session.replies
        .filter((reply) => session.submit.replyIds.includes(reply.id) && reply.state !== "posted")
        .map((reply) => ({ id: reply.id, inReplyTo: reply.inReplyToCommentId, body: reply.body }));

      res.json({
        verdict: session.submit.verdict,
        body: session.submit.body,
        comments: batch.payload?.comments ?? [],
        commentIds: session.submit.commentIds,
        replies,
        headSha: session.submit.headShaAtArm,
        digest: session.submit.digest,
      });
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/agent/sessions/:key/submit/result", async (req, res, next) => {
    try {
      const key = req.params.key;
      const body = /** @type {any} */ (req.body ?? {});
      const session = await store.recordSubmitResult(key, body);
      if (body.posted?.length || body.failed?.length) {
        await store.mutate(key, {
          op: "reply:results",
          at: new Date().toISOString(),
          payload: { posted: body.posted ?? [], failed: body.failed ?? [] },
        });
      }
      if (body.error) events.emit("sse", key, "submit-failed", { error: String(body.error) });
      else {
        events.emit("sse", key, "review-result", {
          state: body.review?.state ?? "COMMENTED",
          html_url: body.review?.html_url ?? "",
          commentIds: session.submit.commentIds,
          posted: body.posted ?? [],
          failed: body.failed ?? [],
        });
      }
      clearWorkDelivery(key);
      res.json({ status: "recorded" });
    } catch (error) {
      next(error);
    }
  });

  /**
   * The agent's `refresh`. Identical work to the browser's button, on purpose: one implementation
   * means the CLI and the UI cannot disagree about what a draft's anchor now is.
   */
  app.post("/api/agent/sessions/:key/refresh", async (req, res, next) => {
    try {
      const key = String(req.params.key);
      const session = await store.load(key);
      if (!session) {
        res.status(404).json({ error: `unknown session: ${key}` });
        return;
      }
      const outcome = await runRefresh(session, await store.loadSnapshot(key));
      res.json(outcome.summary);
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/agent/end", async (req, res, next) => {
    try {
      const key = String(/** @type {any} */ (req.body ?? {}).key ?? "");
      await store.mutate(key, { op: "session:end", at: new Date().toISOString(), payload: { endedBy: "agent" } });
      events.emit("sse", key, "ended", { endedBy: "agent" });
      res.json({ status: "ended" });
    } catch (error) {
      next(error);
    }
  });

  // ---- browser-facing ----------------------------------------------------

  app.get("/workspace/:accessId", async (req, res, next) => {
    try {
      const workspace = await workspaceStore.get(req.params.accessId);
      if (!workspace) {
        res.status(404).type("text/plain").send("No review workspace for that link.");
        return;
      }
      res.setHeader("content-security-policy", CSP);
      res.setHeader("referrer-policy", "no-referrer");
      res.type("html").send(renderWorkspacePage({ workspace, version }));
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/ui/w/:aid", async (req, res, next) => {
    try {
      const workspace = await workspaceStore.get(req.params.aid);
      if (!workspace) {
        res.status(404).json({ error: "unknown workspace" });
        return;
      }
      res.json(await workspaceSummary(workspace));
    } catch (error) {
      next(error);
    }
  });

  app.put("/api/ui/w/:aid/members/:key/priority", async (req, res, next) => {
    try {
      const workspace = await workspaceStore.get(req.params.aid);
      if (!workspace) {
        res.status(404).json({ error: "unknown workspace" });
        return;
      }
      const updated = await workspaceStore.setPriority(
        workspace.id,
        req.params.key,
        Number(/** @type {any} */ (req.body).priority),
      );
      events.emit("workspace", updated.id);
      res.json(await workspaceSummary(updated));
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/ui/w/:aid/refresh", async (req, res, next) => {
    try {
      const workspace = await workspaceStore.get(req.params.aid);
      if (!workspace) {
        res.status(404).json({ error: "unknown workspace" });
        return;
      }
      const results = await Promise.all(
        workspace.members.map(async (member) => {
          const session = await store.load(member.sessionKey);
          if (!session || session.status === "ended") {
            return { key: member.sessionKey, status: "skipped" };
          }
          try {
            const outcome = await runRefresh(session, await store.loadSnapshot(member.sessionKey));
            return { key: member.sessionKey, ref: session.pr.ref, status: "refreshed", refresh: outcome.summary };
          } catch (error) {
            return {
              key: member.sessionKey,
              ref: session.pr.ref,
              status: "failed",
              error: describeError(error),
            };
          }
        }),
      );
      events.emit("workspace", workspace.id);
      res.json({ results, summary: await workspaceSummary(workspace) });
    } catch (error) {
      next(error);
    }
  });

  app.get("/review/:accessId", async (req, res, next) => {
    try {
      const session = await sessionByAccess(req.params.accessId);
      if (!session) {
        res.status(404).type("text/plain").send("No review session for that link. Re-run pr-review-canvas.");
        return;
      }
      const snapshot = await store.loadSnapshot(session.key);
      if (!snapshot) {
        res.status(409).type("text/plain").send("The diff for this session is missing. Re-run pr-review-canvas.");
        return;
      }
      // The CSP is what replaces the isolation an iframe would have provided.
      res.setHeader("content-security-policy", CSP);
      res.setHeader("referrer-policy", "no-referrer");
      const threads = await store.loadThreads(session.key);
      const requestedWorkspace = String(req.query.workspace ?? "");
      const workspace = requestedWorkspace ? await workspaceStore.get(requestedWorkspace) : null;
      const workspaceContext = workspace?.members.some((member) => member.sessionKey === session.key)
        ? { name: workspace.name, url: `/workspace/${workspace.accessId}` }
        : null;
      res.type("html").send(
        renderReviewPage({
          session,
          snapshot,
          threads,
          clientScript: "/assets/prc-client.js",
          version,
          workspace: workspaceContext,
        }),
      );
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/ui/s/:aid", async (req, res, next) => {
    try {
      const session = await sessionByAccess(req.params.aid);
      if (!session) {
        res.status(404).json({ error: "unknown session" });
        return;
      }
      const existing = await store.loadThreads(session.key);
      res.json({
        session: publicSession(session),
        presence: computePresence(session.key),
        existing: existing ?? { threads: [], graphqlAvailable: true, graphqlError: null },
      });
    } catch (error) {
      next(error);
    }
  });

  app.put("/api/ui/s/:aid/findings/:id/status", async (req, res, next) => {
    try {
      const found = await requireSession(req, res);
      if (!found) return;
      const status = String(/** @type {any} */ (req.body ?? {}).status);
      if (!["acknowledged", "dismissed", "converted"].includes(status)) {
        res.status(422).json({ error: "invalid finding status" });
        return;
      }
      const finding = found.session.findings.find((item) => item.id === req.params.id);
      if (!finding) {
        res.status(404).json({ error: "unknown finding" });
        return;
      }
      const session = await store.mutate(found.session.key, {
        op: "finding:status",
        at: new Date().toISOString(),
        payload: { id: finding.id, status },
      });
      events.emit("sse", session.key, "finding-updated", {
        finding: session.findings.find((item) => item.id === finding.id),
      });
      for (const workspace of await workspaceStore.list()) {
        if (workspace.members.some((member) => member.sessionKey === session.key))
          events.emit("workspace", workspace.id);
      }
      res.json({ finding: session.findings.find((item) => item.id === finding.id) });
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/ui/s/:aid/files/:index", async (req, res, next) => {
    try {
      const session = await sessionByAccess(req.params.aid);
      if (!session) {
        res.status(404).json({ error: "unknown session" });
        return;
      }
      const snapshot = await store.loadSnapshot(session.key);
      const index = Number(req.params.index);
      const file = snapshot?.files[index];
      if (!snapshot || !file) {
        res.status(404).json({ error: "unknown file" });
        return;
      }
      res.json({
        index,
        path: file.path,
        layout: layoutFrom(req.query.layout),
        html: tableHtml(index, file, layoutFrom(req.query.layout)),
      });
    } catch (error) {
      next(error);
    }
  });

  /**
   * Reveal lines around a hunk that the diff does not include.
   *
   * The browser sends `cursorNew` — how far it has already expanded — rather than the server keeping
   * a per-viewer position. Expansions are view state and are deliberately not written to the
   * snapshot, so this route is stateless apart from the blob cache, and two tabs on the same session
   * cannot fight over a shared cursor.
   */
  app.post("/api/ui/s/:aid/expand", async (req, res, next) => {
    try {
      const found = await requireSession(req, res);
      if (!found) return;
      const { session, snapshot } = found;
      const body = /** @type {any} */ (req.body ?? {});
      const file = snapshot.files[Number(body.fileIndex)];
      const hunkIndex = Number(body.hunkIndex);
      const direction = body.direction === "before" ? "before" : "after";
      if (!file || !file.hunks[hunkIndex]) {
        res.status(400).json({ error: "unknown file or hunk" });
        return;
      }
      if (file.degraded) {
        // The same fail-closed rule as everywhere else: a patch we could not account for
        // byte-for-byte does not get to imply where its surrounding lines are.
        res.status(409).json({ error: "this file's diff could not be parsed reliably" });
        return;
      }

      // `typeof`, not `Number(...)`: `Number(null)` is 0 and `Number("")` is 0, both of which pass
      // `Number.isFinite`. The client sends an explicit `cursorNew: null` on the first click of a
      // hunk, so coercing turned "start from the hunk" into "start from line 0" — and expanding above
      // line 0 finds nothing, which is exactly how this looked: a button that did nothing at all.
      const cursorNew = typeof body.cursorNew === "number" && Number.isFinite(body.cursorNew) ? body.cursorNew : null;
      const planned = expandRange(file, hunkIndex, direction, { cursorNew });
      if (!planned) {
        res.json({ rows: "", lines: [], exhausted: true, source: "none" });
        return;
      }

      const { lines, source } = await loadFileLines({
        cacheDir: store.paths(session.key).blobs,
        localRepos: session.localRepos,
        ref: snapshot.ref,
        sha: snapshot.headSha,
        path: file.path,
        // A path that was renamed exists at the head SHA under its NEW name; `previousPath` would
        // 404 here, unlike in a base-side blob link.
      });
      const rows = expandedLines(lines, planned, hunkIndex, direction);
      const layout = layoutFrom(body.layout);
      res.json({
        rows: rowsHtml(Number(body.fileIndex), rows, layout),
        // The numbers as data too, so the client can advance its cursor without parsing the HTML.
        lines: rows.map((line) => ({ oldLine: line.oldLine, newLine: line.newLine })),
        firstNew: rows[0]?.newLine ?? null,
        lastNew: rows.at(-1)?.newLine ?? null,
        // Short of the request means the file ended there; there is nothing more in this direction.
        exhausted: rows.length === 0 || rows.length < planned.endNew - planned.startNew + 1 || planned.boundedByHunk,
        source,
      });
    } catch (error) {
      next(error);
    }
  });

  /**
   * Purely visual preferences. Stored on the server rather than only in the browser because a
   * reviewer who picks split view means it for the review, not for one tab.
   */
  app.put("/api/ui/s/:aid/prefs", async (req, res, next) => {
    try {
      const found = await requireSession(req, res);
      if (!found) return;
      const body = /** @type {any} */ (req.body ?? {});
      const prefs = sanitizePrefs(body.prefs ?? body);
      await store.mutate(found.session.key, { op: "prefs:set", at: new Date().toISOString(), payload: { prefs } });
      res.json({ status: "saved", prefs });
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/ui/s/:aid/comments", async (req, res, next) => {
    try {
      const found = await requireSession(req, res);
      if (!found) return;
      const { session, snapshot } = found;
      const body = /** @type {any} */ (req.body ?? {});
      const file = snapshot.files[Number(body.fileIndex)];
      if (!file) {
        res.status(400).json({ error: "unknown file index" });
        return;
      }

      const requestedSide = String(body.side);
      const requestedLine = Number(body.line);
      const rows = rowsForRange(file, requestedSide, Number(body.startLine ?? body.line), requestedLine);
      if (rows.length === 0) {
        // `rowsForRange` only collects commentable lines, so an empty result means the request
        // pointed outside the diff. Say that, rather than reporting an "empty selection" the user
        // did not make.
        res.status(422).json({
          error:
            `Line ${requestedLine} of \`${file.path}\` is not part of the diff on the ` +
            `${requestedSide === "LEFT" ? "original" : "new"} side, and GitHub only accepts comments on lines that are.`,
        });
        return;
      }
      const normalized = normalizeSelection(rows, file, snapshot.headSha);
      if ("error" in normalized) {
        res.status(422).json({ error: normalized.error });
        return;
      }

      // The suggestion is built here, from the parsed diff, and never taken from the request: the
      // base lines and their hash are the safety mechanism, so the client must not supply them.
      /** @type {import("./anchor/suggestion.js").Suggestion | undefined} */
      let suggestion;
      /** @type {string[]} */
      let suggestionWarnings = [];
      if (body.suggestion) {
        const built = buildSuggestion({
          file,
          side: normalized.anchor.side,
          line: normalized.anchor.line,
          startLine: normalized.anchor.startLine,
          replacementLines: replacementLinesFrom(body.suggestion),
        });
        if ("error" in built) {
          res.status(422).json({ error: built.message, reason: built.error });
          return;
        }
        suggestion = built.suggestion;
        suggestionWarnings = built.warnings;
      }

      // Validate at draft time too, so the UI can refuse immediately rather than at submit.
      const draftId = newId("c");
      const forValidation = { id: draftId, anchor: normalized.anchor, body: String(body.body ?? ""), suggestion };
      const check = validateBatch([forValidation], snapshot);
      if (!check.ok) {
        res.status(422).json({ error: describeFailures([forValidation], check.results)[0] });
        return;
      }

      const at = new Date().toISOString();
      /** @type {import("./session-store.js").DraftComment} */
      const comment = {
        id: draftId,
        anchor: normalized.anchor,
        body: String(body.body ?? ""),
        ...(suggestion ? { suggestion } : {}),
        fromThreadId: typeof body.fromThreadId === "string" ? body.fromThreadId : null,
        state: "draft",
        staleReason: null,
        createdAt: at,
        updatedAt: at,
      };
      // Drafting deliberately does NOT wake the agent: a draft is the human's own writing bound
      // for GitHub, not an instruction for the model.
      await store.mutate(session.key, { op: "comment:add", at, payload: { comment } });
      // Promoting marks the thread, so the UI can show where the comment came from and the counts
      // stop reporting the question as outstanding.
      if (comment.fromThreadId && session.threads.some((thread) => thread.id === comment.fromThreadId)) {
        await store.mutate(session.key, {
          op: "thread:status",
          at,
          payload: { id: comment.fromThreadId, status: "promoted", promotedCommentId: comment.id },
        });
      }
      res.json({
        comment,
        notice: normalized.notice,
        ...(suggestionWarnings.length ? { warnings: suggestionWarnings } : {}),
      });
    } catch (error) {
      next(error);
    }
  });

  /**
   * A free-form message to the agent.
   *
   * Distinct from a question on a line: this one carries no anchor, so it is for the things a diff has
   * no single home for — "what should I look at first?", "does this change the protocol?". It wakes the
   * agent for the same reason a question does, and unlike a draft comment its text is *meant* for the
   * agent rather than for GitHub.
   */
  app.post("/api/ui/s/:aid/messages", async (req, res, next) => {
    try {
      const found = await requireSession(req, res);
      if (!found) return;
      const text = String(/** @type {any} */ (req.body ?? {}).text ?? "").trim();
      if (!text) {
        res.status(422).json({ error: "a message needs some text" });
        return;
      }
      if (text.length > MAX_MESSAGE_CHARS) {
        res.status(413).json({ error: `a message may be at most ${MAX_MESSAGE_CHARS} characters` });
        return;
      }
      const at = new Date().toISOString();
      const message = { id: newId("m"), role: /** @type {const} */ ("user"), text, at };
      await store.mutate(found.session.key, { op: "chat:add", at, payload: { message } });
      // The work item points at the message rather than carrying it: the queue is a list of things to
      // do, and the text lives in one place so an edit or a replay cannot make the two disagree.
      await store.mutate(found.session.key, {
        op: "work:add",
        at,
        payload: { item: { uid: newId("w"), kind: "message", at, ref: message.id } },
      });
      events.emit("work", found.session.key);
      events.emit("sse", found.session.key, "chat-message", { message });
      res.json({ message });
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/ui/s/:aid/questions", async (req, res, next) => {
    try {
      const found = await requireSession(req, res);
      if (!found) return;
      const { session, snapshot } = found;
      const body = /** @type {any} */ (req.body ?? {});
      const file = snapshot.files[Number(body.fileIndex)];
      if (!file) {
        res.status(400).json({ error: "unknown file index" });
        return;
      }
      const text = String(body.body ?? "").trim();
      if (!text) {
        res.status(422).json({ error: "A question needs some text." });
        return;
      }
      if (text.length > MAX_MESSAGE_CHARS) {
        res.status(422).json({ error: "That question is too long to send." });
        return;
      }
      const side = body.side === "LEFT" ? "LEFT" : "RIGHT";
      const to = Number(body.line);
      const from = Number(body.startLine ?? body.line);
      if (!Number.isInteger(to) || !Number.isInteger(from)) {
        res.status(400).json({ error: "a question needs a line number" });
        return;
      }

      // Unlike a draft comment, a question is NOT required to be commentable — see
      // `anchorForQuestion`. So there is no 422 here for a line outside the diff.
      const { anchor, notice } = anchorForQuestion({
        file,
        side,
        from,
        to,
        headSha: snapshot.headSha,
        rows: rowsForRange(file, side, from, to),
      });

      const at = new Date().toISOString();
      /** @type {import("./session-store.js").QaThread} */
      const thread = {
        id: newId("q"),
        anchor,
        messages: [{ role: "user", text, at }],
        status: "open",
        promotedCommentId: null,
        createdAt: at,
      };
      await store.mutate(session.key, { op: "thread:add", at, payload: { thread } });
      await store.mutate(session.key, {
        op: "work:add",
        at,
        payload: { item: { uid: newId("w"), kind: "question", at, ref: thread.id } },
      });
      // A question IS an instruction for the agent, so unlike a draft comment it wakes the poll.
      events.emit("work", session.key);
      events.emit("sse", session.key, "qa-thread", { thread });
      res.json({ thread, notice, presence: computePresence(session.key) });
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/ui/s/:aid/questions/:id/messages", async (req, res, next) => {
    try {
      const found = await requireSession(req, res);
      if (!found) return;
      const { session } = found;
      const id = String(req.params.id);
      const thread = session.threads.find((candidate) => candidate.id === id);
      if (!thread) {
        res.status(404).json({ error: "unknown thread" });
        return;
      }
      if (thread.status === "dismissed") {
        res.status(409).json({ error: "that thread was dismissed" });
        return;
      }
      const text = String(/** @type {any} */ (req.body ?? {}).body ?? "").trim();
      if (!text || text.length > MAX_MESSAGE_CHARS) {
        res.status(422).json({ error: text ? "That message is too long to send." : "A reply needs some text." });
        return;
      }
      const at = new Date().toISOString();
      const message = { role: /** @type {const} */ ("user"), text, at };
      await store.mutate(session.key, { op: "thread:message", at, payload: { id, message } });
      await store.mutate(session.key, {
        op: "work:add",
        at,
        payload: { item: { uid: newId("w"), kind: "question_followup", at, ref: id } },
      });
      events.emit("work", session.key);
      events.emit("sse", session.key, "qa-message", { threadId: id, message });
      res.json({ message, presence: computePresence(session.key) });
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/ui/s/:aid/questions/:id/dismiss", async (req, res, next) => {
    try {
      const found = await requireSession(req, res);
      if (!found) return;
      // Dismissing is bookkeeping, not an instruction: it does not wake the agent. Any question
      // already queued stays queued — dropping work the agent may be mid-answer on would be worse
      // than one redundant answer.
      await store.mutate(found.session.key, {
        op: "thread:status",
        at: new Date().toISOString(),
        payload: { id: String(req.params.id), status: "dismissed" },
      });
      res.json({ status: "dismissed" });
    } catch (error) {
      next(error);
    }
  });

  /**
   * The current lines a suggestion on this range would replace, so the editor opens showing what is
   * actually there.
   *
   * The client cannot derive this from the DOM: a `\r` is invisible there, and the rendered text has
   * been through escaping. Getting the line endings wrong makes GitHub reformat the whole file when
   * the suggestion is applied.
   */
  app.get("/api/ui/s/:aid/suggestion-base/:index", async (req, res, next) => {
    try {
      const found = await requireSession(req, res);
      if (!found) return;
      const file = found.snapshot.files[Number(req.params.index)];
      if (!file) {
        res.status(404).json({ error: "unknown file" });
        return;
      }
      const line = Number(req.query.line);
      const startLine = req.query.startLine === undefined ? undefined : Number(req.query.startLine);
      if (!Number.isInteger(line)) {
        res.status(400).json({ error: "a suggestion needs a line number" });
        return;
      }
      const built = buildSuggestion({ file, side: "RIGHT", line, startLine });
      if ("error" in built) {
        res.status(422).json({ error: built.message, reason: built.error });
        return;
      }
      res.json({
        // Stripped of `\r` for editing; the stored `eol` is what puts it back on the way out.
        lines: stripCr(built.suggestion.baseLines),
        eol: built.suggestion.eol,
        noNewlineAtEof: built.suggestion.noNewlineAtEof ?? false,
        warnings: built.warnings,
      });
    } catch (error) {
      next(error);
    }
  });

  app.patch("/api/ui/s/:aid/comments/:id", async (req, res, next) => {
    try {
      const found = await requireSession(req, res);
      if (!found) return;
      const { session, snapshot } = found;
      const id = String(req.params.id);
      const draft = session.comments.find((comment) => comment.id === id);
      if (!draft) {
        res.status(404).json({ error: "unknown comment" });
        return;
      }
      if (draft.state === "submitted") {
        res.status(409).json({ error: "that comment has already been submitted" });
        return;
      }
      const body = /** @type {any} */ (req.body ?? {});
      const text = body.body === undefined ? draft.body : String(body.body);

      /** @type {Record<string, unknown>} */
      const patch = { body: text };
      /** @type {string[]} */
      const remove = [];
      /** @type {string[]} */
      let warnings = [];

      if ("suggestion" in body) {
        if (body.suggestion === null) {
          remove.push("suggestion");
        } else {
          const file = snapshot.byPath.get(draft.anchor.path);
          if (!file) {
            res.status(422).json({ error: `\`${draft.anchor.path}\` is no longer part of the diff.` });
            return;
          }
          const line = Number(body.suggestion.line ?? (draft.anchor.kind === "line" ? draft.anchor.line : NaN));
          const startLine =
            body.suggestion.startLine !== undefined
              ? Number(body.suggestion.startLine)
              : draft.anchor.kind === "line"
                ? draft.anchor.startLine
                : undefined;
          // Range and suggestion move together or not at all: an anchor and a base hash describing
          // different ranges is precisely the state in which a suggestion rewrites the wrong lines.
          const moved = setSuggestionRange({
            file,
            headSha: snapshot.headSha,
            line,
            startLine,
            replacementLines: replacementLinesFrom(body.suggestion),
          });
          if ("error" in moved) {
            res.status(422).json({ error: moved.message, reason: moved.error });
            return;
          }
          patch.anchor = moved.anchor;
          patch.suggestion = moved.suggestion;
          warnings = moved.warnings;
        }
      }

      const merged = {
        id,
        anchor: /** @type {any} */ (patch.anchor ?? draft.anchor),
        body: text,
        suggestion: /** @type {any} */ (
          remove.includes("suggestion") ? undefined : (patch.suggestion ?? draft.suggestion)
        ),
      };
      const check = validateBatch([merged], snapshot);
      if (!check.ok) {
        res.status(422).json({ error: describeFailures([merged], check.results)[0] });
        return;
      }

      await store.mutate(session.key, {
        op: "comment:update",
        at: new Date().toISOString(),
        payload: { id, patch, ...(remove.length ? { remove } : {}) },
      });
      res.json({ status: "updated", ...(warnings.length ? { warnings } : {}) });
    } catch (error) {
      next(error);
    }
  });

  app.delete("/api/ui/s/:aid/comments/:id", async (req, res, next) => {
    try {
      const found = await requireSession(req, res);
      if (!found) return;
      await store.mutate(found.session.key, {
        op: "comment:delete",
        at: new Date().toISOString(),
        payload: { id: req.params.id },
      });
      res.json({ status: "deleted" });
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/ui/s/:aid/replies", async (req, res, next) => {
    try {
      const found = await requireSession(req, res);
      if (!found) return;
      const { session } = found;
      const body = /** @type {any} */ (req.body ?? {});
      const text = String(body.body ?? "").trim();
      if (!text || text.length > MAX_MESSAGE_CHARS) {
        res.status(422).json({ error: text ? "That reply is too long to send." : "A reply needs some text." });
        return;
      }

      const existing = await store.loadThreads(session.key);
      const thread = (existing?.threads ?? []).find((candidate) => candidate.id === String(body.threadId ?? ""));
      if (!thread) {
        res.status(404).json({ error: "unknown thread" });
        return;
      }
      if (thread.rootCommentId == null) {
        res.status(422).json({ error: "That thread has no comment to reply to." });
        return;
      }

      const at = new Date().toISOString();
      /** @type {import("./session-store.js").DraftReply} */
      const reply = {
        id: newId("r"),
        threadId: thread.id,
        inReplyToCommentId: thread.rootCommentId,
        path: thread.path,
        line: thread.line,
        body: text,
        state: "draft",
        url: null,
        error: null,
        createdAt: at,
        updatedAt: at,
      };
      // Queuing a reply does not wake the agent: like a draft comment, it is the user's own text
      // bound for GitHub.
      await store.mutate(session.key, { op: "reply:add", at, payload: { reply } });
      res.json({ reply });
    } catch (error) {
      next(error);
    }
  });

  app.patch("/api/ui/s/:aid/replies/:id", async (req, res, next) => {
    try {
      const found = await requireSession(req, res);
      if (!found) return;
      const reply = found.session.replies.find((candidate) => candidate.id === String(req.params.id));
      if (!reply) {
        res.status(404).json({ error: "unknown reply" });
        return;
      }
      if (reply.state === "posted") {
        // A reply is posted the moment it is posted; there is no pending state to edit. Say so
        // rather than pretending an edit did something.
        res.status(409).json({ error: "that reply is already live on GitHub" });
        return;
      }
      const text = String(/** @type {any} */ (req.body ?? {}).body ?? "").trim();
      if (!text || text.length > MAX_MESSAGE_CHARS) {
        res.status(422).json({ error: text ? "That reply is too long to send." : "A reply needs some text." });
        return;
      }
      await store.mutate(found.session.key, {
        op: "reply:update",
        at: new Date().toISOString(),
        payload: { id: reply.id, patch: { body: text, state: "draft", error: null } },
      });
      res.json({ status: "updated" });
    } catch (error) {
      next(error);
    }
  });

  app.delete("/api/ui/s/:aid/replies/:id", async (req, res, next) => {
    try {
      const found = await requireSession(req, res);
      if (!found) return;
      const reply = found.session.replies.find((candidate) => candidate.id === String(req.params.id));
      if (reply?.state === "posted") {
        res.status(409).json({ error: "that reply is already live on GitHub" });
        return;
      }
      await store.mutate(found.session.key, {
        op: "reply:delete",
        at: new Date().toISOString(),
        payload: { id: String(req.params.id) },
      });
      res.json({ status: "deleted" });
    } catch (error) {
      next(error);
    }
  });

  app.put("/api/ui/s/:aid/viewed", async (req, res, next) => {
    try {
      const found = await requireSession(req, res);
      if (!found) return;
      const body = /** @type {any} */ (req.body ?? {});
      await store.mutate(found.session.key, {
        op: "viewed:set",
        at: new Date().toISOString(),
        // Keyed by head SHA so a later push un-views files that changed, matching GitHub.
        payload: { path: String(body.path ?? ""), viewed: body.viewed === true, atSha: found.snapshot.headSha },
      });
      res.json({ status: "saved" });
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/ui/s/:aid/submit/arm", async (req, res, next) => {
    try {
      const found = await requireSession(req, res);
      if (!found) return;
      const { session, snapshot } = found;
      const body = /** @type {any} */ (req.body ?? {});
      const verdict = String(body.verdict ?? "COMMENT");
      const summary = String(body.body ?? "");

      // GitHub rejects a COMMENT or REQUEST_CHANGES review with no body, and this is the only place
      // that can say so usefully: the browser is where the summary box is. Leaving it to the CLI mints
      // a token for a payload that can never be posted, and since claiming consumes the token before
      // the payload is built, the single use is burnt on a request that was never viable — arming
      // stays live, the Submit button stays disabled, and nothing tells the user why. That is the same
      // dead-end as a lost token, reached by a different route.
      if (verdict !== "APPROVE" && !summary.trim()) {
        res.status(422).json({
          error: `A ${verdict === "REQUEST_CHANGES" ? "Request changes" : "Comment"} review needs a summary.`,
          field: "body",
        });
        return;
      }

      const drafts = session.comments.filter((comment) => comment.state === "draft");
      const batch = validateBatch(drafts, snapshot);
      if (!batch.ok) {
        // 422 back to the browser BEFORE any token exists: the user fixes the anchors while the
        // agent stays untouched.
        res.status(422).json({
          error: "Some comments are no longer anchored inside the diff.",
          failures: describeFailures(drafts, batch.results),
          invalid: batch.blocking,
        });
        return;
      }

      // The digest is taken over the payload the validator produced, not over a second rendering of
      // the drafts. One rendering path means the text the human approved is provably the text that
      // reaches GitHub — a suggestion block built twice could differ in its fence and change nothing
      // visible while changing the digest.
      const comments = batch.payload?.comments ?? [];
      // Queued replies go into the same digest even though they post separately: the user approved
      // them in the same click, and a digest that ignored them would let a reply be altered between
      // the click and the POST without invalidating the token.
      const replies = session.replies.filter((reply) => reply.state === "draft");
      const digest = submitDigest({ verdict, body: summary, comments, replies });
      await store.mutate(session.key, {
        op: "review:set",
        at: new Date().toISOString(),
        payload: { verdict, body: summary },
      });
      const armed = await store.armSubmit(session.key, {
        verdict: /** @type {any} */ (verdict),
        body: summary,
        commentIds: drafts.map((draft) => draft.id),
        replyIds: replies.map((reply) => reply.id),
        digest,
        headSha: snapshot.headSha,
      });
      // Held in memory for the agent's next poll; never written to disk.
      armedTokens.set(session.key, armed.token);
      await store.mutate(session.key, {
        op: "work:add",
        at: new Date().toISOString(),
        payload: { item: { uid: newId("w"), kind: "submit_requested", at: new Date().toISOString() } },
      });
      events.emit("work", session.key);
      res.json({ status: "armed", comments: drafts.length, replies: replies.length, expiresAt: armed.expiresAt });
    } catch (error) {
      next(error);
    }
  });

  /**
   * Disarm a submission the agent never collected.
   *
   * This exists because of a failure mode with no other exit: the raw token is handed to the agent
   * exactly once and held nowhere else, so if the agent's poll succeeds but the agent then loses the
   * token — a crash, a parse failure, a killed process — the arming is live, unconsumed, and
   * unusable. Without this route the user's only recourse is to reload the page.
   */
  app.post("/api/ui/s/:aid/submit/cancel", async (req, res, next) => {
    try {
      const found = await requireSession(req, res);
      if (!found) return;
      armedTokens.delete(found.session.key);
      await store.mutate(found.session.key, { op: "submit:cancel", at: new Date().toISOString() });
      events.emit("sse", found.session.key, "submit-cancelled", {});
      res.json({ status: "cancelled" });
    } catch (error) {
      next(error);
    }
  });

  /**
   * Has the author pushed?
   *
   * One `gh pr view` per call, throttled per session, and the browser polls it on a slow timer while
   * its tab is visible. The alternative — checking on every mutation — would spend an API call on
   * every keystroke-debounced draft save, and the alternative to *that*, not checking at all, means
   * the user finds out at submit time, after the review is written.
   *
   * A failure here is reported as `unknown` rather than as an error: not knowing whether the head
   * moved is a normal state (offline, rate-limited), and it must not put a red banner over a review
   * that is otherwise fine.
   */
  app.get("/api/ui/s/:aid/head", async (req, res, next) => {
    try {
      const found = await requireSession(req, res);
      if (!found) return;
      const { session } = found;
      const head = await currentHead(session);
      res.json({
        snapshotHeadSha: session.snapshotHeadSha,
        headSha: head.sha,
        changed: head.sha !== null && head.sha !== session.snapshotHeadSha,
        state: head.state,
        checkedAt: head.at,
        stale: head.stale,
      });
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/ui/s/:aid/refresh", async (req, res, next) => {
    try {
      const found = await requireSession(req, res);
      if (!found) return;
      const outcome = await runRefresh(found.session, found.snapshot);
      res.json(outcome.summary);
    } catch (error) {
      next(error);
    }
  });

  /**
   * Accept a proposed re-anchor.
   *
   * The proposal is read from stored state, not from the request body. That is the whole point of
   * the arrangement: the browser says *which* draft to move, never *where* to, so a request cannot
   * relocate a comment to a line the drift cascade never sanctioned.
   */
  app.post("/api/ui/s/:aid/comments/:id/drift/accept", async (req, res, next) => {
    try {
      const found = await requireSession(req, res);
      if (!found) return;
      const { session, snapshot } = found;
      const id = String(req.params.id);
      const comment = session.comments.find((candidate) => candidate.id === id);
      if (!comment) {
        res.status(404).json({ error: `unknown comment: ${id}` });
        return;
      }
      const proposed = comment.proposedAnchor;
      if (!proposed) {
        res.status(409).json({ error: "this comment has no proposed anchor to accept" });
        return;
      }

      /** @type {Record<string, unknown>} */
      const payload = { id, anchor: proposed };

      // A suggestion is welded to its range: its `baseLines` and `baseHash` describe the lines it
      // replaces, so moving the anchor without rebuilding them would leave an edit pointed at code
      // that is no longer there. Rebuild both, or refuse the move outright — a half-applied accept is
      // exactly the state in which a suggestion rewrites the wrong lines.
      if (comment.suggestion) {
        const file = proposed.kind === "file" ? undefined : snapshot.byPath.get(proposed.path);
        if (!file || proposed.kind !== "line") {
          res.status(422).json({ error: "the proposed anchor cannot carry a suggestion" });
          return;
        }
        const rebuilt = setSuggestionRange({
          file,
          headSha: snapshot.headSha,
          line: proposed.line,
          startLine: proposed.startLine,
          replacementLines: comment.suggestion.replacementLines,
        });
        if ("error" in rebuilt) {
          res.status(422).json({ error: rebuilt.message, reason: rebuilt.error });
          return;
        }
        payload.anchor = rebuilt.anchor;
        payload.suggestion = rebuilt.suggestion;
      }

      const updated = await store.mutate(session.key, { op: "drift:accept", at: new Date().toISOString(), payload });
      const saved = updated.comments.find((candidate) => candidate.id === id);
      events.emit("sse", session.key, "drafts", { comments: updated.comments });
      res.json({ comment: saved });
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/ui/s/:aid/comments/:id/drift/dismiss", async (req, res, next) => {
    try {
      const found = await requireSession(req, res);
      if (!found) return;
      const id = String(req.params.id);
      const updated = await store.mutate(found.session.key, {
        op: "drift:dismiss",
        at: new Date().toISOString(),
        payload: { id },
      });
      events.emit("sse", found.session.key, "drafts", { comments: updated.comments });
      res.json({ comment: updated.comments.find((candidate) => candidate.id === id) ?? null });
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/ui/s/:aid/end", async (req, res, next) => {
    try {
      const found = await requireSession(req, res);
      if (!found) return;
      await store.mutate(found.session.key, {
        op: "session:end",
        at: new Date().toISOString(),
        payload: { endedBy: "user" },
      });
      events.emit("work", found.session.key);
      // The agent end route has always pushed this; the browser one had not, so a review ended from
      // the toolbar left every other tab on this session still offering a composer.
      events.emit("sse", found.session.key, "ended", { endedBy: "user" });
      res.json({ status: "ended" });
    } catch (error) {
      next(error);
    }
  });

  // ---- SSE ---------------------------------------------------------------

  app.get("/events/:accessId", async (req, res, next) => {
    try {
      const session = await sessionByAccess(req.params.accessId);
      if (!session) {
        res.status(404).end();
        return;
      }
      const key = session.key;
      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
      });
      sseClients.add(res);
      refreshIdleTimer();

      /** @param {string} event @param {unknown} data */
      const send = (event, data) => {
        if (!res.writableEnded) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      };

      // Handshake, so a browser that reconnects converges without a reload.
      send("state-sync", publicSession(session));
      send("agent-presence", { state: computePresence(key) });

      /** @param {string} changed @param {string} event @param {unknown} data */
      const onSse = (changed, event, data) => {
        if (changed === key) send(event, data);
      };
      /** @param {string} changed @param {string} presence */
      const onPresence = (changed, presence) => {
        if (changed === key) send("agent-presence", { state: presence });
      };
      events.on("sse", onSse);
      events.on("presence", onPresence);

      req.on("close", () => {
        sseClients.delete(res);
        events.off("sse", onSse);
        events.off("presence", onPresence);
        refreshIdleTimer();
      });
    } catch (error) {
      next(error);
    }
  });

  app.get("/workspace-events/:accessId", async (req, res, next) => {
    try {
      const workspace = await workspaceStore.get(req.params.accessId);
      if (!workspace) {
        res.status(404).end();
        return;
      }
      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
      });
      sseClients.add(res);
      refreshIdleTimer();
      res.write(`event: state-sync\ndata: ${JSON.stringify(await workspaceSummary(workspace))}\n\n`);
      /** @param {string} changed */
      const onWorkspace = (changed) => {
        if (changed === workspace.id && !res.writableEnded) res.write("event: workspace-changed\ndata: {}\n\n");
      };
      /** @param {string} changed */
      const onSession = (changed) => {
        if (workspace.members.some((member) => member.sessionKey === changed) && !res.writableEnded) {
          res.write("event: workspace-changed\ndata: {}\n\n");
        }
      };
      events.on("workspace", onWorkspace);
      events.on("sse", onSession);
      events.on("presence", onSession);
      req.on("close", () => {
        sseClients.delete(res);
        events.off("workspace", onWorkspace);
        events.off("sse", onSession);
        events.off("presence", onSession);
        refreshIdleTimer();
      });
    } catch (error) {
      next(error);
    }
  });

  // ---- assets ------------------------------------------------------------

  app.get("/assets/:name", async (req, res, next) => {
    const asset = ASSETS[/** @type {keyof typeof ASSETS} */ (req.params.name)];
    if (!asset) {
      res.status(404).end();
      return;
    }
    try {
      const body = await readFile(path.join(here, asset.file), "utf8");
      res.type(asset.type).send(body);
    } catch (error) {
      if (req.params.name.endsWith(".js")) {
        // A missing bundle must not 500: the page still works without the client, and without the
        // worker it simply renders unhighlighted.
        res.status(404).type(asset.type).send('/* bundle missing - run "npm run build" */');
        return;
      }
      next(error);
    }
  });

  // ---- helpers -----------------------------------------------------------

  /** @param {import("./workspace-store.js").ReviewWorkspace} workspace */
  async function workspaceSummary(workspace) {
    const members = [];
    /** @type {Map<string, string[]>} */
    const paths = new Map();
    for (const member of [...workspace.members].sort(
      (a, b) => a.priority - b.priority || a.addedAt.localeCompare(b.addedAt),
    )) {
      const session = await store.load(member.sessionKey);
      if (!session) continue;
      const snapshot = await store.loadSnapshot(member.sessionKey);
      for (const file of snapshot?.files ?? []) {
        const sessions = paths.get(file.path) ?? [];
        sessions.push(session.key);
        paths.set(file.path, sessions);
      }
      const openQuestions = session.threads.filter((thread) => thread.status === "open").length;
      const openFindings = session.findings.filter((finding) => finding.status === "open").length;
      const staleFindings = session.findings.filter(
        (finding) => finding.status === "open" && finding.headSha !== session.snapshotHeadSha,
      ).length;
      const risk = session.findings
        .filter((finding) => finding.status === "open" && finding.headSha === session.snapshotHeadSha)
        .reduce(
          (counts, finding) => {
            counts[finding.severity] += 1;
            return counts;
          },
          { low: 0, medium: 0, high: 0, critical: 0 },
        );
      const draftComments = session.comments.filter((comment) => comment.state === "draft").length;
      const staleDrafts = session.comments.filter((comment) => comment.state === "stale").length;
      const files = snapshot?.files.length ?? 0;
      const viewedFiles = Object.entries(session.viewed).filter(
        ([, mark]) => !mark.atSha || mark.atSha === session.snapshotHeadSha,
      ).length;
      const nextAction = workspaceNextAction({
        session,
        staleDrafts,
        openQuestions,
        openFindings,
        viewedFiles,
        files,
        draftComments,
      });
      members.push({
        key: session.key,
        ref: session.pr.ref,
        title: snapshot?.pr.title ?? "",
        canvasUrl: `/review/${session.accessId}?workspace=${encodeURIComponent(workspace.accessId)}`,
        priority: member.priority,
        status: session.status,
        files,
        viewedFiles,
        openQuestions,
        openFindings,
        staleFindings,
        risk,
        draftComments,
        staleDrafts,
        alerts: session.alerts.length,
        headMoved: false,
        presence: computePresence(session.key),
        nextAction,
      });
    }
    const totals = members.reduce(
      (sum, member) => ({
        openQuestions: sum.openQuestions + member.openQuestions,
        openFindings: sum.openFindings + member.openFindings,
        draftComments: sum.draftComments + member.draftComments,
      }),
      { openQuestions: 0, openFindings: 0, draftComments: 0 },
    );
    return {
      workspace: { id: workspace.id, accessId: workspace.accessId, name: workspace.name },
      members,
      relations: workspace.relations,
      overlaps: [...paths.entries()]
        .filter(([, sessions]) => new Set(sessions).size > 1)
        .map(([path, sessions]) => ({ path, sessions: [...new Set(sessions)] })),
      totals,
    };
  }

  /** @param {import("./workspace-store.js").ReviewWorkspace} workspace */
  async function takeWorkspaceWork(workspace) {
    const ordered = [...workspace.members].sort(
      (a, b) => a.priority - b.priority || a.addedAt.localeCompare(b.addedAt),
    );
    const sessions = [];
    let remaining = 20;
    for (const member of ordered) {
      if (remaining <= 0) break;
      const result = await store.takeWork(member.sessionKey);
      // Ended and missing sessions stay visible on the dashboard but must not make every workspace
      // poll return immediately forever. Only genuinely queued work belongs in this inbox.
      if (result.status !== "work") continue;
      const deliver = result.work.slice(0, Math.min(5, remaining));
      const deferred = result.work.slice(deliver.length);
      for (const item of deferred) {
        await store.mutate(member.sessionKey, { op: "work:add", at: new Date().toISOString(), payload: { item } });
      }
      result.work = deliver;
      remaining -= deliver.length;
      markWorkDelivered(member.sessionKey);
      const enriched = await enrichPoll(member.sessionKey, withArmedToken(member.sessionKey, result));
      sessions.push({ key: member.sessionKey, ref: enriched.session?.pr?.ref ?? member.sessionKey, result: enriched });
    }
    return sessions.length
      ? { status: "work", workspace: { id: workspace.id, name: workspace.name }, sessions }
      : { status: "waiting", workspace: { id: workspace.id, name: workspace.name }, sessions: [] };
  }

  /**
   * @param {{ session: import("./session-store.js").Session, staleDrafts: number, openQuestions: number,
   *   openFindings: number, viewedFiles: number, files: number, draftComments: number }} input
   */
  function workspaceNextAction(input) {
    if (input.session.status === "ended") return "Review ended";
    if (input.session.alerts.length) return "Resolve session alert";
    if (input.staleDrafts) return "Decide stale anchors";
    if (input.openQuestions) return "Waiting for agent answers";
    if (input.openFindings) return "Triage agent findings";
    if (input.viewedFiles < input.files) return "Continue reviewing files";
    if (input.draftComments) return "Choose verdict and submit";
    return "Ready for final review";
  }

  /**
   * The last head check per session, so a browser tab polling on a timer does not turn into one
   * `gh pr view` per poll. `null` means the check itself failed.
   *
   * @type {Map<string, { sha: string | null, state: string, at: string }>}
   */
  const headChecks = new Map();

  /**
   * @param {import("./session-store.js").Session} session
   * @returns {Promise<{ sha: string | null, state: string, at: string, stale: boolean }>}
   */
  async function currentHead(session) {
    const cached = headChecks.get(session.key);
    if (cached && Date.now() - Date.parse(cached.at) < HEAD_CHECK_TTL_MS) {
      return { ...cached, stale: true };
    }
    const at = new Date().toISOString();
    try {
      const pr = await fetchPullRequestImpl({
        host: session.pr.host,
        owner: session.pr.owner,
        repo: session.pr.repo,
        number: session.pr.number,
      });
      const record = { sha: pr.headSha, state: pr.state, at };
      headChecks.set(session.key, record);
      return { ...record, stale: false };
    } catch (error) {
      log("head check failed", session.key, error);
      // A lost login is worth telling the agent about, because it will also stop the submit at the
      // end. Anything else is just not knowing, which is a normal state — offline, rate-limited, `gh`
      // mid-reauth — and must not put a red banner over a review that is otherwise fine.
      if (alertForFetchError(error) === "gh-auth-failed") {
        if (await raiseAlert(store, session, "gh-auth-failed", describeError(error))) {
          await announceAlerts(session.key, { wake: true });
        }
      }
      // Cached as a failure so a broken network does not mean one `gh` spawn per poll.
      const record = { sha: /** @type {string | null} */ (null), state: "UNKNOWN", at };
      headChecks.set(session.key, record);
      return { ...record, stale: false };
    }
  }

  /**
   * Tell the browser about the session's alerts, and optionally wake the agent.
   *
   * The browser is always told, because that is the only place the *user* finds out — including when
   * an alert is retracted. The agent is woken only for something newly raised: every alert kind means
   * work it is about to attempt cannot succeed, but a refresh that raised nothing is not news.
   *
   * @param {string} key
   * @param {{ wake?: boolean }} [options]
   */
  async function announceAlerts(key, options = {}) {
    const session = await store.load(key);
    if (session) events.emit("sse", key, "session-alerts", { alerts: session.alerts });
    if (options.wake) events.emit("work", key);
  }

  /**
   * Re-fetch, re-anchor, and tell both ends.
   *
   * @param {import("./session-store.js").Session} session
   * @param {import("./snapshot.js").Snapshot | null} previous
   */
  async function runRefresh(session, previous) {
    /** @type {Awaited<ReturnType<typeof refreshSession>>} */
    let outcome;
    try {
      outcome = await refreshSession({ store, session, previous, buildSnapshotImpl, fetchThreadsImpl });
    } catch (error) {
      // A refresh that could not fetch leaves the page showing a diff nobody has re-checked, which is
      // exactly the situation the user cannot detect on their own. Raise it, wake the agent, and let
      // the caller report a failure — silently keeping the stale diff would be worse than saying so.
      const kind = alertForFetchError(error);
      if (kind && (await raiseAlert(store, session, kind, describeError(error))))
        await announceAlerts(session.key, { wake: true });
      throw error;
    }
    headChecks.set(session.key, {
      sha: outcome.snapshot.headSha,
      state: outcome.snapshot.pr.state,
      at: new Date().toISOString(),
    });
    // The browser decides what to do with this; there is no `reload` event in this protocol, because
    // a reload can destroy a half-written review.
    events.emit("sse", session.key, "diff-changed", {
      head: outcome.summary.head,
      changedPaths: outcome.summary.files.changedPaths,
      removedPaths: outcome.summary.files.removedPaths,
      stale: outcome.summary.stale,
      moved: outcome.summary.moved,
    });
    // A moved head deliberately does NOT wake the agent — it is a banner with a button, and waking
    // an agent for it is noise. An alert is different: `pr-merged` means nothing in this session can
    // be posted any more, and the agent needs to stop telling the user otherwise.
    //
    // Announced even when nothing was raised, because a successful fetch *retracts* the recoverable
    // alerts and the browser has to be told that too. Only a new alert wakes the agent.
    await announceAlerts(session.key, { wake: outcome.summary.alerts.length > 0 });
    return outcome;
  }

  /**
   * @param {import("express").Request} req
   * @param {import("express").Response} res
   */
  async function requireSession(req, res) {
    // Express 5 types a route param as `string | string[]` because a pattern can repeat it. Ours
    // cannot, so narrow it here rather than at every call site.
    const session = await sessionByAccess(String(req.params.aid));
    if (!session) {
      res.status(404).json({ error: "unknown session" });
      return null;
    }
    const snapshot = await store.loadSnapshot(session.key);
    if (!snapshot) {
      res.status(409).json({ error: "no snapshot for this session" });
      return null;
    }
    return { session, snapshot };
  }

  /**
   * Attach the armed token when this poll is delivering a `submit_requested` item.
   *
   * Handed over exactly once: the agent is the only party that can act on it, and leaving it in
   * the map after delivery would let a second poll pick up a stale arming.
   *
   * @param {string} key
   * @param {any} result
   */
  function withArmedToken(key, result) {
    if (result?.status !== "work") return result;
    const wantsSubmit = (result.work ?? []).some((/** @type {any} */ item) => item.kind === "submit_requested");
    if (!wantsSubmit) return result;
    const token = armedTokens.get(key);
    if (token) {
      armedTokens.delete(key);
      return { ...result, token };
    }

    // A submit request with no token cannot be carried out, and handing it over anyway is worse than
    // dropping it: the agent would run `submit --token null`, fail, and report that as the user's
    // review being rejected. This happens for a reason that is by design — the raw token lives only in
    // memory, so a server restart between the click and the poll loses it — and the honest answer is
    // to tell the agent the request went stale and let the user click Submit again.
    return {
      ...result,
      work: (result.work ?? []).filter((/** @type {any} */ item) => item.kind !== "submit_requested"),
      submitStale: true,
    };
  }

  /**
   * Attach question payloads to a poll result.
   *
   * Two things happen here that must not move to the client:
   *
   * - the **code excerpt is built and capped server-side** (see qa-excerpt.js). It is the only
   *   unbounded path into the agent's context, so the cap belongs where the snapshot lives, not
   *   where a caller could raise it;
   * - at most `MAX_QUESTIONS_PER_POLL` are delivered and the rest are **re-queued verbatim**. The
   *   agent gets a bounded payload and loses nothing: the next poll picks the remainder up.
   *
   * @param {string} key
   * @param {any} result
   */
  async function enrichPoll(key, result) {
    if (result?.status !== "work") return result;
    /** @type {import("./session-store.js").WorkItem[]} */
    const items = result.work ?? [];

    /** @type {import("./session-store.js").Session} */
    const withChat = result.session;
    // Free-form messages resolve to their text here rather than travelling inside the work item, so
    // the queue stays a list of things to do and the text has exactly one home.
    const messages = items
      .filter((item) => item.kind === "message")
      .map((item) => withChat.chat.find((entry) => entry.id === item.ref))
      .filter((entry) => Boolean(entry))
      .map((entry) => ({
        id: /** @type {any} */ (entry).id,
        text: /** @type {any} */ (entry).text,
        at: /** @type {any} */ (entry).at,
      }));
    const enriched = messages.length > 0 ? { ...result, messages } : result;

    const questionItems = items.filter((item) => item.kind === "question" || item.kind === "question_followup");
    if (questionItems.length === 0) return enriched;

    const deliver = questionItems.slice(0, MAX_QUESTIONS_PER_POLL);
    const deferred = questionItems.slice(MAX_QUESTIONS_PER_POLL);
    for (const item of deferred) {
      // Re-queued with its original uid: this is the same piece of work, just not this round.
      await store.mutate(key, { op: "work:add", at: new Date().toISOString(), payload: { item } });
    }

    const snapshot = await store.loadSnapshot(key);
    /** @type {import("./session-store.js").Session} */
    const session = result.session;
    /** @type {Array<Record<string, unknown>>} */
    const questions = [];
    for (const item of deliver) {
      const thread = session.threads.find((candidate) => candidate.id === item.ref);
      if (!thread || !snapshot) continue;
      questions.push(
        buildQuestionPayload({ snapshot, thread, kind: /** @type {"question" | "question_followup"} */ (item.kind) }),
      );
    }
    return { ...enriched, questions, ...(deferred.length ? { questionsDeferred: deferred.length } : {}) };
  }

  /** @param {string} key */
  function computePresence(key) {
    if ((activePolls.get(key) ?? 0) > 0) return "listening";
    if (deliveredWork.has(key)) return "working";
    return "waiting";
  }

  /** @param {string} key @param {boolean} active */
  function setPollActive(key, active) {
    const before = computePresence(key);
    const count = activePolls.get(key) ?? 0;
    if (active) {
      activePolls.set(key, count + 1);
      // A newly attached poll ends the "working" state: the agent is back and listening.
      deliveredWork.delete(key);
    } else if (count <= 1) activePolls.delete(key);
    else activePolls.set(key, count - 1);
    const after = computePresence(key);
    if (before !== after) events.emit("presence", key, after);
  }

  /** @param {string} key */
  function markWorkDelivered(key) {
    const before = computePresence(key);
    deliveredWork.add(key);
    const after = computePresence(key);
    if (before !== after) events.emit("presence", key, after);
  }

  /** @param {string} key */
  function clearWorkDelivery(key) {
    const before = computePresence(key);
    deliveredWork.delete(key);
    const after = computePresence(key);
    if (before !== after) events.emit("presence", key, after);
  }

  return { accessIndex, indexAccess, computePresence };
}

/**
 * What the browser is allowed to see. Excludes the submit token hash and anything else that is
 * not the user's own content.
 *
 * @param {import("./session-store.js").Session} session
 */
export function publicSession(session) {
  return {
    key: session.key,
    accessId: session.accessId,
    pr: session.pr,
    status: session.status,
    endedBy: session.endedBy,
    comments: session.comments,
    threads: session.threads,
    replies: session.replies,
    // The whole transcript. It used to be only the last agent note, on the reasoning that the page had
    // no conversation to replay — it does now, and a chat the page cannot reload is a chat the user
    // loses. The banner's "latest agent note" is derived from this in the client rather than sent
    // twice, so the two cannot disagree.
    chat: session.chat,
    review: session.review,
    viewed: session.viewed,
    prefs: session.prefs,
    alerts: session.alerts,
    findings: session.findings,
    prerenderCount: PRERENDER_FILE_COUNT,
  };
}

/**
 * The layout a request asked for, defaulting to unified.
 *
 * Narrowed against a fixed pair rather than passed through, because the value ends up choosing a
 * column count — an unrecognised one would render a table whose rows and `<colgroup>` disagree.
 *
 * The type check is not decoration: Express types a query parameter as `string | string[]`, and
 * `String(["split"])` is `"split"`, so stringifying first would quietly accept a shape this code has
 * not reasoned about.
 *
 * @param {unknown} value
 * @returns {import("./shared/diff-rows.js").Layout}
 */
export function layoutFrom(value) {
  return value === "split" ? "split" : "unified";
}

/**
 * Keep preferences to a known set of known shapes.
 *
 * `prefs` is the one part of session state the browser writes freely, and it is merged rather than
 * replaced, so an unvalidated write would let a stray key accumulate on disk forever.
 *
 * @param {unknown} input
 * @returns {Record<string, unknown>}
 */
export function sanitizePrefs(input) {
  const source = /** @type {Record<string, unknown>} */ (input ?? {});
  /** @type {Record<string, unknown>} */
  const out = {};
  if ("layout" in source) out.layout = layoutFrom(source.layout);
  // Narrowed to the three the page can render. An unknown value would be stamped straight onto
  // <html> on the next load, where it matches no rule and silently reads as light.
  if ("theme" in source) out.theme = THEMES.includes(String(source.theme)) ? String(source.theme) : "system";
  for (const flag of ["wrap", "showWs", "highlight", "hideViewed"]) {
    if (flag in source) out[flag] = source[flag] === true;
  }
  if ("tabSize" in source) {
    const size = Number(source.tabSize);
    out.tabSize = Number.isFinite(size) ? Math.min(8, Math.max(1, Math.round(size))) : 8;
  }
  return out;
}

/**
 * The replacement lines from a request, or undefined to mean "prefill from the current code".
 *
 * A missing `replacementLines` and an empty array are different requests: the first opens the editor
 * on what is there, the second is a deletion. Coercing one into the other would silently turn a
 * prefill into "delete these lines".
 *
 * @param {any} input
 * @returns {string[] | undefined}
 */
export function replacementLinesFrom(input) {
  if (!input || !Array.isArray(input.replacementLines)) return undefined;
  return input.replacementLines.map((/** @type {unknown} */ line) => String(line ?? ""));
}

/**
 * Collect the rows a `[from, to]` selection covers on one side, so `normalizeSelection` can build
 * the anchor from real diff lines rather than from bare numbers.
 *
 * @param {import("./diff/model.js").ParsedFile} file
 * @param {string} side
 * @param {number} from
 * @param {number} to
 * @returns {import("./anchor/anchor.js").SelectedRow[]}
 */
export function rowsForRange(file, side, from, to) {
  const low = Math.min(from, to);
  const high = Math.max(from, to);
  /** @type {import("./anchor/anchor.js").SelectedRow[]} */
  const rows = [];
  for (const hunk of file.hunks) {
    for (const line of hunk.lines) {
      const number = side === "LEFT" ? line.oldLine : line.newLine;
      if (number == null || number < low || number > high) continue;
      if (!line.commentableSides.includes(/** @type {any} */ (side))) continue;
      rows.push({ key: line.key, kind: line.kind, oldLine: line.oldLine, newLine: line.newLine, origin: line.origin });
    }
  }
  return rows;
}

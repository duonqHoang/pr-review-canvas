import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { mkdir, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { canAutoAccept, describeDrift } from "./anchor/drift.js";
import { appendJsonl, readJsonl, readJsonOr, writeJsonAtomic } from "./atomic-json.js";
import { indexFile, sessionDir, stateDir } from "./paths.js";

/**
 * Session state on disk.
 *
 * The design diverges from lavish deliberately, and the reason is worth stating plainly: lavish
 * keeps every session in one `state.json` and rewrites the whole file on each mutation,
 * non-atomically. For a transient prompt queue that is fine. Here a session holds review prose
 * that exists nowhere else and may have taken half an hour to write, so:
 *
 * - **per-session directories**, so one session's corruption cannot take out another's, and a
 *   multi-megabyte snapshot rewrite never touches the drafts;
 * - **atomic writes** everywhere (see atomic-json.js);
 * - **an append-only journal**. Every mutation appends one op *before* `session.json` is
 *   rewritten. `session.json` is only a fold cache: on load we read it, then replay any op whose
 *   `seq` is newer. A crash between the append and the rewrite therefore loses nothing, and a
 *   missing or unparseable `session.json` is fully recoverable;
 * - **per-key serialization**, not one global promise chain — a slow snapshot write for one PR
 *   must not block a draft save for another.
 */

export const SESSION_SCHEMA_VERSION = 1;
const SUBMIT_TOKEN_TTL_MS = 10 * 60_000;
const JOURNAL_COMPACT_THRESHOLD = 5000;

/**
 * Lock name for the shared index. Contains a character that cannot appear in a session key
 * (keys are 16 lowercase hex digits), so it can never collide with one.
 */
const INDEX_LOCK = "@index";

/** @typedef {"open" | "feedback" | "ended"} SessionStatus */
/** @typedef {"COMMENT" | "APPROVE" | "REQUEST_CHANGES"} Verdict */

/**
 * @typedef {object} DraftComment
 * @property {string} id
 * @property {import("./anchor/anchor.js").Anchor} anchor the anchor the user made, never rewritten
 *   by drift — a proposal lands in `proposedAnchor` until they accept it
 * @property {string} body
 * @property {import("./anchor/suggestion.js").Suggestion} [suggestion]
 * @property {string | null} fromThreadId
 * @property {"draft" | "submitted" | "stale"} state `stale` is excluded from a submission, which is
 *   what makes marking it the safe response to drift
 * @property {string | null} staleReason
 * @property {import("./anchor/drift.js").DriftStatus} [driftStatus]
 * @property {import("./anchor/anchor.js").Anchor} [proposedAnchor]
 * @property {import("./anchor/drift.js").DriftCandidate[]} [driftCandidates]
 * @property {string} createdAt
 * @property {string} updatedAt
 */

/**
 * @typedef {object} QaThread
 * @property {string} id
 * @property {import("./anchor/anchor.js").Anchor} anchor
 * @property {Array<{ role: "user" | "agent", text: string, at: string }>} messages
 * @property {"open" | "answered" | "promoted" | "dismissed"} status
 * @property {string | null} promotedCommentId
 * @property {import("./anchor/drift.js").DriftStatus} [driftStatus]
 * @property {string} createdAt
 */

/**
 * A queued reply to an **existing** review thread.
 *
 * Kept separate from `comments` because GitHub posts them differently: a review comment is part of
 * the atomic review POST, while a reply goes to `comments/{id}/replies` one call at a time and takes
 * effect immediately. Mixing the two would hide that difference from the user, who needs to know
 * that a reply cannot be un-posted by a failing review.
 *
 * @typedef {object} DraftReply
 * @property {string} id
 * @property {string} threadId the existing thread's id, for rendering
 * @property {number} inReplyToCommentId REST id of the thread's first comment
 * @property {string} path
 * @property {number | null} line
 * @property {string} body
 * @property {"draft" | "posted" | "failed"} state
 * @property {string | null} url set once posted
 * @property {string | null} error set once failed
 * @property {string} createdAt
 * @property {string} updatedAt
 */

/**
 * The one unsolicited channel to the agent.
 *
 * Deliberately narrow: only things that make the session itself unworkable qualify — `gh` has lost
 * its auth, the snapshot fetch failed, the PR was merged or closed. A moved head is **not** one of
 * them; it is a banner with a Refresh button in the browser, and waking an agent for it is noise.
 *
 * `deliveredAt` exists because the two consumers have different lifecycles. The agent must see an
 * alert exactly once — anything else turns every subsequent long-poll into an instant return, which
 * is a busy loop, not a notification. The browser keeps showing them, so the alert itself is never
 * removed.
 *
 * @typedef {object} SessionAlert
 * @property {string} id
 * @property {string} kind
 * @property {string} detail
 * @property {string} at
 * @property {string | null} [deliveredAt]
 */

/**
 * A free-form message, either direction.
 *
 * Has an id because a queued `message` work item refers to one: the queue lists what to do and the
 * text lives in exactly one place, so a replay cannot make the two disagree.
 *
 * @typedef {object} ChatMessage
 * @property {string} [id] absent on a message written before ids existed
 * @property {"user" | "agent"} role
 * @property {string} text
 * @property {string} at
 */

/**
 * @typedef {object} WorkItem
 * @property {string} uid
 * @property {"question" | "question_followup" | "message" | "submit_requested"} kind
 * @property {string} at
 * @property {string} [ref] the thread id this item refers to
 */

/**
 * @typedef {object} Session
 * @property {number} version
 * @property {number} seq
 * @property {string} key
 * @property {string} accessId
 * @property {{ host: string, owner: string, repo: string, number: number, ref: string, url: string }} pr
 * @property {SessionStatus} status
 * @property {"user" | "agent" | null} endedBy
 * @property {string} snapshotHeadSha
 * @property {string[]} localRepos
 * @property {Record<string, unknown>} prefs
 * @property {Record<string, { at: string, atSha: string }>} viewed
 * @property {DraftComment[]} comments
 * @property {QaThread[]} threads
 * @property {DraftReply[]} replies
 * @property {WorkItem[]} work
 * @property {{ verdict: Verdict | null, body: string, updatedAt: string }} review
 * @property {SubmitState} submit
 * @property {SessionAlert[]} alerts
 * @property {ChatMessage[]} chat
 * @property {string} createdAt
 * @property {string} updatedAt
 */

/**
 * @typedef {object} SubmitState
 * @property {string | null} tokenHash
 * @property {string | null} digest
 * @property {string | null} armedAt
 * @property {string | null} expiresAt
 * @property {string | null} consumedAt
 * @property {Verdict | null} verdict
 * @property {string} body
 * @property {string[]} commentIds
 * @property {string[]} replyIds
 * @property {string} headShaAtArm
 * @property {Record<string, unknown> | null} result
 */

/**
 * @param {string} key
 * @param {string} accessId
 * @returns {Session}
 */
export function emptySession(key, accessId) {
  const at = new Date().toISOString();
  return {
    version: SESSION_SCHEMA_VERSION,
    seq: 0,
    key,
    accessId,
    pr: { host: "", owner: "", repo: "", number: 0, ref: "", url: "" },
    status: "open",
    endedBy: null,
    snapshotHeadSha: "",
    localRepos: [],
    prefs: {},
    viewed: {},
    comments: [],
    threads: [],
    replies: [],
    work: [],
    review: { verdict: null, body: "", updatedAt: at },
    submit: emptySubmitState(),
    alerts: [],
    chat: [],
    createdAt: at,
    updatedAt: at,
  };
}

/** @returns {SubmitState} */
export function emptySubmitState() {
  return {
    tokenHash: null,
    digest: null,
    armedAt: null,
    expiresAt: null,
    consumedAt: null,
    verdict: null,
    body: "",
    commentIds: [],
    replyIds: [],
    headShaAtArm: "",
    result: null,
  };
}

/**
 * @typedef {{ op: string, at: string, payload?: Record<string, unknown> }} JournalOp
 */

/**
 * The single reducer. Every mutation goes through here, which is what makes journal replay and
 * live mutation provably identical.
 *
 * @param {Session} session
 * @param {JournalOp} entry
 * @returns {Session}
 */
export function applyOp(session, entry) {
  const next = session;
  const payload = /** @type {any} */ (entry.payload ?? {});
  switch (entry.op) {
    case "session:upsert":
      next.pr = payload.pr ?? next.pr;
      next.accessId = payload.accessId ?? next.accessId;
      next.snapshotHeadSha = payload.headSha ?? next.snapshotHeadSha;
      if (payload.localRepo && !next.localRepos.includes(payload.localRepo)) next.localRepos.push(payload.localRepo);
      // Reopening clears an end, but never clears drafts.
      if (payload.reopen) {
        next.status = "open";
        next.endedBy = null;
      }
      break;
    case "snapshot:head":
      next.snapshotHeadSha = String(payload.headSha ?? "");
      break;
    case "comment:add":
      next.comments.push(payload.comment);
      break;
    case "comment:update": {
      const found = next.comments.find((comment) => comment.id === payload.id);
      if (found) {
        Object.assign(found, payload.patch, { updatedAt: entry.at });
        // Removal is explicit rather than "assign undefined": a key set to undefined disappears on
        // the way through JSON but survives in memory, so the two would disagree until reload.
        for (const key of payload.remove ?? []) delete (/** @type {Record<string, unknown>} */ (found)[key]);
      }
      break;
    }
    case "comment:delete":
      next.comments = next.comments.filter((comment) => comment.id !== payload.id);
      break;
    case "thread:add":
      next.threads.push(payload.thread);
      break;
    case "thread:message": {
      const thread = next.threads.find((item) => item.id === payload.id);
      if (thread) {
        thread.messages.push(payload.message);
        // A follow-up reopens the thread. `promotedCommentId` is a separate field, so a thread that
        // was already promoted keeps that link and still shows as awaiting an answer — the two
        // facts are independent and collapsing them into `status` would lose one.
        thread.status = payload.message.role === "agent" ? "answered" : "open";
      }
      break;
    }
    case "thread:status": {
      const thread = next.threads.find((item) => item.id === payload.id);
      if (thread) {
        thread.status = payload.status;
        if (payload.promotedCommentId !== undefined) thread.promotedCommentId = payload.promotedCommentId;
      }
      break;
    }
    case "reply:add":
      next.replies.push(payload.reply);
      break;
    case "reply:update": {
      const reply = next.replies.find((item) => item.id === payload.id);
      if (reply) Object.assign(reply, payload.patch, { updatedAt: entry.at });
      break;
    }
    case "reply:delete":
      next.replies = next.replies.filter((reply) => reply.id !== payload.id);
      break;
    case "reply:results":
      // Recorded per reply, not as one outcome: each is a separate POST that took effect on its own,
      // and reporting them together would hide which ones are already live on the PR.
      for (const posted of payload.posted ?? []) {
        const reply = next.replies.find((item) => item.id === posted.id);
        if (reply) Object.assign(reply, { state: "posted", url: posted.url ?? null, error: null, updatedAt: entry.at });
      }
      for (const failure of payload.failed ?? []) {
        const reply = next.replies.find((item) => item.id === failure.id);
        if (reply) Object.assign(reply, { state: "failed", error: failure.error ?? "", updatedAt: entry.at });
      }
      break;
    case "review:set":
      next.review = { verdict: payload.verdict ?? null, body: String(payload.body ?? ""), updatedAt: entry.at };
      break;
    case "viewed:set":
      if (payload.viewed) next.viewed[payload.path] = { at: entry.at, atSha: String(payload.atSha ?? "") };
      else delete next.viewed[payload.path];
      break;
    case "prefs:set":
      next.prefs = { ...next.prefs, ...payload.prefs };
      break;
    case "work:add":
      next.work.push(payload.item);
      break;
    case "work:drain":
      next.work = [];
      // Stamped rather than removed: the browser's alert strip reads the same array, and an alert
      // that vanished the moment an agent polled would be one the user never saw.
      for (const alert of next.alerts) {
        if ((payload.alertIds ?? []).includes(alert.id)) alert.deliveredAt = entry.at;
      }
      break;
    case "submit:arm":
      next.submit = {
        tokenHash: String(payload.tokenHash ?? ""),
        digest: String(payload.digest ?? ""),
        armedAt: entry.at,
        expiresAt: String(payload.expiresAt ?? ""),
        consumedAt: null,
        verdict: payload.verdict ?? null,
        body: String(payload.body ?? ""),
        commentIds: Array.isArray(payload.commentIds) ? payload.commentIds.map(String) : [],
        replyIds: Array.isArray(payload.replyIds) ? payload.replyIds.map(String) : [],
        headShaAtArm: String(payload.headShaAtArm ?? ""),
        result: null,
      };
      break;
    case "submit:consume":
      next.submit.consumedAt = entry.at;
      break;
    case "submit:cancel":
      next.submit = emptySubmitState();
      // The queued request goes too. Clearing only the arming left the `submit_requested` item on
      // disk, so a later poll handed the agent an instruction with a null token and a null verdict —
      // it would then run `submit --token null` and report the failure as though the user's review
      // had been rejected. Found by dogfooding this on the tool's own PR.
      next.work = next.work.filter((item) => item.kind !== "submit_requested");
      break;
    case "submit:result": {
      next.submit.result = payload.result ?? null;
      // Only a review that actually posted marks its comments submitted. This used to be
      // unconditional, so a failed submit — a 422, a dropped connection, anything — left every draft
      // flagged as posted when nothing had been. That is worse than it sounds: a submitted comment
      // can no longer be edited or deleted, so the drafts became read-only records of a review that
      // does not exist, and the only recovery was editing the journal by hand.
      const failed = Boolean(/** @type {any} */ (payload.result)?.error);
      if (!failed) {
        for (const comment of next.comments) {
          if (next.submit.commentIds.includes(comment.id)) comment.state = "submitted";
        }
      }
      break;
    }
    case "drift:apply": {
      next.snapshotHeadSha = String(payload.headSha ?? next.snapshotHeadSha);
      /** @type {Record<string, import("./anchor/drift.js").DriftResult>} */
      const commentResults = payload.comments ?? {};
      for (const comment of next.comments) {
        const result = commentResults[comment.id];
        if (!result) continue;
        if (canAutoAccept(result, { hasSuggestion: Boolean(comment.suggestion) })) {
          // The two certain outcomes. `proposedAnchor` is applied rather than left pending because
          // it differs from the current anchor only in its rebuilt fingerprint (and, after a
          // rename, its path) — declining to apply it would report the same drift again forever.
          if (result.proposedAnchor) comment.anchor = result.proposedAnchor;
          if (comment.state === "stale") comment.state = "draft";
          comment.staleReason = null;
          clearDriftFields(comment);
        } else {
          // Anything inferred: hold the draft out of the next submission and put it in front of the
          // user. The anchor they made is left exactly as it was.
          comment.state = "stale";
          comment.staleReason = describeDrift(result);
          comment.driftStatus = result.status;
          if (result.proposedAnchor) comment.proposedAnchor = result.proposedAnchor;
          else delete comment.proposedAnchor;
          if (result.candidates?.length) comment.driftCandidates = result.candidates;
          else delete comment.driftCandidates;
        }
        comment.updatedAt = entry.at;
      }

      /** @type {Record<string, import("./anchor/drift.js").DriftResult>} */
      const threadResults = payload.threads ?? {};
      for (const thread of next.threads) {
        const result = threadResults[thread.id];
        if (!result) continue;
        // Questions are held to a looser standard than comments, deliberately. Nothing is posted
        // from a thread, so the cost of following a merely-probable match is a card that renders a
        // few lines off — not a review comment on code the reviewer never read.
        if (result.proposedAnchor) {
          thread.anchor = result.proposedAnchor;
          delete thread.driftStatus;
        } else {
          thread.driftStatus = result.status;
        }
      }
      break;
    }
    case "drift:accept": {
      const comment = next.comments.find((candidate) => candidate.id === payload.id);
      if (comment && payload.anchor) {
        comment.anchor = payload.anchor;
        if (payload.suggestion) comment.suggestion = payload.suggestion;
        comment.state = "draft";
        comment.staleReason = null;
        clearDriftFields(comment);
        comment.updatedAt = entry.at;
      }
      break;
    }
    case "drift:dismiss": {
      // The user has seen the proposal and does not want it. The draft stays stale — and so stays
      // out of any submission — but stops offering a move they already declined.
      const comment = next.comments.find((candidate) => candidate.id === payload.id);
      if (comment) {
        clearDriftFields(comment);
        comment.staleReason = String(payload.reason ?? comment.staleReason ?? "");
        comment.updatedAt = entry.at;
      }
      break;
    }
    case "chat:add":
      next.chat.push(payload.message);
      break;
    case "alert:add":
      next.alerts.push(payload.alert);
      break;
    case "alert:clear":
      // Retracted, not stamped: unlike delivery, this says the condition itself has gone, so the
      // browser must stop showing it too.
      next.alerts = next.alerts.filter((alert) => !(payload.kinds ?? []).includes(alert.kind));
      break;
    case "session:end":
      next.status = "ended";
      next.endedBy = payload.endedBy ?? "agent";
      break;
    default:
      // An unknown op from a newer version is skipped rather than throwing: the fold cache is
      // still usable, and refusing to load would lock the user out of their own drafts.
      break;
  }
  next.updatedAt = entry.at;
  return next;
}

/**
 * Drop every drift field from a comment.
 *
 * Deletion rather than assigning undefined, for the same reason `comment:update` takes a `remove`
 * list: a key set to undefined vanishes through JSON but survives in memory, so the fold cache and
 * a fresh load would disagree until the next restart.
 *
 * @param {DraftComment} comment
 */
function clearDriftFields(comment) {
  delete comment.driftStatus;
  delete comment.proposedAnchor;
  delete comment.driftCandidates;
}

export class SessionStore {
  /** @param {{ env?: NodeJS.ProcessEnv }} [options] */
  constructor(options = {}) {
    this.env = options.env ?? process.env;
    /** @type {Map<string, Promise<unknown>>} */
    this.locks = new Map();
    /** @type {Map<string, Session>} */
    this.cache = new Map();
  }

  /** @param {string} key */
  dir(key) {
    return sessionDir(key, this.env);
  }

  /** @param {string} key */
  paths(key) {
    const base = this.dir(key);
    return {
      base,
      session: path.join(base, "session.json"),
      journal: path.join(base, "drafts.jsonl"),
      snapshot: path.join(base, "snapshot.json"),
      threads: path.join(base, "threads.json"),
      submitted: path.join(base, "submitted"),
      blobs: path.join(base, "blobs"),
    };
  }

  /**
   * Serialize per key. lavish uses a single global chain, which means a slow write for one
   * session blocks every other; there is no reason to inherit that.
   *
   * @template T
   * @param {string} key
   * @param {() => Promise<T>} operation
   * @returns {Promise<T>}
   */
  runExclusive(key, operation) {
    const previous = this.locks.get(key) ?? Promise.resolve();
    const result = previous.then(operation, operation);
    this.locks.set(
      key,
      result.catch(() => {}),
    );
    return result;
  }

  /**
   * Load a session, folding the journal over the cached snapshot.
   *
   * @param {string} key
   * @returns {Promise<Session | null>}
   */
  async load(key) {
    const cached = this.cache.get(key);
    if (cached) return cached;

    const { session: sessionFile, journal } = this.paths(key);
    /** @type {Session | null} */
    const stored = await readJsonOr(sessionFile, /** @type {Session | null} */ (null));
    /** @type {Array<JournalOp & { seq: number }>} */
    const ops = await readJsonl(journal);
    if (!stored && ops.length === 0) return null;

    if (stored && stored.version > SESSION_SCHEMA_VERSION) {
      // A newer schema may carry fields we would silently drop on the next write. Refusing is
      // safer than quietly truncating someone's drafts.
      throw new Error(
        `session ${key} was written by a newer version (schema ${stored.version} > ${SESSION_SCHEMA_VERSION})`,
      );
    }

    let session = normalizeSession(stored ?? emptySession(key, ""), key);
    for (const op of ops) {
      if (op.seq <= session.seq) continue;
      session = applyOp(session, op);
      session.seq = op.seq;
    }
    this.cache.set(key, session);
    return session;
  }

  /**
   * Append an op to the journal, then rewrite the fold cache.
   *
   * The order is the whole point: the journal is durable first, so a crash before the rewrite
   * replays cleanly on next load.
   *
   * @param {string} key
   * @param {JournalOp} entry
   * @returns {Promise<Session>}
   */
  async commit(key, entry) {
    const { base, session: sessionFile, journal } = this.paths(key);
    await mkdir(base, { recursive: true });

    let session = (await this.load(key)) ?? emptySession(key, "");
    const seq = session.seq + 1;
    const record = { seq, at: entry.at ?? new Date().toISOString(), op: entry.op, payload: entry.payload ?? {} };

    await appendJsonl(journal, record);
    session = applyOp(session, record);
    session.seq = seq;
    session.key = key;
    this.cache.set(key, session);
    await writeJsonAtomic(sessionFile, session);
    await this.writeIndexEntry(session);

    if (seq % JOURNAL_COMPACT_THRESHOLD === 0) await this.compact(key);
    return session;
  }

  /**
   * Collapse the journal. Safe because `session.json` already holds every applied op, and it is
   * written atomically — so truncating the journal can only ever lose ops we have folded in.
   *
   * @param {string} key
   */
  async compact(key) {
    const { journal } = this.paths(key);
    const session = await this.load(key);
    if (!session) return;
    const temp = `${journal}.compact`;
    await writeFile(temp, `${JSON.stringify({ seq: session.seq, at: session.updatedAt, op: "noop" })}\n`, "utf8");
    await rename(temp, journal);
  }

  /**
   * The index is the one piece of state shared across sessions, so it needs its own lock.
   *
   * `commit` runs under a per-key lock, which serializes nothing here: two different sessions
   * would read-modify-write `index.json` concurrently and one entry would be lost. Serializing on
   * a reserved lock name fixes that without reintroducing lavish's single global chain for the
   * per-session writes that actually matter.
   *
   * @param {Session} session
   */
  async writeIndexEntry(session) {
    return this.runExclusive(INDEX_LOCK, () => this.writeIndexEntryUnlocked(session));
  }

  /** @param {Session} session */
  async writeIndexEntryUnlocked(session) {
    const file = indexFile(this.env);
    await mkdir(stateDir(this.env), { recursive: true });
    /** @type {{ version: number, sessions: Record<string, unknown> }} */
    const index = await readJsonOr(file, { version: 1, sessions: {} });
    index.sessions[session.key] = {
      key: session.key,
      ref: session.pr.ref,
      url: session.pr.url,
      accessId: session.accessId,
      status: session.status,
      endedBy: session.endedBy,
      counts: {
        draftComments: session.comments.filter((comment) => comment.state === "draft").length,
        openQuestions: session.threads.filter((thread) => thread.status === "open").length,
        viewedFiles: Object.keys(session.viewed).length,
      },
      updatedAt: session.updatedAt,
    };
    await writeJsonAtomic(file, index);
  }

  /**
   * The port a server last chose, so the next CLI invocation dials the one holding the live
   * sessions rather than starting a second server on a port that has since been freed.
   *
   * @returns {Promise<number | null>}
   */
  async recordedPort() {
    const index = await readJsonOr(indexFile(this.env), /** @type {{ port?: unknown }} */ ({}));
    const port = Number(index.port);
    return Number.isInteger(port) && port > 0 && port <= 65535 ? port : null;
  }

  /** @param {number} port */
  async recordPort(port) {
    return this.runExclusive(INDEX_LOCK, async () => {
      const file = indexFile(this.env);
      await mkdir(stateDir(this.env), { recursive: true });
      // Read-modify-write under the same lock the session entries use: the two writers touch one
      // file, and without a shared lock one of them loses.
      const index = await readJsonOr(file, /** @type {any} */ ({ version: 1, sessions: {} }));
      if (index.port === port) return;
      index.port = port;
      await writeJsonAtomic(file, index);
    });
  }

  /**
   * Wait for every in-flight mutation to finish.
   *
   * Called on shutdown. lavish closes its server without this, and the window it leaves is exactly
   * wide enough to lose a draft that was mid-write — which here is prose the user may have spent
   * half an hour on.
   *
   * @returns {Promise<void>}
   */
  async drain() {
    // Cumulative, not per-round. A settled entry stays in `this.locks`, and a commit under one key
    // takes a second lock (`@index`), so a per-round set would see each of the two as "new" in
    // alternate rounds and ping-pong between them forever — which is a hang on shutdown, not a
    // slow one. Found by the test that asserts a shutdown waits for a mutation.
    const seen = new Set();
    for (;;) {
      const pending = [...this.locks.values()].filter((lock) => !seen.has(lock));
      if (pending.length === 0) return;
      for (const lock of pending) seen.add(lock);
      await Promise.allSettled(pending);
    }
  }

  /** @returns {Promise<Array<Record<string, unknown>>>} */
  async listSessions() {
    /** @type {{ sessions: Record<string, Record<string, unknown>> }} */
    const index = await readJsonOr(indexFile(this.env), { sessions: {} });
    return Object.values(index.sessions ?? {});
  }

  /**
   * @param {object} input
   * @param {import("./pr-ref.js").PrRef} input.ref
   * @param {string} input.key
   * @param {string} input.accessId
   * @param {string} input.url
   * @param {string} input.displayRef
   * @param {string} [input.headSha]
   * @param {string} [input.localRepo]
   * @param {boolean} [input.reopen]
   * @returns {Promise<Session>}
   */
  async upsert(input) {
    return this.runExclusive(input.key, async () =>
      this.commit(input.key, {
        op: "session:upsert",
        at: new Date().toISOString(),
        payload: {
          pr: {
            host: input.ref.host,
            owner: input.ref.owner,
            repo: input.ref.repo,
            number: input.ref.number,
            ref: input.displayRef,
            url: input.url,
          },
          accessId: input.accessId,
          headSha: input.headSha,
          localRepo: input.localRepo,
          reopen: input.reopen === true,
        },
      }),
    );
  }

  /** @param {string} key @param {JournalOp} entry */
  mutate(key, entry) {
    return this.runExclusive(key, () => this.commit(key, { ...entry, at: entry.at ?? new Date().toISOString() }));
  }

  /**
   * Drain the work queue. The analogue of lavish's `takeFeedback`: atomic, and returns `waiting`
   * when there is nothing for the agent to do.
   *
   * @param {string} key
   * @returns {Promise<{ status: "missing" } | { status: "waiting" } | { status: "ended", endedBy: string | null }
   *   | { status: "work", work: WorkItem[], alerts: SessionAlert[], session: Session, sessionEnded: boolean }>}
   */
  async takeWork(key) {
    return this.runExclusive(key, async () => {
      const session = await this.load(key);
      if (!session) return { status: /** @type {const} */ ("missing") };
      const work = [...session.work];
      // Undelivered, not "all": an alert that kept returning would make every long-poll return
      // instantly forever — a busy loop wearing a notification's clothes.
      const alerts = session.alerts.filter((alert) => !alert.deliveredAt);
      const alreadyEnded = session.status === "ended";
      if (work.length === 0 && alerts.length === 0) {
        return alreadyEnded
          ? { status: /** @type {const} */ ("ended"), endedBy: session.endedBy }
          : { status: /** @type {const} */ ("waiting") };
      }
      // Work queued before an end must still be delivered once; the next poll then sees `ended`.
      const updated = await this.commit(key, {
        op: "work:drain",
        at: new Date().toISOString(),
        payload: { alertIds: alerts.map((alert) => alert.id) },
      });
      return { status: /** @type {const} */ ("work"), work, alerts, session: updated, sessionEnded: alreadyEnded };
    });
  }

  /**
   * Arm a submission.
   *
   * The token is the mechanism that makes the human the gate: nothing can submit without one,
   * it is single-use, and it is bound to a digest of the exact payload the user approved. The
   * token itself is stored **hashed** so reading `session.json` does not confer the ability to
   * submit.
   *
   * @param {string} key
   * @param {object} input
   * @param {Verdict} input.verdict
   * @param {string} input.body
   * @param {string[]} input.commentIds
   * @param {string[]} [input.replyIds]
   * @param {string} input.digest
   * @param {string} input.headSha
   * @param {() => Buffer} [input.randomBytesImpl]
   * @returns {Promise<{ token: string, expiresAt: string, session: Session }>}
   */
  async armSubmit(key, input) {
    const token = (input.randomBytesImpl?.() ?? randomBytes(32)).toString("base64url");
    const expiresAt = new Date(Date.now() + SUBMIT_TOKEN_TTL_MS).toISOString();
    const session = await this.mutate(key, {
      op: "submit:arm",
      at: new Date().toISOString(),
      payload: {
        tokenHash: hashToken(token),
        digest: input.digest,
        expiresAt,
        verdict: input.verdict,
        body: input.body,
        commentIds: input.commentIds,
        replyIds: input.replyIds ?? [],
        headShaAtArm: input.headSha,
      },
    });
    return { token, expiresAt, session };
  }

  /**
   * Consume a submit token. Marks it consumed **before** the caller spawns `gh`, so an agent
   * retry loop cannot double-post.
   *
   * @param {string} key
   * @param {string} token
   * @param {{ dryRun?: boolean }} [options] a dry run verifies the token without consuming it, so
   *   `submit --dry-run` does not burn the single use and leave the real submit unable to proceed
   * @returns {Promise<{ ok: true, session: Session } | { ok: false, reason: "not-armed" | "expired" | "already-used" | "bad-token" }>}
   */
  async claimSubmit(key, token, options = {}) {
    return this.runExclusive(key, async () => {
      const session = await this.load(key);
      if (!session || !session.submit.tokenHash)
        return { ok: /** @type {false} */ (false), reason: /** @type {const} */ ("not-armed") };
      if (session.submit.consumedAt)
        return { ok: /** @type {false} */ (false), reason: /** @type {const} */ ("already-used") };
      if (session.submit.expiresAt && Date.parse(session.submit.expiresAt) < Date.now()) {
        return { ok: /** @type {false} */ (false), reason: /** @type {const} */ ("expired") };
      }
      if (!tokenMatches(token, session.submit.tokenHash)) {
        return { ok: /** @type {false} */ (false), reason: /** @type {const} */ ("bad-token") };
      }
      if (options.dryRun) return { ok: /** @type {true} */ (true), session };
      const updated = await this.commit(key, { op: "submit:consume", at: new Date().toISOString() });
      return { ok: /** @type {true} */ (true), session: updated };
    });
  }

  /**
   * @param {string} key
   * @param {Record<string, unknown>} result
   */
  async recordSubmitResult(key, result) {
    const session = await this.mutate(key, { op: "submit:result", at: new Date().toISOString(), payload: { result } });
    // Kept forever: it is small, and "what exactly did I post?" must always be answerable.
    const { submitted } = this.paths(key);
    await mkdir(submitted, { recursive: true });
    await writeJsonAtomic(path.join(submitted, `${new Date().toISOString().replace(/[:.]/g, "-")}.json`), result);
    return session;
  }

  /** @param {string} key @param {import("./snapshot.js").Snapshot} snapshot */
  async saveSnapshot(key, snapshot) {
    const { base, snapshot: file } = this.paths(key);
    await mkdir(base, { recursive: true });
    // `byPath` is a Map and would serialize as `{}`, so it is dropped here and rebuilt on load.
    const serializable = { ...snapshot };
    delete (/** @type {{ byPath?: unknown }} */ (serializable).byPath);
    await writeJsonAtomic(file, serializable);
  }

  /**
   * Existing PR threads, cached separately from the diff.
   *
   * Their own file because they change on a different clock: someone can resolve a thread without
   * touching the diff, and re-fetching them must not mean re-parsing every patch.
   *
   * @param {string} key
   * @param {import("./gh-threads.js").ThreadsSnapshot} threads
   */
  async saveThreads(key, threads) {
    const { base, threads: file } = this.paths(key);
    await mkdir(base, { recursive: true });
    await writeJsonAtomic(file, threads);
  }

  /** @param {string} key @returns {Promise<import("./gh-threads.js").ThreadsSnapshot | null>} */
  async loadThreads(key) {
    return readJsonOr(this.paths(key).threads, /** @type {any} */ (null));
  }

  /** @param {string} key @returns {Promise<import("./snapshot.js").Snapshot | null>} */
  async loadSnapshot(key) {
    const { snapshot: file } = this.paths(key);
    /** @type {import("./snapshot.js").Snapshot | null} */
    const stored = await readJsonOr(file, /** @type {any} */ (null));
    if (!stored) return null;
    stored.byPath = new Map(stored.files.map((file2) => [file2.path, file2]));
    return stored;
  }

  /**
   * Delete temp files left behind by a crash.
   *
   * `writeJsonAtomic` writes a sibling `.tmp` and renames it. A process killed between the two
   * leaves the temp behind — harmless to correctness, since nothing ever reads one, but it
   * accumulates: one per crash, forever, inside the user's state directory. Age is the safety
   * margin: an atomic write takes milliseconds, so anything older than `maxAgeMs` cannot belong to
   * a live writer, including one in another process.
   *
   * @param {number} [maxAgeMs]
   * @returns {Promise<string[]>} the files removed
   */
  async sweepTempFiles(maxAgeMs = 60 * 60_000) {
    const cutoff = Date.now() - maxAgeMs;
    /** @type {string[]} */
    const removed = [];
    const root = path.join(stateDir(this.env), "sessions");
    /** @type {string[]} */
    let keys;
    try {
      keys = await readdir(root);
    } catch {
      // No sessions directory yet: nothing to sweep, and certainly nothing to report.
      return removed;
    }
    for (const key of keys) {
      const dir = path.join(root, key);
      /** @type {string[]} */
      let entries;
      try {
        entries = await readdir(dir);
      } catch {
        continue;
      }
      for (const name of entries) {
        if (!name.endsWith(".tmp")) continue;
        const full = path.join(dir, name);
        try {
          const info = await stat(full);
          if (info.mtimeMs > cutoff) continue;
          await rm(full, { force: true });
          removed.push(full);
        } catch {
          // Someone else got there first, which is the outcome this wanted anyway.
        }
      }
    }
    return removed;
  }

  /** Drop the in-memory cache. Used by tests and after an out-of-band write. @param {string} [key] */
  invalidate(key) {
    if (key) this.cache.delete(key);
    else this.cache.clear();
  }

  /** @param {string} key */
  async destroy(key) {
    this.invalidate(key);
    await rm(this.dir(key), { recursive: true, force: true });
  }
}

/**
 * Fill in fields a session written by an older build does not have.
 *
 * Sessions live on disk for as long as a review takes, so an upgrade mid-review is normal rather
 * than exotic. Adding a collection to the shape must therefore not make an existing session
 * unloadable — and a reducer that does `session.replies.push(...)` on an undefined array is exactly
 * that. The schema version stays put: this is a widening, not a change of meaning, so refusing to
 * load would throw away drafts for no reason.
 *
 * @param {Session} session
 * @param {string} key
 * @returns {Session}
 */
export function normalizeSession(session, key) {
  const at = session.updatedAt ?? new Date().toISOString();
  session.key = session.key || key;
  session.comments ??= [];
  session.threads ??= [];
  session.replies ??= [];
  session.work ??= [];
  session.alerts ??= [];
  // An alert written before ids existed still has to be deliverable exactly once, and `work:drain`
  // stamps by id. Assigning one on load is safe: the very next commit persists it.
  for (const alert of session.alerts) alert.id ??= newId("al");
  session.chat ??= [];
  session.viewed ??= {};
  session.prefs ??= {};
  session.localRepos ??= [];
  session.review ??= { verdict: null, body: "", updatedAt: at };
  session.submit ??= emptySubmitState();
  return session;
}

/** @param {string} token */
export function hashToken(token) {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

/**
 * @param {string} token
 * @param {string} expectedHash
 */
export function tokenMatches(token, expectedHash) {
  const actual = Buffer.from(hashToken(token), "hex");
  const expected = Buffer.from(expectedHash, "hex");
  if (actual.length !== expected.length) return false;
  return timingSafeEqual(actual, expected);
}

/**
 * A stable digest of exactly what the human approved.
 *
 * Binding the token to this means an armed submission cannot be quietly altered between the
 * click and the `gh` call — not by a later edit, not by a replayed request.
 *
 * @param {object} payload
 * @param {string} payload.verdict
 * @param {string} payload.body
 * @param {import("./anchor/anchor.js").GitHubReviewComment[]} payload.comments
 * @param {Array<{ inReplyToCommentId: number, body: string }>} [payload.replies] queued replies to
 *   existing threads. They post separately from the review, but the human approved them in the same
 *   click, so they are inside the same digest.
 */
export function submitDigest(payload) {
  const canonical = JSON.stringify({
    verdict: payload.verdict,
    body: payload.body,
    replies: (payload.replies ?? []).map((reply) => ({
      in_reply_to: reply.inReplyToCommentId,
      body: reply.body,
    })),
    comments: payload.comments.map((comment) => ({
      path: comment.path,
      line: comment.line ?? null,
      side: comment.side ?? null,
      start_line: comment.start_line ?? null,
      start_side: comment.start_side ?? null,
      subject_type: comment.subject_type ?? null,
      body: comment.body,
    })),
  });
  return `sha256:${createHash("sha256").update(canonical, "utf8").digest("hex")}`;
}

/** @param {string} [bytes] */
export function newAccessId(bytes) {
  return bytes ?? randomBytes(16).toString("base64url");
}

/** @param {string} prefix */
export function newId(prefix) {
  return `${prefix}_${randomBytes(9).toString("base64url")}`;
}

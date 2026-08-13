// Pinned before src/ is imported so paths.js resolves to loopback regardless of the environment.
process.env.PR_REVIEW_CANVAS_HOST = "127.0.0.1";
process.env.PR_REVIEW_CANVAS_LINK_HOST = "127.0.0.1";

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createPollOutput } from "../src/cli.js";
import { flattenPages } from "../src/gh-fetch.js";
import { MAX_QUESTIONS_PER_POLL } from "../src/qa-excerpt.js";
import { serve } from "../src/server.js";
import { newAccessId, SessionStore } from "../src/session-store.js";
import { buildSnapshot } from "../src/snapshot.js";

/**
 * The Q&A round trip, end to end over real HTTP against a real server.
 *
 * The diff is a recorded response from an actual PR, so the line numbers these tests ask about are
 * ones GitHub itself produced — which is the only way to be sure the excerpt and the anchor agree
 * with each other about what line 72 means.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const files219 = flattenPages(
  JSON.parse(readFileSync(path.join(here, "fixtures", "live", "pr-219.files.json"), "utf8")),
);

const REF = { host: "github.com", owner: "KunChenGuid", repo: "lavish-axi", number: 219 };
const HEAD_SHA = "90608665c6abe9000ebf474e25d34d5acdfa04e6";
const KEY = "b47d587c3f8cf14e";

/**
 * @param {(ctx: {
 *   base: string,
 *   accessId: string,
 *   key: string,
 *   snapshot: import("../src/snapshot.js").Snapshot,
 *   store: SessionStore,
 *   ui: (path: string, init?: RequestInit) => Promise<Response>,
 *   agent: (path: string, body?: unknown) => Promise<Response>,
 *   poll: (timeoutMs?: number) => Promise<Response>,
 * }) => Promise<void>} body
 */
async function withSession(body) {
  const dir = await mkdtemp(path.join(tmpdir(), "prc-qa-"));
  const store = new SessionStore({ env: { ...process.env, PR_REVIEW_CANVAS_STATE_DIR: dir } });
  const snapshot = await buildSnapshot(/** @type {any} */ (REF), {
    fetchPullRequestImpl: async () => ({
      number: 219,
      title: "Recorded",
      state: "OPEN",
      isDraft: false,
      headRefName: "topic",
      baseRefName: "main",
      headSha: HEAD_SHA,
      baseSha: "0".repeat(40),
      authorLogin: "someone",
      url: `https://github.com/${REF.owner}/${REF.repo}/pull/219`,
      changedFiles: files219.length,
      additions: 0,
      deletions: 0,
      mergeable: "MERGEABLE",
      merged: false,
    }),
    fetchFilesImpl: async () => files219,
  });

  const accessId = newAccessId();
  await store.upsert({
    ref: /** @type {any} */ (REF),
    key: KEY,
    accessId,
    url: `http://127.0.0.1/review/${accessId}`,
    displayRef: "KunChenGuid/lavish-axi#219",
    headSha: snapshot.headSha,
  });
  await store.saveSnapshot(KEY, snapshot);

  const server = await serve({ port: 0, version: "9.9.9-test", idleTimeoutMs: null, store });
  const base = `http://127.0.0.1:${server.port}`;
  /** Same-origin is enforced on every non-GET under /api/ui, so the Origin goes on every call. */
  /**
   * @param {string} suffix
   * @param {RequestInit} [init]
   */
  const ui = (suffix, init = {}) =>
    fetch(`${base}/api/ui/s/${accessId}${suffix}`, {
      ...init,
      headers: {
        "content-type": "application/json",
        origin: base,
        .../** @type {Record<string, string>} */ (init.headers ?? {}),
      },
    });
  /**
   * @param {string} suffix
   * @param {unknown} [payload]
   */
  const agent = (suffix, payload) =>
    fetch(`${base}${suffix}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload ?? {}),
    });

  /** The agent long-poll. A short timeout keeps the suite fast; work is delivered immediately anyway. */
  const poll = (timeoutMs = 2000) => fetch(`${base}/api/agent/poll?key=${KEY}&timeoutMs=${timeoutMs}`);

  try {
    await body({ base, accessId, key: KEY, snapshot, store, ui, agent, poll });
  } finally {
    await server.close();
    await rm(dir, { recursive: true, force: true });
  }
}

/**
 * The first added line of the first file that has one. Derived from the recorded diff rather than
 * hardcoded, so the fixture can be re-recorded without breaking these tests.
 *
 * @param {import("../src/snapshot.js").Snapshot} snapshot
 */
function firstAddition(snapshot) {
  for (const [index, file] of snapshot.files.entries()) {
    for (const hunk of file.hunks) {
      for (const line of hunk.lines) {
        if (line.kind === "add" && line.newLine != null) {
          return { fileIndex: index, path: file.path, line: line.newLine, text: line.text };
        }
      }
    }
  }
  throw new Error("the recorded diff has no additions");
}

test("a question wakes the poll and arrives with a capped code excerpt", async () => {
  await withSession(async ({ snapshot, ui, agent, key, poll }) => {
    const target = firstAddition(snapshot);

    const asked = await ui("/questions", {
      method: "POST",
      body: JSON.stringify({
        fileIndex: target.fileIndex,
        side: "RIGHT",
        line: target.line,
        body: "Why is this needed?",
      }),
    });
    assert.equal(asked.status, 200);
    const askedBody = await asked.json();
    assert.match(askedBody.thread.id, /^q_/);
    assert.equal(askedBody.thread.status, "open");
    assert.equal(askedBody.thread.anchor.outsideDiff, undefined);

    const work = await (await poll()).json();
    assert.equal(work.status, "work");
    assert.equal(work.questions.length, 1);
    const question = work.questions[0];
    assert.equal(question.id, askedBody.thread.id);
    assert.equal(question.path, target.path);
    assert.equal(question.side, "RIGHT");
    assert.equal(question.lines, String(target.line));
    assert.equal(question.question, "Why is this needed?");
    // `selected_text` is a label, not the payload, so a long line arrives clipped.
    assert.ok(target.text.startsWith(question.selected_text.replace(/…$/, "")));
    assert.ok(question.selected_text.length <= 201);
    assert.match(question.code, new RegExp(`>\\+\\s*${target.line} \\| `));
    assert.ok(question.permalink.startsWith(`https://github.com/${REF.owner}/${REF.repo}/blob/${HEAD_SHA}/`));

    // The size of one question's payload is what decides whether the tool is usable inside an
    // agent's context window. The recorded file here is documentation prose with 400-character
    // lines — close to the worst case — and it still lands well under the excerpt cap. A code file
    // comes out around a third of this.
    const size = JSON.stringify(work.questions).length;
    assert.ok(size < 2560, `payload was ${size} B`);
    assert.ok(Buffer.byteLength(question.code, "utf8") <= 4096);

    // Draft comment bodies must never appear in a poll payload — the agent has no business reading
    // the human's review prose.
    assert.equal(
      work.questions.some((/** @type {any} */ item) => "body" in item),
      false,
    );

    const answered = await agent(`/api/agent/sessions/${key}/answer`, {
      threadId: question.id,
      text: "Because `bindHost` defaults to loopback.\n\n```js\nconst x = 1;\n```",
    });
    assert.equal(answered.status, 200);
    const answerBody = await answered.json();
    assert.equal(answerBody.thread.id, question.id);
    assert.equal(answerBody.thread.path, target.path);
    assert.equal(answerBody.thread.line, target.line);

    const hydrated = await (await ui("")).json();
    const thread = hydrated.session.threads[0];
    assert.equal(thread.status, "answered");
    assert.deepEqual(
      thread.messages.map((/** @type {any} */ message) => message.role),
      ["user", "agent"],
    );
    // Backticks and fences survive verbatim: the answer never went near a shell.
    assert.match(thread.messages[1].text, /```js\nconst x = 1;\n```/);
  });
});

test("a follow-up reopens the thread and queues more work", async () => {
  await withSession(async ({ snapshot, ui, agent, key, poll }) => {
    const target = firstAddition(snapshot);
    const asked = await (
      await ui("/questions", {
        method: "POST",
        body: JSON.stringify({ fileIndex: target.fileIndex, side: "RIGHT", line: target.line, body: "first" }),
      })
    ).json();
    await poll(); // drain
    await agent(`/api/agent/sessions/${key}/answer`, { threadId: asked.thread.id, text: "an answer" });

    const followUp = await ui(`/questions/${asked.thread.id}/messages`, {
      method: "POST",
      body: JSON.stringify({ body: "and what about the other case?" }),
    });
    assert.equal(followUp.status, 200);

    const work = await (await poll()).json();
    assert.equal(work.questions.length, 1);
    assert.equal(work.questions[0].kind, "question_followup");
    assert.equal(work.questions[0].follow_up, true);
    assert.equal(work.questions[0].question, "and what about the other case?");

    // Answered → open again: an unanswered follow-up must show as outstanding.
    const hydrated = await (await ui("")).json();
    assert.equal(hydrated.session.threads[0].status, "open");
  });
});

test("questions beyond the per-poll cap are re-queued, not dropped", async () => {
  await withSession(async ({ snapshot, ui, poll }) => {
    const target = firstAddition(snapshot);
    const total = MAX_QUESTIONS_PER_POLL + 2;
    for (let index = 0; index < total; index += 1) {
      const response = await ui("/questions", {
        method: "POST",
        body: JSON.stringify({
          fileIndex: target.fileIndex,
          side: "RIGHT",
          line: target.line,
          body: `question ${index}`,
        }),
      });
      assert.equal(response.status, 200);
    }

    const first = await (await poll()).json();
    assert.equal(first.questions.length, MAX_QUESTIONS_PER_POLL);
    assert.equal(first.questionsDeferred, total - MAX_QUESTIONS_PER_POLL);

    const second = await (await poll()).json();
    assert.equal(second.questions.length, total - MAX_QUESTIONS_PER_POLL);
    assert.equal(second.questionsDeferred, undefined);
    // Every question is delivered exactly once, in order.
    assert.deepEqual(
      [...first.questions, ...second.questions].map((/** @type {any} */ item) => item.question),
      Array.from({ length: total }, (_, index) => `question ${index}`),
    );

    const third = await (await poll(50)).json();
    assert.equal(third.status, "waiting");
  });
});

test("a line outside the diff can be asked about but not commented on", async () => {
  await withSession(async ({ snapshot, ui }) => {
    const target = firstAddition(snapshot);
    // Line 1 of a file whose first hunk starts later is readable on GitHub but not part of the
    // diff, so GitHub would refuse a comment there.
    const outside = 1;
    const file = snapshot.files[target.fileIndex];
    const inDiff = file.hunks.some((hunk) => hunk.lines.some((line) => line.newLine === outside));
    if (inDiff) return; // the recorded diff happens to cover line 1; nothing to assert

    const comment = await ui("/comments", {
      method: "POST",
      body: JSON.stringify({ fileIndex: target.fileIndex, side: "RIGHT", line: outside, body: "nope" }),
    });
    assert.equal(comment.status, 422);
    assert.match((await comment.json()).error, /is not part of the diff/);

    const question = await ui("/questions", {
      method: "POST",
      body: JSON.stringify({ fileIndex: target.fileIndex, side: "RIGHT", line: outside, body: "what is here?" }),
    });
    assert.equal(question.status, 200);
    const body = await question.json();
    assert.equal(body.thread.anchor.outsideDiff, true);
    assert.equal(body.thread.anchor.line, outside);
  });
});

test("a cross-origin POST cannot ask a question", async () => {
  await withSession(async ({ base, accessId, snapshot }) => {
    const target = firstAddition(snapshot);
    const payload = JSON.stringify({
      fileIndex: target.fileIndex,
      side: "RIGHT",
      line: target.line,
      body: "from an attacker",
    });
    /** @type {Record<string, string>[]} */
    const cases = [
      { "content-type": "application/json", origin: "http://evil.example.com" },
      { "content-type": "application/json" }, // no Origin at all
    ];
    for (const headers of cases) {
      const response = await fetch(`${base}/api/ui/s/${accessId}/questions`, {
        method: "POST",
        headers,
        body: payload,
      });
      assert.equal(response.status, 403);
      assert.deepEqual(await response.json(), { error: "cross-origin request refused" });
    }
  });
});

test("an empty question is refused, and an unknown thread cannot be answered", async () => {
  await withSession(async ({ snapshot, ui, agent, key }) => {
    const target = firstAddition(snapshot);
    const empty = await ui("/questions", {
      method: "POST",
      body: JSON.stringify({ fileIndex: target.fileIndex, side: "RIGHT", line: target.line, body: "   " }),
    });
    assert.equal(empty.status, 422);

    const unknown = await agent(`/api/agent/sessions/${key}/answer`, { threadId: "q_nope", text: "hello" });
    assert.equal(unknown.status, 404);

    const blank = await agent(`/api/agent/sessions/${key}/answer`, { threadId: "q_nope", text: "" });
    assert.equal(blank.status, 422);
  });
});

test("an answer reaches the browser over SSE, with no reload involved", { timeout: 15_000 }, async () => {
  await withSession(async ({ base, accessId, snapshot, ui, agent, key }) => {
    const target = firstAddition(snapshot);
    const asked = await (
      await ui("/questions", {
        method: "POST",
        body: JSON.stringify({ fileIndex: target.fileIndex, side: "RIGHT", line: target.line, body: "why?" }),
      })
    ).json();

    const controller = new AbortController();
    const stream = await fetch(`${base}/events/${accessId}`, { signal: controller.signal });
    const reader = /** @type {ReadableStreamDefaultReader<Uint8Array>} */ (stream.body?.getReader());
    const decoder = new TextDecoder();
    let buffer = "";
    /** @param {string} needle */
    const readUntil = async (needle) => {
      while (!buffer.includes(needle)) {
        const { value, done } = await reader.read();
        if (done) throw new Error(`stream closed before ${needle}; saw ${buffer}`);
        buffer += decoder.decode(value, { stream: true });
      }
    };

    try {
      // The handshake carries the threads, so a browser that reconnects converges without a reload.
      await readUntil("event: state-sync");
      const sync = JSON.parse(/data: (.*)/.exec(buffer)?.[1] ?? "{}");
      assert.equal(sync.threads.length, 1);

      await agent(`/api/agent/sessions/${key}/answer`, { threadId: asked.thread.id, text: "because of X" });
      await readUntil("event: qa-answer");
      const frame = buffer.slice(buffer.indexOf("event: qa-answer"));
      const data = JSON.parse(/data: (.*)/.exec(frame)?.[1] ?? "{}");
      assert.equal(data.threadId, asked.thread.id);
      assert.equal(data.message.role, "agent");
      assert.equal(data.message.text, "because of X");
      assert.ok(!buffer.includes("event: reload"), "this protocol must never tell the page to reload");
    } finally {
      controller.abort();
    }
  });
});

test("an agent reply is stored in the transcript the page hydrates from", async () => {
  await withSession(async ({ ui, agent, key }) => {
    const posted = await agent(`/api/agent/sessions/${key}/agent-reply`, {
      text: "Opened 8 files; start with AGENTS.md",
    });
    assert.equal(posted.status, 200);
    const hydrated = await (await ui("")).json();
    // The hydration payload used to carry only the newest agent note. It carries the whole
    // conversation now, and the banner's "latest note" is derived from it in the client — one copy of
    // the fact rather than two that can disagree.
    assert.deepEqual(hydrated.session.chat, [
      { ...hydrated.session.chat[0], role: "agent", text: "Opened 8 files; start with AGENTS.md" },
    ]);
    assert.ok(hydrated.session.chat[0].id);

    const empty = await agent(`/api/agent/sessions/${key}/agent-reply`, { text: "  " });
    assert.equal(empty.status, 422);
  });
});

test("dismissing a thread does not wake the agent and does not drop queued work", async () => {
  await withSession(async ({ snapshot, ui, poll }) => {
    const target = firstAddition(snapshot);
    const asked = await (
      await ui("/questions", {
        method: "POST",
        body: JSON.stringify({ fileIndex: target.fileIndex, side: "RIGHT", line: target.line, body: "why?" }),
      })
    ).json();

    const dismissed = await ui(`/questions/${asked.thread.id}/dismiss`, { method: "POST" });
    assert.equal(dismissed.status, 200);

    // Still delivered: the agent may already be composing an answer, and one redundant answer is a
    // far better outcome than silently discarding work.
    const work = await (await poll()).json();
    assert.equal(work.questions.length, 1);

    const followUp = await ui(`/questions/${asked.thread.id}/messages`, {
      method: "POST",
      body: JSON.stringify({ body: "actually, one more thing" }),
    });
    assert.equal(followUp.status, 409);
  });
});

// ---------------------------------------------------------------------------
// Free-form chat
// ---------------------------------------------------------------------------

test("a chat message wakes the agent and arrives with its text", async () => {
  await withSession(async ({ ui, poll, store }) => {
    const posted = await ui("/messages", {
      method: "POST",
      body: JSON.stringify({ text: "What should I look at first?" }),
    });
    assert.equal(posted.status, 200);
    const message = (await posted.json()).message;
    assert.equal(message.role, "user");
    assert.ok(message.id, "a message needs an id, because the work item refers to it");

    const delivered = await (await poll()).json();
    assert.equal(delivered.status, "work");
    assert.deepEqual(
      delivered.messages.map((/** @type {any} */ entry) => entry.text),
      ["What should I look at first?"],
    );
    // The queue holds a reference, not a copy: one home for the text means a replay cannot make the
    // two disagree.
    const item = delivered.work.find((/** @type {any} */ entry) => entry.kind === "message");
    assert.equal(item.ref, message.id);
    assert.equal(item.text, undefined);

    // Delivered once. A message that kept coming back would make every later poll return instantly.
    assert.deepEqual((await store.load(KEY))?.work, []);
  });
});

test("the poll tells the agent to answer in the chat, and how to point at code", async () => {
  await withSession(async ({ ui, poll }) => {
    await ui("/messages", { method: "POST", body: JSON.stringify({ text: "anything worth noting?" }) });
    const output = /** @type {any} */ (createPollOutput(/** @type {any} */ (REF), await (await poll()).json()));

    assert.deepEqual(
      output.messages.map((/** @type {any} */ entry) => entry.text),
      ["anything worth noting?"],
    );
    assert.match(output.next_step, /--agent-reply/);
    // The line-reference convention has to be in the instruction, or the feature stays unused: the
    // agent has no other way to learn that `path:line` becomes a control in the panel.
    assert.match(output.next_step, /path:line/);
    assert.match(output.next_step, /Do NOT draft review comments/);
  });
});

test("a chat message and a line question in one poll are both reported", async () => {
  await withSession(async ({ snapshot, ui, poll }) => {
    const target = firstAddition(snapshot);
    const asked = await ui("/questions", {
      method: "POST",
      body: JSON.stringify({ fileIndex: target.fileIndex, side: "RIGHT", line: target.line, body: "why?" }),
    });
    assert.equal(asked.status, 200);
    await ui("/messages", { method: "POST", body: JSON.stringify({ text: "and generally?" }) });

    const output = /** @type {any} */ (createPollOutput(/** @type {any} */ (REF), await (await poll()).json()));
    assert.equal(output.messages.length, 1);
    assert.equal(output.questions.length, 1);
    // Anchored questions come first in the instruction, because they are the ones with a `--thread` id
    // and a specific command; the chat reply rides on the next poll either way.
    assert.match(output.next_step, /answer those with `pr-review-canvas answer` first/);
  });
});

test("an agent reply lands in the transcript and reaches the browser", { timeout: 15_000 }, async () => {
  await withSession(async ({ base, accessId, agent, store }) => {
    /** @type {string[]} */
    const events = [];
    const response = await fetch(`${base}/events/${accessId}`, { headers: { accept: "text/event-stream" } });
    const reader = /** @type {ReadableStream<Uint8Array>} */ (response.body).getReader();
    const decoder = new TextDecoder();
    const read = (async () => {
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) return;
        const text = decoder.decode(chunk.value);
        if (text.includes("event: chat-message")) {
          events.push(text);
          return;
        }
      }
    })();

    await agent(`/api/agent/sessions/${KEY}/agent-reply`, { text: "Start with src/anchor/drift.js:100-118." });
    await read;
    reader.cancel().catch(() => {});

    assert.equal(events.length, 1, "the reply must reach the open page without a reload");
    assert.match(events[0], /drift\.js:100-118/);

    const chat = (await store.load(KEY))?.chat ?? [];
    assert.equal(chat.at(-1)?.role, "agent");
    assert.ok(chat.at(-1)?.id, "an agent reply needs an id too, so the browser can upsert it");
  });
});

test("an empty or oversized message is refused, and a cross-origin one cannot be sent", async () => {
  await withSession(async ({ base, accessId, ui }) => {
    assert.equal((await ui("/messages", { method: "POST", body: JSON.stringify({ text: "   " }) })).status, 422);
    const huge = "x".repeat(64 * 1024 + 1);
    assert.equal((await ui("/messages", { method: "POST", body: JSON.stringify({ text: huge }) })).status, 413);

    const cross = await fetch(`${base}/api/ui/s/${accessId}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: "http://evil.example" },
      body: JSON.stringify({ text: "hello" }),
    });
    assert.equal(cross.status, 403);
  });
});

test("the page ships the whole transcript, not just the last note", async () => {
  await withSession(async ({ ui, agent, base, accessId }) => {
    await ui("/messages", { method: "POST", body: JSON.stringify({ text: "first" }) });
    await agent(`/api/agent/sessions/${KEY}/agent-reply`, { text: "second" });

    const hydrated = await (await ui("")).json();
    assert.deepEqual(
      hydrated.session.chat.map((/** @type {any} */ entry) => `${entry.role}:${entry.text}`),
      ["user:first", "agent:second"],
    );

    // And the server-rendered page carries it too, so a reload does not empty the panel.
    const html = await (await fetch(`${base}/review/${accessId}`)).text();
    const bootstrap = JSON.parse(/id="prc-bootstrap"[^>]*>([\s\S]*?)<\/script>/.exec(html)?.[1] ?? "{}");
    assert.deepEqual(
      bootstrap.chat.map((/** @type {any} */ entry) => entry.text),
      ["first", "second"],
    );
  });
});

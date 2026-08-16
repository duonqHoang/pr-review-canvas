process.env.PR_REVIEW_CANVAS_HOST = "127.0.0.1";
process.env.PR_REVIEW_CANVAS_LINK_HOST = "127.0.0.1";

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { serve } from "../src/server.js";
import { SessionStore } from "../src/session-store.js";
import { WorkspaceStore } from "../src/workspace-store.js";

/**
 * Workspace routes cross both security families and aggregate several journals. A dashboard that
 * silently attributes work or findings to the wrong PR is worse than having no dashboard at all.
 */

const KEY_A = "aaaaaaaaaaaaaaaa";
const KEY_B = "bbbbbbbbbbbbbbbb";

/** @param {(input: { base: string, store: SessionStore, workspace: any }) => Promise<void>} body */
async function withWorkspace(body) {
  const dir = await mkdtemp(path.join(tmpdir(), "prc-workspace-routes-"));
  const env = { PR_REVIEW_CANVAS_STATE_DIR: dir };
  const store = new SessionStore({ env });
  const workspaceStore = new WorkspaceStore(env);
  /** @type {Array<[string, number]>} */
  const sessions = [
    [KEY_A, 1],
    [KEY_B, 2],
  ];
  for (const [key, number] of sessions) {
    await store.upsert({
      ref: { host: "github.com", owner: "o", repo: "r", number },
      key,
      accessId: `access-${number}`,
      url: `https://github.com/o/r/pull/${number}`,
      displayRef: `o/r#${number}`,
      headSha: `head-${number}`,
    });
    await store.saveSnapshot(
      key,
      /** @type {any} */ ({
        headSha: `head-${number}`,
        baseSha: "base",
        pr: { number, title: `PR ${number}`, state: "OPEN" },
        counts: { files: 1, additions: 1, deletions: 0 },
        files: [{ path: "src/shared.js", hunks: [] }],
      }),
    );
  }
  const workspace = await workspaceStore.create("release");
  await workspaceStore.add(workspace.id, [KEY_A, KEY_B]);
  const server = await serve({ port: 0, version: "test", idleTimeoutMs: null, store, workspaceStore });
  try {
    await body({ base: `http://127.0.0.1:${server.port}`, store, workspace });
  } finally {
    await server.close();
    await rm(dir, { recursive: true, force: true });
  }
}

test("workspace dashboard reports per-PR counts and overlapping paths", async () => {
  await withWorkspace(async ({ base, workspace }) => {
    const response = await fetch(`${base}/api/ui/w/${workspace.accessId}`);
    assert.equal(response.status, 200);
    const summary = await response.json();
    assert.deepEqual(
      summary.members.map((/** @type {any} */ member) => member.ref),
      ["o/r#1", "o/r#2"],
    );
    assert.deepEqual(summary.overlaps, [{ path: "src/shared.js", sessions: [KEY_A, KEY_B] }]);
    assert.equal(summary.members[0].canvasUrl, `/review/access-1?workspace=${workspace.accessId}`);
    const page = await fetch(`${base}/workspace/${workspace.accessId}`);
    assert.equal(page.status, 200);
    assert.match(await page.text(), /prc-workspace\.js/);

    const memberCanvas = await fetch(`${base}${summary.members[0].canvasUrl}`);
    assert.equal(memberCanvas.status, 200);
    assert.match(
      await memberCanvas.text(),
      new RegExp(`href="/workspace/${workspace.accessId}"[^>]*>&larr; release</a>`),
    );

    const directCanvas = await fetch(`${base}/review/access-1`);
    assert.doesNotMatch(await directCanvas.text(), /prc-workspace-back/);

    const unrelatedCanvas = await fetch(`${base}/review/access-1?workspace=not-a-workspace`);
    assert.doesNotMatch(await unrelatedCanvas.text(), /prc-workspace-back/);

    const crossOriginRefresh = await fetch(`${base}/api/ui/w/${workspace.accessId}/refresh`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: "https://evil.example" },
      body: "{}",
    });
    assert.equal(crossOriginRefresh.status, 403);
  });
});

test("workspace poll labels work with the session it came from", async () => {
  await withWorkspace(async ({ base, store, workspace }) => {
    const at = new Date().toISOString();
    await store.mutate(KEY_B, {
      op: "chat:add",
      at,
      payload: { message: { id: "m_1", role: "user", text: "Check the second PR", at } },
    });
    await store.mutate(KEY_B, {
      op: "work:add",
      at,
      payload: { item: { uid: "w_1", kind: "message", ref: "m_1", at } },
    });
    const response = await fetch(`${base}/api/agent/workspace-poll?workspace=${workspace.id}&timeoutMs=0`);
    assert.equal(response.status, 200);
    const payload = await response.json();
    assert.equal(payload.sessions.length, 1);
    assert.equal(payload.sessions[0].key, KEY_B);
    assert.equal(payload.sessions[0].ref, "o/r#2");
    assert.equal(payload.sessions[0].result.messages[0].text, "Check the second PR");
  });
});

test("findings stay separate from drafts and their UI mutation requires same-origin", async () => {
  await withWorkspace(async ({ base, store }) => {
    const created = await fetch(`${base}/api/agent/sessions/${KEY_A}/findings`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        title: "Shared file risk",
        body: "Both PRs edit this file.",
        severity: "high",
        confidence: 0.9,
        path: "src/shared.js",
        side: "RIGHT",
        line: 1,
      }),
    });
    assert.equal(created.status, 201);
    const finding = (await created.json()).finding;
    assert.equal((await store.load(KEY_A))?.comments.length, 0);

    const crossOrigin = await fetch(`${base}/api/ui/s/access-1/findings/${finding.id}/status`, {
      method: "PUT",
      headers: { "content-type": "application/json", origin: "https://evil.example" },
      body: JSON.stringify({ status: "dismissed" }),
    });
    assert.equal(crossOrigin.status, 403);

    const sameOrigin = await fetch(`${base}/api/ui/s/access-1/findings/${finding.id}/status`, {
      method: "PUT",
      headers: { "content-type": "application/json", origin: base },
      body: JSON.stringify({ status: "acknowledged" }),
    });
    assert.equal(sameOrigin.status, 200);
    assert.equal((await store.load(KEY_A))?.findings[0].status, "acknowledged");
    assert.equal((await store.load(KEY_A))?.comments.length, 0);
  });
});

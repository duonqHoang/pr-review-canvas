import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { WorkspaceStore, workspaceId } from "../src/workspace-store.js";

/**
 * Workspace membership spans otherwise independent PR sessions. These tests pin the important
 * boundary: grouping, ordering and relationships persist without moving or deleting session state.
 */

/** @param {(store: WorkspaceStore) => Promise<void>} body */
async function withStore(body) {
  const dir = await mkdtemp(path.join(tmpdir(), "prc-workspaces-"));
  const store = new WorkspaceStore({ PR_REVIEW_CANVAS_STATE_DIR: dir });
  try {
    await body(store);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("workspace names produce stable ids and random browser access ids", async () => {
  await withStore(async (store) => {
    const workspace = await store.create("Release Train 9");
    assert.equal(workspace.id, "release-train-9");
    assert.match(workspace.accessId, /^[0-9a-f]{32}$/);
    assert.equal(workspaceId(" Release Train 9 "), workspace.id);
    assert.equal((await store.get(workspace.accessId))?.id, workspace.id);
  });
});

test("membership, priority and cross-PR relationships survive a fresh store", async () => {
  await withStore(async (store) => {
    await store.create("stack");
    await store.add("stack", ["aaaaaaaaaaaaaaaa", "bbbbbbbbbbbbbbbb"]);
    await store.setPriority("stack", "bbbbbbbbbbbbbbbb", 1);
    await store.setTheme("stack", "dark");
    await store.setRelation("stack", {
      from: "bbbbbbbbbbbbbbbb",
      to: "aaaaaaaaaaaaaaaa",
      kind: "depends-on",
    });

    const reopened = new WorkspaceStore(store.env);
    const workspace = await reopened.get("stack");
    assert.equal(workspace?.members.length, 2);
    assert.equal(workspace?.members.find((member) => member.sessionKey === "bbbbbbbbbbbbbbbb")?.priority, 1);
    assert.deepEqual(workspace?.prefs, { theme: "dark" });
    assert.deepEqual(workspace?.relations, [{ from: "bbbbbbbbbbbbbbbb", to: "aaaaaaaaaaaaaaaa", kind: "depends-on" }]);

    // Removing membership is intentionally local to the workspace; callers retain both sessions.
    await reopened.remove("stack", ["aaaaaaaaaaaaaaaa"]);
    const reduced = await reopened.get("stack");
    assert.deepEqual(
      reduced?.members.map((member) => member.sessionKey),
      ["bbbbbbbbbbbbbbbb"],
    );
    assert.deepEqual(reduced?.relations, []);
  });
});

test("workspace themes fail closed to system", async () => {
  await withStore(async (store) => {
    await store.create("theme");
    await store.setTheme("theme", "solarized");
    assert.deepEqual((await store.get("theme"))?.prefs, { theme: "system" });
  });
});

test("concurrent membership updates are serialized instead of dropping a PR", async () => {
  await withStore(async (store) => {
    await store.create("parallel");
    await Promise.all([store.add("parallel", ["aaaaaaaaaaaaaaaa"]), store.add("parallel", ["bbbbbbbbbbbbbbbb"])]);
    assert.deepEqual((await store.get("parallel"))?.members.map((member) => member.sessionKey).sort(), [
      "aaaaaaaaaaaaaaaa",
      "bbbbbbbbbbbbbbbb",
    ]);
  });
});

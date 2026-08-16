import { randomBytes } from "node:crypto";
import { readJsonOr, writeJsonAtomic } from "./atomic-json.js";
import { workspaceFile } from "./paths.js";

/**
 * Named review sets live outside sessions because membership is coordination metadata, not review
 * prose. Keeping the stores separate also lets an older build continue loading every PR session:
 * workspace support must never require a SESSION_SCHEMA_VERSION bump.
 */

/** @typedef {"depends-on" | "supersedes" | "alternative-to"} RelationKind */

/**
 * @typedef {object} ReviewWorkspace
 * @property {string} id
 * @property {string} accessId
 * @property {string} name
 * @property {Array<{ sessionKey: string, priority: number, addedAt: string }>} members
 * @property {Array<{ from: string, to: string, kind: RelationKind }>} relations
 * @property {{ theme: "system" | "light" | "dark" }} prefs
 * @property {string} createdAt
 * @property {string} updatedAt
 */

/** @returns {string} */
function newAccessId() {
  return randomBytes(16).toString("hex");
}

/** @param {string} name */
export function workspaceId(name) {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 64);
}

export class WorkspaceStore {
  /** @param {NodeJS.ProcessEnv} [env] */
  constructor(env = process.env) {
    this.env = env;
    /** @type {Promise<unknown>} */
    this.lock = Promise.resolve();
  }

  /** @returns {Promise<{ version: number, workspaces: Record<string, ReviewWorkspace> }>} */
  async read() {
    return readJsonOr(workspaceFile(this.env), { version: 1, workspaces: {} });
  }

  /** @param {() => Promise<unknown>} operation */
  async exclusive(operation) {
    const run = this.lock.then(operation, operation);
    this.lock = run.catch(() => {});
    return run;
  }

  /** @returns {Promise<ReviewWorkspace[]>} */
  async list() {
    return Object.values((await this.read()).workspaces);
  }

  /** @param {string} nameOrId */
  async get(nameOrId) {
    const state = await this.read();
    const id = workspaceId(nameOrId);
    const workspace =
      state.workspaces[id] ?? Object.values(state.workspaces).find((item) => item.accessId === nameOrId) ?? null;
    if (workspace && !workspace.prefs) workspace.prefs = { theme: "system" };
    return workspace;
  }

  /** @param {string} name */
  async create(name) {
    return /** @type {Promise<ReviewWorkspace>} */ (
      this.exclusive(async () => {
        const id = workspaceId(name);
        if (!id) throw new Error("workspace name must contain a letter or number");
        const state = await this.read();
        if (state.workspaces[id]) throw new Error(`workspace already exists: ${name}`);
        const at = new Date().toISOString();
        const workspace = {
          id,
          accessId: newAccessId(),
          name: name.trim(),
          members: [],
          relations: [],
          prefs: { theme: /** @type {const} */ ("system") },
          createdAt: at,
          updatedAt: at,
        };
        state.workspaces[id] = workspace;
        await writeJsonAtomic(workspaceFile(this.env), state);
        return workspace;
      })
    );
  }

  /** @param {string} nameOrId @param {string[]} sessionKeys */
  async add(nameOrId, sessionKeys) {
    return this.update(nameOrId, (workspace) => {
      const at = new Date().toISOString();
      for (const sessionKey of sessionKeys) {
        if (!workspace.members.some((member) => member.sessionKey === sessionKey)) {
          workspace.members.push({ sessionKey, priority: workspace.members.length + 1, addedAt: at });
        }
      }
    });
  }

  /** @param {string} nameOrId @param {string[]} sessionKeys */
  async remove(nameOrId, sessionKeys) {
    return this.update(nameOrId, (workspace) => {
      workspace.members = workspace.members.filter((member) => !sessionKeys.includes(member.sessionKey));
      workspace.relations = workspace.relations.filter(
        (relation) => !sessionKeys.includes(relation.from) && !sessionKeys.includes(relation.to),
      );
    });
  }

  /** @param {string} nameOrId @param {string} sessionKey @param {number} priority */
  async setPriority(nameOrId, sessionKey, priority) {
    return this.update(nameOrId, (workspace) => {
      const currentIndex = workspace.members.findIndex((candidate) => candidate.sessionKey === sessionKey);
      if (currentIndex < 0) throw new Error("PR is not a member of this workspace");
      const [member] = workspace.members.splice(currentIndex, 1);
      const targetIndex = Math.min(workspace.members.length, Math.max(0, Math.trunc(priority) - 1));
      workspace.members.splice(targetIndex, 0, member);
      for (const [index, candidate] of workspace.members.entries()) candidate.priority = index + 1;
    });
  }

  /** @param {string} nameOrId @param {unknown} theme */
  async setTheme(nameOrId, theme) {
    return this.update(nameOrId, (workspace) => {
      workspace.prefs = { theme: theme === "light" || theme === "dark" ? theme : "system" };
    });
  }

  /** @param {string} nameOrId @param {{ from: string, to: string, kind: RelationKind }} relation */
  async setRelation(nameOrId, relation) {
    return this.update(nameOrId, (workspace) => {
      if (relation.from === relation.to) throw new Error("a PR cannot relate to itself");
      if (!workspace.members.some((member) => member.sessionKey === relation.from))
        throw new Error("source PR is not a member");
      if (!workspace.members.some((member) => member.sessionKey === relation.to))
        throw new Error("target PR is not a member");
      workspace.relations = workspace.relations.filter(
        (item) => !(item.from === relation.from && item.to === relation.to),
      );
      workspace.relations.push(relation);
    });
  }

  /** @param {string} nameOrId @param {(workspace: ReviewWorkspace) => void} mutate */
  async update(nameOrId, mutate) {
    return /** @type {Promise<ReviewWorkspace>} */ (
      this.exclusive(async () => {
        const state = await this.read();
        const id = workspaceId(nameOrId);
        const workspace = state.workspaces[id];
        if (!workspace) throw new Error(`unknown workspace: ${nameOrId}`);
        mutate(workspace);
        workspace.updatedAt = new Date().toISOString();
        await writeJsonAtomic(workspaceFile(this.env), state);
        return workspace;
      })
    );
  }
}

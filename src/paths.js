import os from "node:os";
import path from "node:path";

export const DEFAULT_PORT = 4391;

/**
 * Binding to a wildcard means "every interface". The CLI's own control channel still has to
 * pick a concrete address to dial, and it must stay in the same address family: on macOS and
 * BSD a socket bound to `::` with IPV6_V6ONLY set is not reachable over 127.0.0.1.
 */
const WILDCARD_BIND_HOSTS = new Set(["0.0.0.0", "::"]);

/** @param {NodeJS.ProcessEnv} [env] */
export function bindHost(env = process.env) {
  const value = String(env.PR_REVIEW_CANVAS_HOST || "").trim();
  return value || "127.0.0.1";
}

/** The address the CLI dials to reach its own server. @param {NodeJS.ProcessEnv} [env] */
export function clientHost(env = process.env) {
  const host = bindHost(env);
  if (host === "::") return "::1";
  if (host === "0.0.0.0") return "127.0.0.1";
  return host;
}

/** The hostname written into session links handed to the browser. @param {NodeJS.ProcessEnv} [env] */
export function linkHost(env = process.env) {
  const value = String(env.PR_REVIEW_CANVAS_LINK_HOST || "").trim();
  return value || clientHost(env);
}

/** @param {NodeJS.ProcessEnv} [env] @returns {string[]} */
export function extraAllowedHosts(env = process.env) {
  return String(env.PR_REVIEW_CANVAS_ALLOWED_HOSTS || "")
    .split(/\s+/)
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean);
}

/** @param {string} host */
export function isWildcardBindHost(host) {
  return WILDCARD_BIND_HOSTS.has(host);
}

/** Bracket IPv6 literals so they can be embedded in a URL authority. @param {string} host */
export function hostForUrl(host) {
  return host.includes(":") ? `[${host}]` : host;
}

/** @param {NodeJS.ProcessEnv} [env] */
export function resolvePort(env = process.env) {
  return portFromEnv(env) ?? DEFAULT_PORT;
}

/**
 * The port the user asked for, or `null` if they did not ask.
 *
 * The distinction matters for the port ladder: an explicit `PR_REVIEW_CANVAS_PORT` is an
 * instruction and must be obeyed or fail loudly, while the default is only a starting point.
 *
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {number | null}
 */
export function portFromEnv(env = process.env) {
  const raw = String(env.PR_REVIEW_CANVAS_PORT || "").trim();
  if (!raw) return null;
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 0 || port > 65535) return null;
  return port;
}

/** @param {NodeJS.ProcessEnv} [env] */
export function stateDir(env = process.env) {
  const value = String(env.PR_REVIEW_CANVAS_STATE_DIR || "").trim();
  return value || path.join(os.homedir(), ".pr-review-canvas");
}

/** @param {NodeJS.ProcessEnv} [env] */
export function indexFile(env = process.env) {
  return path.join(stateDir(env), "index.json");
}

/** @param {NodeJS.ProcessEnv} [env] */
export function workspaceFile(env = process.env) {
  return path.join(stateDir(env), "workspaces.json");
}

/** @param {NodeJS.ProcessEnv} [env] */
export function serverLogFile(env = process.env) {
  return path.join(stateDir(env), "server.log");
}

/** @param {string} key @param {NodeJS.ProcessEnv} [env] */
export function sessionDir(key, env = process.env) {
  return path.join(stateDir(env), "sessions", key);
}

/** @param {NodeJS.ProcessEnv} [env] */
export function baseUrl(env = process.env) {
  return baseUrlFor(resolvePort(env), env);
}

/** @param {number} port @param {NodeJS.ProcessEnv} [env] */
export function baseUrlFor(port, env = process.env) {
  return `http://${hostForUrl(clientHost(env))}:${port}`;
}

/** Idle self-shutdown, in ms. `null` disables it. @param {NodeJS.ProcessEnv} [env] */
export function resolveIdleTimeoutMs(env = process.env) {
  const DEFAULT = 30 * 60_000;
  const raw = String(env.PR_REVIEW_CANVAS_IDLE_TIMEOUT_MS ?? "").trim();
  if (!raw) return DEFAULT;
  if (raw === "0" || raw.toLowerCase() === "off") return null;
  const ms = Number(raw);
  if (!Number.isFinite(ms) || ms <= 0) return DEFAULT;
  return ms;
}

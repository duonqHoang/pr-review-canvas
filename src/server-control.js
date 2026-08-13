import { execFile } from "node:child_process";
import net from "node:net";
import { promisify } from "node:util";
import { AxiError } from "./axi.js";
import { APP_NAME } from "./server.js";

const execFileAsync = promisify(execFile);

/**
 * Server lifecycle over HTTP. There is deliberately no PID file and no lock file: identity is
 * `port` + `GET /health` + the version and build id it reports. A stale server answers with one of
 * them wrong and gets replaced.
 */

/** @typedef {{ ok?: boolean, app?: string, version?: string, build?: string }} HealthResponse */

/**
 * @param {string} url
 * @param {import("node:http").RequestOptions & { method?: string, body?: string, headers?: Record<string,string> }} [init]
 * @returns {Promise<unknown>}
 */
export async function fetchJson(url, init = {}) {
  let response;
  try {
    response = await fetch(url, /** @type {RequestInit} */ (init));
  } catch (error) {
    throw new AxiError(`Could not reach the ${APP_NAME} server`, "SERVER_ERROR", [
      `Tried ${url}`,
      String(/** @type {{ message?: unknown }} */ (error)?.message || error),
    ]);
  }
  const text = await response.text();
  /** @type {unknown} */
  let parsed = null;
  if (text.trim()) {
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new AxiError(`The ${APP_NAME} server returned a non-JSON response`, "SERVER_ERROR", [
        `${response.status} from ${url}`,
      ]);
    }
  }
  if (!response.ok) {
    const message = String(/** @type {{ error?: unknown }} */ (parsed)?.error || `HTTP ${response.status}`);
    throw new AxiError(message, response.status === 404 ? "NOT_FOUND" : "SERVER_ERROR", [`${response.status} ${url}`]);
  }
  return parsed;
}

/**
 * Probe /health. Swallows every transport error and returns `null`, because "nothing is
 * listening" is a normal, expected state — not an error to report.
 *
 * @param {string} baseUrl
 * @returns {Promise<HealthResponse | null>}
 */
export async function fetchHealth(baseUrl) {
  try {
    const response = await fetch(`${baseUrl}/health`, { cache: "no-store" });
    if (!response.ok) return null;
    const body = /** @type {HealthResponse} */ (await response.json());
    return body && typeof body === "object" ? body : null;
  } catch {
    return null;
  }
}

/** @param {HealthResponse | null} health */
export function isOurServer(health) {
  return Boolean(health && health.app === APP_NAME);
}

/**
 * A healthy server of a different version cannot be trusted to speak the current protocol, so
 * it is replaced rather than reused.
 *
 * The build id is checked as well, and it is the half that matters in development: the version does
 * not change between edits, so on version alone a background server happily served code from ten
 * minutes ago — and the symptom of that is the fix appearing not to work, which is expensive to
 * diagnose and easy to blame on the fix.
 *
 * An empty expected build id means the caller does not know its own — `--dry-run`, a test, a build
 * without the source tree — and in that case the id is not evidence and is ignored.
 *
 * @param {string} version
 * @param {HealthResponse | null} health
 * @param {boolean} [forceRestart]
 * @param {string} [build] the build id this process computed for itself
 */
export function shouldRestartServer(version, health, forceRestart = false, build = "") {
  if (!health) return false; // nothing to restart; the caller starts one
  if (forceRestart) return true;
  const running = String(health.version || "");
  if (!running || running !== version) return true;
  if (!build) return false;
  return String(health.build || "") !== build;
}

/** @param {string} baseUrl */
export async function requestShutdown(baseUrl) {
  try {
    const response = await fetch(`${baseUrl}/shutdown`, { method: "POST" });
    return response.ok;
  } catch {
    return false;
  }
}

/** @param {string} host @param {number} port */
export function isPortFree(host, port) {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port });
    const finish = (/** @type {boolean} */ free) => {
      socket.removeAllListeners();
      socket.destroy();
      resolve(free);
    };
    socket.once("connect", () => finish(false));
    socket.once("error", () => finish(true));
    socket.setTimeout(500, () => finish(true));
  });
}

/** @param {string} host @param {number} port @param {number} timeoutMs */
export async function waitForPortFree(host, port, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await isPortFree(host, port)) return true;
    if (Date.now() >= deadline) return false;
    await delay(100);
  }
}

/** @param {string} baseUrl @param {number} timeoutMs */
export async function waitForHealth(baseUrl, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const health = await fetchHealth(baseUrl);
    if (isOurServer(health)) return health;
    if (Date.now() >= deadline) return null;
    await delay(100);
  }
}

/**
 * Find the PID listening on a port and confirm it looks like ours before signalling it.
 * macOS/Linux only; on Windows we simply skip the fallback and let the health wait fail.
 *
 * @param {number} port
 * @returns {Promise<{ pid: number, command: string } | null>}
 */
export async function processOnPort(port) {
  if (process.platform === "win32") return null;
  try {
    const { stdout } = await execFileAsync("lsof", ["-t", `-iTCP:${port}`, "-sTCP:LISTEN"]);
    const pid = Number(String(stdout).trim().split(/\s+/)[0]);
    if (!Number.isInteger(pid) || pid <= 0) return null;
    const { stdout: cmd } = await execFileAsync("ps", ["-p", String(pid), "-o", "command="]);
    return { pid, command: String(cmd).trim() };
  } catch {
    return null;
  }
}

/** @param {number} port */
export async function processOnPortMatchesApp(port) {
  const found = await processOnPort(port);
  if (!found) return false;
  return found.command.includes(APP_NAME) || /\bcli\.mjs\b.*\bserver\b/.test(found.command);
}

/** @param {number} port */
export async function killProcessOnPort(port) {
  const found = await processOnPort(port);
  if (!found) return false;
  try {
    process.kill(found.pid, "SIGTERM");
    return true;
  } catch {
    return false;
  }
}

/** @param {number} ms */
export function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Spawn the server detached and wait for it to answer /health.
 *
 * `detached` plus `unref` means the server outlives the CLI invocation that started it, which is
 * the whole point: the human keeps reviewing in the browser long after `open` has returned.
 *
 * @param {object} input
 * @param {number} input.port
 * @param {string} input.entry path to the CLI entry point to re-exec
 * @param {string} input.logFile
 * @returns {Promise<void>}
 */
export async function startServer({ port, entry, logFile }) {
  const { open: openFile, mkdir } = await import("node:fs/promises");
  const { spawn } = await import("node:child_process");
  const nodePath = await import("node:path");

  await mkdir(nodePath.dirname(logFile), { recursive: true });
  const handle = await openFile(logFile, "a");
  try {
    const child = spawn(process.execPath, [entry, "server", "--port", String(port)], {
      detached: true,
      stdio: ["ignore", handle.fd, handle.fd],
      env: { ...process.env },
    });
    child.unref();
  } finally {
    await handle.close();
  }
}

/** How many ports past the default to try when something unrelated is holding one. */
export const PORT_LADDER_LENGTH = 10;

/**
 * The ports to try, in order.
 *
 * A recorded port comes first so a server that ended up on 4393 last time is found there rather
 * than being orphaned by a new one starting on a since-freed 4391 — its sessions are live and a
 * browser tab is pointed at it.
 *
 * @param {object} input
 * @param {number} input.port the starting point
 * @param {number | null} [input.preferPort] the port a previous run recorded
 * @param {boolean} [input.ladder] false when the user named a port explicitly
 * @returns {number[]}
 */
export function portCandidates({ port, preferPort, ladder = true }) {
  /** @type {number[]} */
  const candidates = [];
  const push = (/** @type {number} */ value) => {
    if (value > 0 && value <= 65535 && !candidates.includes(value)) candidates.push(value);
  };
  if (preferPort) push(preferPort);
  push(port);
  // Port 0 means "any free port" — laddering from it is meaningless.
  if (ladder && port > 0) for (let step = 1; step < PORT_LADDER_LENGTH; step += 1) push(port + step);
  return candidates;
}

/**
 * Ensure a healthy server of the current version is listening, starting or replacing one if not.
 *
 * When something unrelated holds the port, this walks up the ladder rather than failing. A review
 * session outlives a great many other processes' idea of what port 4391 is for, and a hard error
 * there means the user cannot review at all until they go hunting — hostile for the sake of purity.
 * An explicitly set `PR_REVIEW_CANVAS_PORT` still fails loudly, because that was an instruction.
 *
 * @param {object} input
 * @param {(port: number) => string} input.baseUrlFor
 * @param {string} input.host
 * @param {number} input.port
 * @param {string} input.version
 * @param {string} input.entry
 * @param {string} input.logFile
 * @param {number | null} [input.preferPort]
 * @param {boolean} [input.ladder]
 * @param {string} [input.build]
 * @param {(port: number) => Promise<void> | void} [input.onPortChosen]
 * @returns {Promise<{ started: boolean, port: number, baseUrl: string }>}
 */
export async function ensureServer({
  baseUrlFor,
  host,
  port,
  version,
  entry,
  logFile,
  preferPort = null,
  ladder = true,
  build = "",
  onPortChosen,
}) {
  const candidates = portCandidates({ port, preferPort, ladder });
  /** @type {Array<{ port: number, command: string | null }>} */
  const occupied = [];

  for (const candidate of candidates) {
    const url = baseUrlFor(candidate);
    const health = await fetchHealth(url);

    if (health && !isOurServer(health)) {
      // Someone else's server. Step over it instead of arguing with it.
      occupied.push({ port: candidate, command: (await processOnPort(candidate))?.command ?? null });
      continue;
    }

    if (health && !shouldRestartServer(version, health, false, build)) {
      await onPortChosen?.(candidate);
      return { started: false, port: candidate, baseUrl: url };
    }

    if (health) {
      // Ours, wrong version: it cannot be trusted to speak the current protocol. Replaced in place
      // rather than started elsewhere, because its state directory and any open tab point here.
      await requestShutdown(url);
      if (!(await waitForPortFree(host, candidate, 2000))) {
        await killProcessOnPort(candidate);
        await waitForPortFree(host, candidate, 3000);
      }
    }

    await startServer({ port: candidate, entry, logFile });
    const ready = await waitForHealth(url, 5000);
    if (!ready) {
      throw new AxiError("The review server did not start", "SERVER_ERROR", [
        `Nothing answered ${url}/health within 5s`,
        `Check ${logFile}`,
      ]);
    }
    await onPortChosen?.(candidate);
    return { started: true, port: candidate, baseUrl: url };
  }

  const listed = occupied.map((entry2) => `${entry2.port}: ${entry2.command ?? "unidentified process"}`);
  throw new AxiError(
    candidates.length === 1
      ? `Port ${candidates[0]} is occupied by a different server`
      : `Ports ${candidates[0]}-${candidates[candidates.length - 1]} are all occupied by other servers`,
    "SERVER_ERROR",
    [...listed, "Set PR_REVIEW_CANVAS_PORT to choose a port explicitly"],
  );
}

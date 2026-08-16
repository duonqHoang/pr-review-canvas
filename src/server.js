import { EventEmitter } from "node:events";
import express from "express";
import { buildId } from "./build-id.js";
import { allowsAllHosts, buildAllowedHostnames, isAllowedRequestHost } from "./host-guard.js";
import {
  bindHost as defaultBindHost,
  extraAllowedHosts as defaultExtraAllowedHosts,
  linkHost as defaultLinkHost,
  resolveIdleTimeoutMs,
  resolvePort,
} from "./paths.js";
import { registerRoutes } from "./server-routes.js";
import { SessionStore } from "./session-store.js";
import { WorkspaceStore } from "./workspace-store.js";

export const APP_NAME = "pr-review-canvas";

/**
 * @typedef {object} ServeOptions
 * @property {number} [port]
 * @property {string} [host]
 * @property {string} [linkHost]
 * @property {string[]} [allowedHosts]
 * @property {string} [version]
 * @property {number | null} [idleTimeoutMs]
 * @property {boolean} [debug]
 * @property {import("./session-store.js").SessionStore} [store] test seam
 * @property {import("./workspace-store.js").WorkspaceStore} [workspaceStore] test seam
 * @property {import("./server-routes.js").RouteSeams} [seams] test seams for the routes that call gh
 * @property {NodeJS.ProcessEnv} [env]
 */

/**
 * @typedef {object} ServerHandle
 * @property {number} port
 * @property {() => Promise<void>} close
 * @property {Promise<void>} done
 */

/**
 * @param {ServeOptions} [options]
 * @returns {Promise<ServerHandle>}
 */
export async function serve(options = {}) {
  const host = options.host ?? defaultBindHost();
  const link = options.linkHost ?? defaultLinkHost();
  const allowedHostList = options.allowedHosts ?? defaultExtraAllowedHosts();
  const port = options.port ?? resolvePort();
  const version = options.version ?? "";
  const idleTimeoutMs = options.idleTimeoutMs === undefined ? resolveIdleTimeoutMs() : options.idleTimeoutMs;
  const debug = Boolean(options.debug);

  /** @param {...unknown} args */
  const log = (...args) => {
    if (debug) console.error(`[${APP_NAME}]`, ...args);
  };

  const app = express();
  app.disable("x-powered-by");

  /** Wakeups for long-polls and SSE. Filled in from M3 onward. */
  const events = new EventEmitter();
  events.setMaxListeners(0);

  /** Open SSE responses, used for idle accounting and shutdown broadcasts. @type {Set<import("express").Response>} */
  const sseClients = new Set();
  /** Ref-counted long-polls per session key. @type {Map<string, number>} */
  const activePolls = new Map();
  /** Keys whose work has been handed to an agent that has not reported back yet. @type {Set<string>} */
  const deliveredWork = new Set();

  const store = options.store ?? new SessionStore({ env: options.env });
  const workspaceStore = options.workspaceStore ?? new WorkspaceStore(options.env);

  const allowedHostnames = buildAllowedHostnames({ host, linkHost: link, allowedHosts: allowedHostList });
  const skipHostCheck = allowsAllHosts(allowedHostList);

  // FIRST middleware, before any body parser: see host-guard.js for why this and not
  // same-origin alone. Rejecting here means a rebound request never reaches a parser.
  if (!skipHostCheck) {
    app.use((req, res, next) => {
      const ok = isAllowedRequestHost(
        { host: req.headers.host, forwardedHost: /** @type {string | undefined} */ (req.headers["x-forwarded-host"]) },
        allowedHostnames,
      );
      if (ok) return next();
      log("rejected host", req.headers.host, req.headers["x-forwarded-host"]);
      res.status(403).json({ error: "forbidden host" });
    });
  }

  app.use(express.json({ limit: "2mb" }));

  // Computed at boot, not per request: it cannot change while this process is running, since the
  // modules it describes are already loaded.
  const build = await buildId().catch(() => "");

  app.get("/health", (req, res) => {
    res.json({ ok: true, app: APP_NAME, version, build });
  });

  app.post("/shutdown", (req, res) => {
    res.json({ status: "shutting-down" });
    setImmediate(() => {
      shutdown().catch((error) => log("shutdown failed", error));
    });
  });

  registerRoutes({
    app,
    store,
    workspaceStore,
    events,
    sseClients,
    activePolls,
    deliveredWork,
    refreshIdleTimer: () => refreshIdleTimer(),
    version,
    log,
    ...(options.seams ?? {}),
  });

  /**
   * @param {unknown} error
   * @param {import("express").Request} req
   * @param {import("express").Response} res
   * @param {import("express").NextFunction} next
   */
  // eslint-disable-next-line no-unused-vars
  const errorHandler = (error, req, res, next) => {
    // Preserve body-parser statuses (413/400) instead of flattening everything to 500.
    const status = Number(/** @type {{ status?: unknown }} */ (error)?.status) || 500;
    log("request failed", error);
    if (res.headersSent) {
      res.end();
      return;
    }
    res.status(status).json({ error: String(/** @type {{ message?: unknown }} */ (error)?.message || "server error") });
  };
  app.use(errorHandler);

  /** @type {NodeJS.Timeout | null} */
  let idleTimer = null;
  let shuttingDown = false;
  /** @type {() => void} */
  let resolveDone = () => {};
  const done = /** @type {Promise<void>} */ (
    new Promise((resolve) => {
      resolveDone = () => resolve();
    })
  );

  function refreshIdleTimer() {
    if (idleTimer) {
      clearTimeout(idleTimer);
      idleTimer = null;
    }
    if (shuttingDown || idleTimeoutMs == null) return;
    if (sseClients.size > 0 || activePolls.size > 0) return;
    idleTimer = setTimeout(() => {
      if (shuttingDown || sseClients.size > 0 || activePolls.size > 0) return;
      log("idle timeout reached, shutting down");
      shutdown().catch((error) => log("idle shutdown failed", error));
    }, idleTimeoutMs);
    idleTimer.unref?.();
  }

  async function shutdown() {
    if (shuttingDown) return done;
    shuttingDown = true;
    if (idleTimer) clearTimeout(idleTimer);

    // Tell every open chrome to reconnect after the (possibly upgraded) server comes back,
    // then release the connections so httpServer.close() can actually finish.
    for (const client of sseClients) {
      try {
        client.write("event: chrome-reload\ndata: {}\n\n");
        client.end();
      } catch {
        /* the client is already gone; nothing to do */
      }
    }
    sseClients.clear();

    await new Promise((resolve) => httpServer.close(() => resolve(undefined)));
    httpServer.closeAllConnections?.();
    // Only now, with nothing new arriving, is it safe to wait for what is already running. A draft
    // save that was mid-journal-append when the shutdown arrived finishes here; without this the
    // process could exit between the append and the fold-cache rewrite. That is recoverable, but a
    // save still in its route handler when the socket closed is not.
    await store.drain();
    resolveDone();
    return done;
  }

  const httpServer = await new Promise((resolve, reject) => {
    const server = app.listen(port, host, () => resolve(server));
    server.on("error", reject);
  });

  const address = httpServer.address();
  const publicPort = typeof address === "object" && address ? address.port : port;

  // Arm the timer at boot so a server that is spawned but never used still reaps itself.
  refreshIdleTimer();

  // Deliberately not awaited: sweeping crash leftovers is housekeeping, and nothing should wait for
  // it before the first request can be served.
  store.sweepTempFiles().then(
    (removed) => {
      if (removed.length > 0) log(`swept ${removed.length} temp file(s) left by an earlier crash`);
    },
    (error) => log("temp sweep failed", error),
  );

  return { port: publicPort, close: () => shutdown(), done };
}

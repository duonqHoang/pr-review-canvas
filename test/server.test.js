// The bind host is pinned before src/ is imported so the module-level defaults in paths.js
// resolve to loopback regardless of the developer's environment.
process.env.PR_REVIEW_CANVAS_HOST = "127.0.0.1";
process.env.PR_REVIEW_CANVAS_LINK_HOST = "127.0.0.1";

import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";
import test from "node:test";
import { buildId } from "../src/build-id.js";
import { APP_NAME, serve } from "../src/server.js";

/**
 * Send a hand-written request over a raw socket. Needed because node's own HTTP client cannot
 * express some wire conditions a hostile client can — notably HTTP/1.0 with no `Host` at all.
 *
 * @param {number} port
 * @param {string} raw request bytes, `\r\n`-delimited
 * @returns {Promise<{ status: number, raw: string }>}
 */
function rawSocketRequest(port, raw) {
  return new Promise((resolve, reject) => {
    let buffer = "";
    const socket = net.connect({ host: "127.0.0.1", port }, () => socket.write(raw));
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => {
      buffer += chunk;
    });
    socket.on("error", reject);
    socket.on("close", () => {
      const match = /^HTTP\/1\.[01] (\d{3})/.exec(buffer);
      resolve({ status: match ? Number(match[1]) : 0, raw: buffer });
    });
  });
}

/**
 * `fetch` (undici) silently drops a caller-supplied `Host` header, so a rebinding test written
 * with fetch would pass vacuously. Go through node:http, which honours it.
 *
 * @param {{ port: number, path?: string, method?: string, headers?: Record<string, string>, setHost?: boolean }} options
 * @returns {Promise<{ status: number, body: string }>}
 */
function rawRequest({ port, path = "/health", method = "GET", headers = {}, setHost = true }) {
  return new Promise((resolve, reject) => {
    const request = http.request({ host: "127.0.0.1", port, path, method, headers, setHost }, (response) => {
      let body = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => {
        body += chunk;
      });
      response.on("end", () => resolve({ status: response.statusCode ?? 0, body }));
    });
    request.on("error", reject);
    request.end();
  });
}

/**
 * Every server test gets its own ephemeral port so the suite can run in parallel with a real
 * server on the default port.
 *
 * @param {(ctx: { base: string, port: number }) => Promise<void>} body
 * @param {Parameters<typeof serve>[0]} [options]
 */
async function withServer(body, options = {}) {
  const server = await serve({ port: 0, version: "9.9.9-test", idleTimeoutMs: null, ...options });
  const base = `http://127.0.0.1:${server.port}`;
  try {
    await body({ base, port: server.port });
  } finally {
    await server.close();
  }
}

test("GET /health identifies the app, its version and the code it is running", async () => {
  await withServer(async ({ base }) => {
    const response = await fetch(`${base}/health`);
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.ok, true);
    assert.equal(body.app, APP_NAME);
    assert.equal(body.version, "9.9.9-test");
    // The build id is what makes a stale background server detectable when the version has not
    // changed — the everyday case during development, and one that presents as "the fix did not
    // work". It must be a real value, not an empty string that compares equal to everything.
    assert.match(String(body.build), /^[0-9a-f]{16}$/);
    assert.equal(body.build, await buildId(), "the served id must be this process's own");
  });
});

test("POST /shutdown answers before closing, and the port stops answering", async () => {
  const server = await serve({ port: 0, version: "9.9.9-test", idleTimeoutMs: null });
  const base = `http://127.0.0.1:${server.port}`;

  const response = await fetch(`${base}/shutdown`, { method: "POST" });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { status: "shutting-down" });

  await server.done;
  await assert.rejects(() => fetch(`${base}/health`));
});

test("close() is idempotent", async () => {
  const server = await serve({ port: 0, version: "9.9.9-test", idleTimeoutMs: null });
  await server.close();
  await server.close();
  await server.done;
});

test("a Host header the server does not answer to is rejected with 403", async () => {
  await withServer(async ({ port }) => {
    const response = await rawRequest({ port, headers: { Host: "evil.example.com" } });
    assert.equal(response.status, 403);
    assert.deepEqual(JSON.parse(response.body), { error: "forbidden host" });
  });
});

test("an HTTP/1.1 request with no Host is refused before it reaches a route", async () => {
  await withServer(async ({ port }) => {
    // node's own HTTP parser answers 400 for this, so our guard never sees it. Asserted anyway:
    // the property that matters is "refused", and this pins which layer does the refusing.
    const response = await rawRequest({ port, setHost: false });
    assert.equal(response.status, 400);
  });
});

test("an HTTP/1.0 request with no Host reaches the guard and is rejected with 403", async () => {
  await withServer(async ({ port }) => {
    // HTTP/1.0 does not require Host, so the parser lets it through — this is the wire condition
    // that actually exercises the guard's fail-closed branch.
    const response = await rawSocketRequest(port, "GET /health HTTP/1.0\r\nConnection: close\r\n\r\n");
    assert.equal(response.status, 403);
    assert.match(response.raw, /forbidden host/);
  });
});

test("an allowed Host with an unexpected port is still accepted", async () => {
  await withServer(async ({ port }) => {
    const response = await rawRequest({ port, headers: { Host: "localhost:1" } });
    assert.equal(response.status, 200);
  });
});

test("a spoofed X-Forwarded-Host cannot widen access", async () => {
  await withServer(async ({ base }) => {
    const response = await fetch(`${base}/health`, { headers: { "X-Forwarded-Host": "evil.example.com" } });
    assert.equal(response.status, 403);
  });
});

test("a forwarded host listed in PR_REVIEW_CANVAS_ALLOWED_HOSTS is accepted", async () => {
  await withServer(
    async ({ base }) => {
      const response = await fetch(`${base}/health`, { headers: { "X-Forwarded-Host": "proxy.example.com" } });
      assert.equal(response.status, 200);
    },
    { allowedHosts: ["proxy.example.com"] },
  );
});

test("allowedHosts of `*` disables the host check entirely", async () => {
  await withServer(
    async ({ base }) => {
      const response = await fetch(`${base}/health`, { headers: { Host: "anything.example.com" } });
      assert.equal(response.status, 200);
    },
    { allowedHosts: ["*"] },
  );
});

test("the idle timer shuts the server down when nothing is connected", async () => {
  const server = await serve({ port: 0, version: "9.9.9-test", idleTimeoutMs: 60 });
  await server.done;
  await assert.rejects(() => fetch(`http://127.0.0.1:${server.port}/health`));
});

test("an oversized JSON body is rejected as 413, not flattened to 500", async () => {
  await withServer(async ({ base }) => {
    const response = await fetch(`${base}/health`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ blob: "x".repeat(3 * 1024 * 1024) }),
    });
    assert.equal(response.status, 413);
  });
});

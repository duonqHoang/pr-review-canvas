import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import {
  baseUrl,
  bindHost,
  clientHost,
  DEFAULT_PORT,
  extraAllowedHosts,
  hostForUrl,
  indexFile,
  isWildcardBindHost,
  linkHost,
  resolveIdleTimeoutMs,
  resolvePort,
  serverLogFile,
  sessionDir,
  stateDir,
} from "../src/paths.js";

test("bindHost defaults to loopback", () => {
  assert.equal(bindHost({}), "127.0.0.1");
  assert.equal(bindHost({ PR_REVIEW_CANVAS_HOST: "  " }), "127.0.0.1");
  assert.equal(bindHost({ PR_REVIEW_CANVAS_HOST: "0.0.0.0" }), "0.0.0.0");
});

test("clientHost folds a wildcard bind to the same-family loopback", () => {
  // A socket bound to `::` with IPV6_V6ONLY is unreachable over 127.0.0.1 on macOS/BSD, so the
  // family must be preserved rather than always collapsing to IPv4.
  assert.equal(clientHost({ PR_REVIEW_CANVAS_HOST: "::" }), "::1");
  assert.equal(clientHost({ PR_REVIEW_CANVAS_HOST: "0.0.0.0" }), "127.0.0.1");
  assert.equal(clientHost({ PR_REVIEW_CANVAS_HOST: "192.168.1.5" }), "192.168.1.5");
});

test("linkHost falls back to clientHost", () => {
  assert.equal(linkHost({}), "127.0.0.1");
  assert.equal(linkHost({ PR_REVIEW_CANVAS_LINK_HOST: "review.local" }), "review.local");
  assert.equal(linkHost({ PR_REVIEW_CANVAS_HOST: "::" }), "::1");
});

test("hostForUrl brackets IPv6 literals only", () => {
  assert.equal(hostForUrl("::1"), "[::1]");
  assert.equal(hostForUrl("127.0.0.1"), "127.0.0.1");
  assert.equal(hostForUrl("localhost"), "localhost");
});

test("isWildcardBindHost recognises both wildcards", () => {
  assert.equal(isWildcardBindHost("0.0.0.0"), true);
  assert.equal(isWildcardBindHost("::"), true);
  assert.equal(isWildcardBindHost("127.0.0.1"), false);
});

test("extraAllowedHosts splits on whitespace and lowercases", () => {
  assert.deepEqual(extraAllowedHosts({ PR_REVIEW_CANVAS_ALLOWED_HOSTS: " Review.Local\tother.host " }), [
    "review.local",
    "other.host",
  ]);
  assert.deepEqual(extraAllowedHosts({}), []);
});

test("resolvePort rejects nonsense and falls back to the default", () => {
  assert.equal(resolvePort({}), DEFAULT_PORT);
  assert.equal(resolvePort({ PR_REVIEW_CANVAS_PORT: "5000" }), 5000);
  assert.equal(resolvePort({ PR_REVIEW_CANVAS_PORT: "0" }), 0);
  assert.equal(resolvePort({ PR_REVIEW_CANVAS_PORT: "-1" }), DEFAULT_PORT);
  assert.equal(resolvePort({ PR_REVIEW_CANVAS_PORT: "99999" }), DEFAULT_PORT);
  assert.equal(resolvePort({ PR_REVIEW_CANVAS_PORT: "abc" }), DEFAULT_PORT);
});

test("state paths honour PR_REVIEW_CANVAS_STATE_DIR", () => {
  const env = { PR_REVIEW_CANVAS_STATE_DIR: "/tmp/prc-state" };
  assert.equal(stateDir(env), "/tmp/prc-state");
  assert.equal(indexFile(env), path.join("/tmp/prc-state", "index.json"));
  assert.equal(serverLogFile(env), path.join("/tmp/prc-state", "server.log"));
  assert.equal(sessionDir("9f3a1b2c3d4e5f60", env), path.join("/tmp/prc-state", "sessions", "9f3a1b2c3d4e5f60"));
});

test("baseUrl brackets IPv6 and includes the port", () => {
  assert.equal(baseUrl({ PR_REVIEW_CANVAS_PORT: "4391" }), "http://127.0.0.1:4391");
  assert.equal(baseUrl({ PR_REVIEW_CANVAS_HOST: "::1", PR_REVIEW_CANVAS_PORT: "4391" }), "http://[::1]:4391");
});

test("resolveIdleTimeoutMs treats 0 and off as disabled", () => {
  assert.equal(resolveIdleTimeoutMs({}), 30 * 60_000);
  assert.equal(resolveIdleTimeoutMs({ PR_REVIEW_CANVAS_IDLE_TIMEOUT_MS: "0" }), null);
  assert.equal(resolveIdleTimeoutMs({ PR_REVIEW_CANVAS_IDLE_TIMEOUT_MS: "off" }), null);
  assert.equal(resolveIdleTimeoutMs({ PR_REVIEW_CANVAS_IDLE_TIMEOUT_MS: "OFF" }), null);
  assert.equal(resolveIdleTimeoutMs({ PR_REVIEW_CANVAS_IDLE_TIMEOUT_MS: "5000" }), 5000);
  // Nonsense falls back to the default rather than disabling protection by accident.
  assert.equal(resolveIdleTimeoutMs({ PR_REVIEW_CANVAS_IDLE_TIMEOUT_MS: "-5" }), 30 * 60_000);
  assert.equal(resolveIdleTimeoutMs({ PR_REVIEW_CANVAS_IDLE_TIMEOUT_MS: "nope" }), 30 * 60_000);
});

import assert from "node:assert/strict";
import test from "node:test";
import {
  allowsAllHosts,
  buildAllowedHostnames,
  hostnameFromHostHeader,
  isAllowedHostHeader,
  isAllowedRequestHost,
  isSameOriginRequest,
} from "../src/host-guard.js";

const loopbackSet = buildAllowedHostnames({ host: "127.0.0.1", linkHost: "127.0.0.1", allowedHosts: [] });

test("buildAllowedHostnames always includes the loopback names", () => {
  assert.equal(loopbackSet.has("127.0.0.1"), true);
  assert.equal(loopbackSet.has("::1"), true);
  assert.equal(loopbackSet.has("localhost"), true);
});

test("buildAllowedHostnames adds bind host, link host and extras, lowercased", () => {
  const allowed = buildAllowedHostnames({
    host: "192.168.1.5",
    linkHost: "Review.Local",
    allowedHosts: ["proxy.example.com"],
  });
  assert.equal(allowed.has("192.168.1.5"), true);
  assert.equal(allowed.has("review.local"), true);
  assert.equal(allowed.has("proxy.example.com"), true);
});

test("buildAllowedHostnames never adds a wildcard bind or a bare star as a name", () => {
  const allowed = buildAllowedHostnames({ host: "0.0.0.0", linkHost: "::", allowedHosts: ["*"] });
  assert.equal(allowed.has("0.0.0.0"), false);
  assert.equal(allowed.has("::"), false);
  assert.equal(allowed.has("*"), false);
});

test("allowsAllHosts only trips on an explicit star", () => {
  assert.equal(allowsAllHosts(["*"]), true);
  assert.equal(allowsAllHosts(["review.local"]), false);
  assert.equal(allowsAllHosts([]), false);
});

test("hostnameFromHostHeader parses the shapes a client can actually send", () => {
  assert.equal(hostnameFromHostHeader("127.0.0.1:4391"), "127.0.0.1");
  assert.equal(hostnameFromHostHeader("localhost"), "localhost");
  assert.equal(hostnameFromHostHeader("LOCALHOST:80"), "localhost");
  assert.equal(hostnameFromHostHeader("[::1]:4391"), "::1");
  assert.equal(hostnameFromHostHeader("[::1]"), "::1");
});

test("hostnameFromHostHeader fails closed on anything ambiguous", () => {
  assert.equal(hostnameFromHostHeader(""), null);
  assert.equal(hostnameFromHostHeader("   "), null);
  assert.equal(hostnameFromHostHeader(undefined), null);
  assert.equal(hostnameFromHostHeader(null), null);
  // An unbracketed IPv6 literal is not legal here; parsing it would mistake "::1" for
  // host "" port "1".
  assert.equal(hostnameFromHostHeader("::1"), null);
  assert.equal(hostnameFromHostHeader("[::1]junk"), null);
  assert.equal(hostnameFromHostHeader("[::1"), null);
  assert.equal(hostnameFromHostHeader("[]:80"), null);
});

test("isAllowedHostHeader rejects a missing Host", () => {
  assert.equal(isAllowedHostHeader(undefined, loopbackSet), false);
  assert.equal(isAllowedHostHeader("", loopbackSet), false);
  assert.equal(isAllowedHostHeader("evil.example.com", loopbackSet), false);
  assert.equal(isAllowedHostHeader("localhost:4391", loopbackSet), true);
});

test("isAllowedRequestHost requires Host AND the last forwarded segment", () => {
  assert.equal(isAllowedRequestHost({ host: "localhost:4391" }, loopbackSet), true);
  assert.equal(isAllowedRequestHost({ host: "localhost:4391", forwardedHost: "" }, loopbackSet), true);
  assert.equal(isAllowedRequestHost({ host: "evil.example.com" }, loopbackSet), false);
  // A spoofed forwarded host can only narrow access, never widen it.
  assert.equal(isAllowedRequestHost({ host: "localhost:4391", forwardedHost: "evil.example.com" }, loopbackSet), false);
  assert.equal(
    isAllowedRequestHost({ host: "localhost:4391", forwardedHost: "evil.example.com, localhost" }, loopbackSet),
    true,
  );
  assert.equal(
    isAllowedRequestHost({ host: "localhost:4391", forwardedHost: "localhost, evil.example.com" }, loopbackSet),
    false,
  );
});

test("isSameOriginRequest compares against this server's own origin", () => {
  const self = { protocol: "http", host: "127.0.0.1:4391" };
  assert.equal(isSameOriginRequest({ ...self, origin: "http://127.0.0.1:4391" }), true);
  assert.equal(isSameOriginRequest({ ...self, referer: "http://127.0.0.1:4391/review/abc" }), true);
  assert.equal(isSameOriginRequest({ ...self, origin: "http://127.0.0.1:4392" }), false);
  assert.equal(isSameOriginRequest({ ...self, origin: "https://127.0.0.1:4391" }), false);
  assert.equal(isSameOriginRequest({ ...self, origin: "http://evil.example.com" }), false);
  // No Origin and no Referer at all is a rejection: every fetch the client makes sends one.
  assert.equal(isSameOriginRequest(self), false);
  assert.equal(isSameOriginRequest({ ...self, origin: "not a url" }), false);
});

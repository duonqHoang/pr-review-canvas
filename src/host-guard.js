import { isWildcardBindHost } from "./paths.js";

/**
 * DNS-rebinding defense.
 *
 * A same-origin check alone cannot stop rebinding: a rebound page sends the hostile domain in
 * BOTH `Origin` and `Host`, so the two agree and the request looks same-origin. The only thing
 * that catches it is refusing any `Host` this server does not answer to. Hence this guard runs
 * before every route, including before the body parsers.
 */

/**
 * @param {{ host: string, linkHost: string, allowedHosts: string[] }} config
 * @returns {Set<string>}
 */
export function buildAllowedHostnames({ host, linkHost, allowedHosts }) {
  const names = new Set(["127.0.0.1", "::1", "localhost"]);
  for (const candidate of [host, linkHost, ...allowedHosts]) {
    const value = String(candidate || "")
      .trim()
      .toLowerCase();
    // A wildcard bind is not a name anyone can send in a Host header, and "*" is handled by
    // allowsAllHosts, not by being added to the set.
    if (!value || value === "*" || isWildcardBindHost(value)) continue;
    names.add(value);
  }
  return names;
}

/** A lone `*` in PR_REVIEW_CANVAS_ALLOWED_HOSTS turns the guard off entirely. @param {string[]} allowedHosts */
export function allowsAllHosts(allowedHosts) {
  return allowedHosts.includes("*");
}

/**
 * Extract the hostname from a `Host` header value.
 *
 * Returns `null` for anything it cannot parse confidently — the caller treats that as a
 * rejection, so ambiguity fails closed.
 *
 * @param {string | undefined | null} header
 * @returns {string | null}
 */
export function hostnameFromHostHeader(header) {
  const raw = String(header ?? "").trim();
  if (!raw) return null;

  if (raw.startsWith("[")) {
    const close = raw.indexOf("]");
    if (close < 0) return null;
    const inner = raw.slice(1, close).trim().toLowerCase();
    if (!inner) return null;
    // Only an optional ":port" may follow the bracket.
    const rest = raw.slice(close + 1);
    if (rest && !/^:\d+$/.test(rest)) return null;
    return inner;
  }

  // A bare unbracketed IPv6 literal is not a legal Host header; rejecting it keeps us from
  // mistaking "::1" for host "" port "1".
  const colons = raw.split(":").length - 1;
  if (colons > 1) return null;
  const hostname = raw.split(":")[0].trim().toLowerCase();
  return hostname || null;
}

/** @param {string | undefined | null} header @param {Set<string>} allowed */
export function isAllowedHostHeader(header, allowed) {
  const hostname = hostnameFromHostHeader(header);
  if (!hostname) return false;
  return allowed.has(hostname);
}

/**
 * The `Host` must pass, AND — when an `X-Forwarded-Host` is present — its last comma segment
 * must pass too. The AND means a spoofed forwarded host can only ever narrow access.
 *
 * @param {{ host?: string | null, forwardedHost?: string | null }} headers
 * @param {Set<string>} allowed
 */
export function isAllowedRequestHost({ host, forwardedHost }, allowed) {
  if (!isAllowedHostHeader(host, allowed)) return false;

  const forwarded = String(forwardedHost ?? "").trim();
  if (!forwarded) return true;

  const segments = forwarded.split(",");
  const last = segments[segments.length - 1];
  return isAllowedHostHeader(last, allowed);
}

/**
 * CSRF guard for state-changing browser routes. No `Origin` and no `Referer` is a rejection:
 * every fetch the client makes sends one.
 *
 * @param {{ origin?: string | null, referer?: string | null, protocol: string, host?: string | null }} req
 */
export function isSameOriginRequest({ origin, referer, protocol, host }) {
  const selfOrigin = `${protocol}://${String(host ?? "").trim()}`;
  const candidate = String(origin ?? "").trim() || String(referer ?? "").trim();
  if (!candidate) return false;
  try {
    return new URL(candidate).origin === selfOrigin;
  } catch {
    return false;
  }
}

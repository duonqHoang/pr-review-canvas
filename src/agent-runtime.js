/**
 * Agent identity is presentation metadata, never authorization.
 *
 * A poll can come from Codex, Claude Code, OpenCode or an unknown harness. The canvas uses that fact
 * only to name the place where work may be blocked; trusting it for access would let any loopback
 * caller acquire a stronger capability by changing one query parameter.
 */

export const AGENT_RUNTIMES = /** @type {const} */ (["codex", "claude", "opencode", "generic"]);

/** @param {unknown} value */
export function normalizeAgentRuntime(value) {
  const candidate = String(value ?? "")
    .trim()
    .toLowerCase();
  if (candidate === "claude-code") return "claude";
  if (candidate === "open-code") return "opencode";
  return /** @type {(typeof AGENT_RUNTIMES)[number]} */ (
    AGENT_RUNTIMES.includes(/** @type {any} */ (candidate)) ? candidate : "generic"
  );
}

/**
 * Detect common local harnesses. `PR_REVIEW_CANVAS_AGENT` is the stable escape hatch for wrappers
 * and future agents; vendor environment variables remain best-effort implementation details.
 *
 * @param {NodeJS.ProcessEnv} [env]
 */
export function detectAgentRuntime(env = process.env) {
  if (env.PR_REVIEW_CANVAS_AGENT) return normalizeAgentRuntime(env.PR_REVIEW_CANVAS_AGENT);
  if (env.CODEX_HOME || env.CODEX_SANDBOX || env.CODEX_THREAD_ID) return "codex";
  if (env.CLAUDECODE || env.CLAUDE_CODE_ENTRYPOINT) return "claude";
  if (env.OPENCODE || env.OPENCODE_CLIENT) return "opencode";
  return "generic";
}

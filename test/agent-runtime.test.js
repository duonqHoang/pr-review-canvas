/**
 * Runtime detection must remain a UX hint. These cases keep wrappers predictable without turning a
 * vendor-specific environment variable into an authorization boundary.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { detectAgentRuntime, normalizeAgentRuntime } from "../src/agent-runtime.js";

test("an explicit runtime overrides harness detection and normalizes aliases", () => {
  assert.equal(detectAgentRuntime({ PR_REVIEW_CANVAS_AGENT: "claude-code", CODEX_HOME: "/tmp/codex" }), "claude");
  assert.equal(normalizeAgentRuntime("open-code"), "opencode");
});

test("common harness environments are detected and unknown values fail closed to generic", () => {
  assert.equal(detectAgentRuntime({ CODEX_HOME: "/tmp/codex" }), "codex");
  assert.equal(detectAgentRuntime({ CLAUDECODE: "1" }), "claude");
  assert.equal(detectAgentRuntime({ OPENCODE: "1" }), "opencode");
  assert.equal(detectAgentRuntime({}), "generic");
  assert.equal(normalizeAgentRuntime("future-agent"), "generic");
});

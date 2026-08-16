import assert from "node:assert/strict";
import test from "node:test";

import { unseenLineIndexes } from "../src/client/expanded-rows.js";

/**
 * Expansion cursors belong to hunks, not gaps. Opposing cursors can therefore fetch some of the same
 * context, and the browser must merge those responses by the renderer's canonical line identity.
 */

test("an expansion meeting context from the opposite hunk keeps only unseen lines", () => {
  // Without this reconciliation, expanding 14..33 downward and then 21..40 upward renders 21..33
  // twice instead of joining both chunks into one continuous 14..40 region.
  const existing = Array.from({ length: 20 }, (_, index) => `0:c:${13 + index}:${14 + index}`);
  const incoming = Array.from({ length: 20 }, (_, index) => `0:c:${20 + index}:${21 + index}`);
  assert.deepEqual(unseenLineIndexes(existing, incoming), [13, 14, 15, 16, 17, 18, 19]);
});

test("duplicate rows within one response are also retained only once", () => {
  assert.deepEqual(unseenLineIndexes([], ["0:c:1:1", "0:c:1:1", "0:c:2:2"]), [0, 2]);
});

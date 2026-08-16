import assert from "node:assert/strict";
import test from "node:test";

import { editMarkdown } from "../src/shared/markdown-editor.js";

/**
 * Formatting must be a text splice, not a rich-text conversion: the comment body is the reviewer's
 * own prose, and every character outside the explicit selection must survive untouched.
 */

test("inline formatting wraps a selection and keeps it selected", () => {
  assert.deepEqual(editMarkdown("keep this exact", 5, 9, "bold"), {
    value: "keep **this** exact",
    selectionStart: 7,
    selectionEnd: 11,
  });
});

test("inline formatting supplies editable placeholder text for an empty selection", () => {
  assert.deepEqual(editMarkdown("before ", 7, 7, "link"), {
    value: "before [link text](url)",
    selectionStart: 8,
    selectionEnd: 17,
  });
});

test("block formatting prefixes every selected line and preserves surrounding prose", () => {
  assert.deepEqual(editMarkdown("before\none\ntwo\nafter", 7, 14, "bullet"), {
    value: "before\n- one\n- two\nafter",
    selectionStart: 7,
    selectionEnd: 18,
  });
});

test("ordered lists number selected lines and unknown actions are inert", () => {
  assert.equal(editMarkdown("one\ntwo", 0, 7, "ordered").value, "1. one\n2. two");
  assert.deepEqual(editMarkdown("untouched", 2, 4, "future"), {
    value: "untouched",
    selectionStart: 2,
    selectionEnd: 4,
  });
});

test("a selection ending after a newline does not format the following line", () => {
  assert.deepEqual(editMarkdown("one\ntwo", 0, 4, "quote"), {
    value: "> one\ntwo",
    selectionStart: 0,
    selectionEnd: 5,
  });
});

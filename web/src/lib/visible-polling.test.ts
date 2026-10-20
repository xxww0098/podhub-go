import assert from "node:assert"
import test from "node:test"

import { shouldVisiblePoll } from "./visible-polling"

test("a hidden window spends nothing on beat, focus or visible", () => {
  assert.equal(shouldVisiblePoll("beat", "hidden"), false)
  assert.equal(shouldVisiblePoll("focus", "hidden"), false)
  assert.equal(shouldVisiblePoll("visible", "hidden"), false)
  assert.equal(shouldVisiblePoll("mount", "hidden"), true)
})

test("a visible window admits every window trigger", () => {
  assert.equal(shouldVisiblePoll("beat", "visible"), true)
  assert.equal(shouldVisiblePoll("focus", "visible"), true)
  assert.equal(shouldVisiblePoll("visible", "visible"), true)
  assert.equal(shouldVisiblePoll("mount", "visible"), true)
})

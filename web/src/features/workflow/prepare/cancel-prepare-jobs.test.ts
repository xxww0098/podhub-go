import assert from "node:assert/strict"
import test from "node:test"
import { normalizePrepareCancelDraftIds } from "./cancel-prepare-jobs"

test("normalizePrepareCancelDraftIds dedupes and drops blanks", () => {
  assert.deepEqual(
    normalizePrepareCancelDraftIds([" a ", "", "a", "b", "  "]),
    ["a", "b"],
  )
  assert.deepEqual(normalizePrepareCancelDraftIds([]), [])
})

import assert from "node:assert/strict"
import test from "node:test"

import { listingEditorForFieldEquality } from "./http-listing"

test("dictionary equality uses the multi_select editor the removed route mapped", () => {
  assert.equal(listingEditorForFieldEquality("dictionary"), "multi_select")
  assert.equal(listingEditorForFieldEquality("decimal"), "decimal")
  assert.equal(listingEditorForFieldEquality("integer"), "integer")
  assert.equal(listingEditorForFieldEquality("boolean"), "boolean")
  assert.equal(listingEditorForFieldEquality("url"), "url")
  assert.equal(listingEditorForFieldEquality("text"), "text")
})

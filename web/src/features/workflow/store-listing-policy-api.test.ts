import assert from "node:assert/strict"
import { describe, test } from "node:test"
import { parseStoreListingPolicy } from "./store-listing-policy-api"

describe("store listing policy input", () => {
  test("unlimited and boundary values remain explicit", () => {
    assert.deepEqual(parseStoreListingPolicy("", "0"), { dailyCap: null, minGapSeconds: 0 })
    assert.deepEqual(parseStoreListingPolicy("1000000", "86400"), { dailyCap: 1000000, minGapSeconds: 86400 })
    assert.deepEqual(parseStoreListingPolicy(" 12 ", "30"), { dailyCap: 12, minGapSeconds: 30 })
  })
  test("rejects negative, decimal, exponent and out-of-range values", () => {
    for (const [cap, gap] of [["0", "0"], ["-1", "0"], ["1.5", "0"], ["1e3", "0"], ["1000001", "0"], ["1", "-1"], ["1", ""], ["1", "86401"]]) {
      assert.equal(parseStoreListingPolicy(cap, gap), null)
    }
  })
})

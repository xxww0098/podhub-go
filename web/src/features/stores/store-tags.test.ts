import assert from "node:assert/strict"
import test from "node:test"

import type { OzonStoreView } from "@/bindings/commands"
import { filterStoresByTags, sameTagUuids } from "./store-tags"

function store(id: string, tags?: Array<{ uuid: string; name: string }>): OzonStoreView {
  return { id, tags } as OzonStoreView
}

test("sameTagUuids compares tag UUIDs as sets", () => {
  assert.equal(sameTagUuids(["a", "b"], ["b", "a"]), true)
  assert.equal(sameTagUuids(["a", "a"], ["a"]), true)
  assert.equal(sameTagUuids(["a"], ["a", "b"]), false)
})

test("filterStoresByTags matches selected tags and optionally untagged stores", () => {
  const stores = [
    store("one", [{ uuid: "red", name: "Red" }]),
    store("two", [{ uuid: "blue", name: "Blue" }, { uuid: "red", name: "Red" }]),
    store("three"),
  ]

  assert.deepEqual(
    filterStoresByTags(stores, ["red"], false).map(({ id }) => id),
    ["one", "two"],
  )
  assert.deepEqual(
    filterStoresByTags(stores, ["red"], true).map(({ id }) => id),
    ["one", "two", "three"],
  )
  assert.deepEqual(filterStoresByTags(stores, ["green"], false), [])
  assert.deepEqual(filterStoresByTags(stores, [], false).map(({ id }) => id), ["one", "two", "three"])
  assert.deepEqual(filterStoresByTags(stores, [], true).map(({ id }) => id), ["three"])
})

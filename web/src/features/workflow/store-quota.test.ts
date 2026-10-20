import assert from "node:assert/strict"
import test from "node:test"
import {
  adjustStoreQuota,
  assignStoreIdByRowIndex,
  calculateEvenStoreQuotas,
  calculateSequentialStoreSlices,
  countStoreQuotas,
  formatStoreIds,
  parseStoreIds,
  productStoreId,
  queueControlStoreId,
  reconcileStoreQuotas,
  uniqueProductStoreIds,
} from "./store-quota"

test("parseStoreIds and formatStoreIds handle comma-separated strings cleanly", () => {
  assert.deepEqual(parseStoreIds("store1, store2 ,store1,store3"), ["store1", "store2", "store3"])
  assert.deepEqual(parseStoreIds(""), [])
  assert.deepEqual(parseStoreIds(null), [])
  assert.equal(formatStoreIds(["store1", "store2"]), "store1,store2")
})

test("multi-store queue control and reconciliation never use the comma-separated card binding", () => {
  const cardStores = "store1, store2"

  assert.equal(queueControlStoreId(cardStores), "store1")
  assert.equal(productStoreId("store2", cardStores), "store2")
  assert.equal(productStoreId("", cardStores), "store1")
  assert.deepEqual(
    uniqueProductStoreIds(["store2", "store1", "store2", ""], cardStores),
    ["store2", "store1"],
  )
})

test("restored quota counts reflect persisted Product Instance ownership", () => {
  assert.deepEqual(
    countStoreQuotas(["store1", "store1", "store2", "unknown"], ["store1", "store2"]),
    { store1: 2, store2: 1 },
  )
})

test("empty restored ownership returns new rows to the default even split", () => {
  const storeIds = ["store-a", "store-b"]
  const restored = countStoreQuotas([], storeIds)
  const slices = calculateSequentialStoreSlices(2, storeIds, restored)
  assert.deepEqual(slices.map(({ storeId, quota }) => [storeId, quota]), [
    ["store-a", 1],
    ["store-b", 1],
  ])
  assert.deepEqual(
    [0, 1].map((index) => assignStoreIdByRowIndex(index, slices)),
    ["store-a", "store-b"],
  )
})

test("calculateEvenStoreQuotas splits total rows evenly", () => {
  assert.deepEqual(
    calculateEvenStoreQuotas(100, ["store1", "store2"]),
    { store1: 50, store2: 50 },
  )
  assert.deepEqual(
    calculateEvenStoreQuotas(100, ["store1", "store2", "store3"]),
    { store1: 34, store2: 33, store3: 33 },
  )
  assert.deepEqual(
    calculateEvenStoreQuotas(0, ["store1", "store2"]),
    { store1: 0, store2: 0 },
  )
  assert.deepEqual(
    reconcileStoreQuotas(4, ["store1", "store2"], {}),
    { store1: 2, store2: 2 },
  )
})

test("calculateSequentialStoreSlices creates correct sequential boundaries", () => {
  // 100 rows with 2 stores (50 + 50)
  const slicesDefault = calculateSequentialStoreSlices(100, ["store1", "store2"])
  assert.deepEqual(slicesDefault, [
    {
      storeId: "store1",
      quota: 50,
      startIndex: 0,
      endIndex: 50,
      startPosition: 1,
      endPosition: 50,
    },
    {
      storeId: "store2",
      quota: 50,
      startIndex: 50,
      endIndex: 100,
      startPosition: 51,
      endPosition: 100,
    },
  ])

  // Custom split 49 + 51
  const slicesCustom = calculateSequentialStoreSlices(100, ["store1", "store2"], {
    store1: 49,
    store2: 51,
  })
  assert.deepEqual(slicesCustom, [
    {
      storeId: "store1",
      quota: 49,
      startIndex: 0,
      endIndex: 49,
      startPosition: 1,
      endPosition: 49,
    },
    {
      storeId: "store2",
      quota: 51,
      startIndex: 49,
      endIndex: 100,
      startPosition: 50,
      endPosition: 100,
    },
  ])

  // Assign store ID by row index:
  // Row index 0 -> store1, row index 48 -> store1, row index 49 -> store2, row index 99 -> store2
  assert.equal(assignStoreIdByRowIndex(0, slicesCustom), "store1")
  assert.equal(assignStoreIdByRowIndex(48, slicesCustom), "store1")
  assert.equal(assignStoreIdByRowIndex(49, slicesCustom), "store2")
  assert.equal(assignStoreIdByRowIndex(99, slicesCustom), "store2")
})

test("adjustStoreQuota updates target store and balances others", () => {
  const current = { store1: 50, store2: 50 }
  const adjusted = adjustStoreQuota(current, "store1", 49, 100, ["store1", "store2"])
  assert.deepEqual(adjusted, { store1: 49, store2: 51 })

  const adjusted2 = adjustStoreQuota(current, "store1", 70, 100, ["store1", "store2"])
  assert.deepEqual(adjusted2, { store1: 70, store2: 30 })
})

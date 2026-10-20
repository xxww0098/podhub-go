import assert from "node:assert/strict"
import test from "node:test"
import { ObservationResource } from "./observation-resource"
import type { ObservationProducts } from "./observation-types"
import { observedProduct, STORE_B, WORKSPACE_B } from "./observation-fixtures"

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

function feedback() {
  const failures: unknown[] = []
  let successes = 0
  return { failures, get successes() { return successes }, success: () => { successes++ }, failure: (reason: unknown) => { failures.push(reason) } }
}

test("scope switch synchronously clears rows/cursor and ignores the old scope's late response", async () => {
  const resource = new ObservationResource<ObservationProducts>()
  const notifications = feedback()
  await resource.load(async () => ({ items: [observedProduct()], next_cursor: "scope-a" }), notifications)
  const pending = deferred<ObservationProducts>()
  const old = resource.load(() => pending.promise, notifications)
  resource.invalidate()
  assert.deepEqual(resource.snapshot(), { loading: false, failed: false })
  await resource.load(async () => ({ items: [observedProduct(WORKSPACE_B, STORE_B)], next_cursor: "scope-b" }), notifications)
  pending.resolve({ items: [observedProduct()], next_cursor: "late-a" })
  await old
  assert.equal(resource.snapshot().data?.items[0]?.workspace_id, WORKSPACE_B)
  assert.equal(resource.snapshot().data?.next_cursor, "scope-b")
  assert.equal(notifications.successes, 2)
})

test("late failure after scope change/unmount does not issue a notification or restore an old retry", async () => {
  const resource = new ObservationResource<string>()
  const notifications = feedback()
  const pending = deferred<string>()
  const old = resource.load(() => pending.promise, notifications)
  resource.invalidate()
  pending.reject(new Error("old scope secret error"))
  await old
  assert.deepEqual(notifications.failures, [])
  assert.equal(resource.snapshot().data, undefined)
})

test("newer requests fence both initial and pagination responses", async () => {
  const resource = new ObservationResource<ObservationProducts>()
  const notifications = feedback()
  await resource.load(async () => ({ items: [observedProduct()], next_cursor: "page-2" }), notifications)
  const pending = deferred<ObservationProducts>()
  const paging = resource.load(() => pending.promise, notifications, (previous, incoming) => ({ ...incoming, items: [...previous!.items, ...incoming.items] }))
  assert.equal(resource.snapshot().data?.items.length, 1)
  assert.equal(resource.snapshot().loading, true)
  await resource.load(async () => ({ items: [observedProduct(WORKSPACE_B, STORE_B)] }), notifications)
  pending.resolve({ items: [observedProduct()], next_cursor: "old-page-3" })
  await paging
  assert.equal(resource.snapshot().data?.items.length, 1)
  assert.equal(resource.snapshot().data?.items[0]?.workspace_id, WORKSPACE_B)
  assert.equal(resource.snapshot().data?.next_cursor, undefined)
})

test("current read failure is surfaced once through feedback and a fresh GET can retry", async () => {
  const resource = new ObservationResource<number>()
  const notifications = feedback()
  await resource.load(async () => { throw new Error("diagnostic only") }, notifications)
  assert.equal(resource.snapshot().failed, true)
  assert.equal(notifications.failures.length, 1)
  await resource.load(async () => 42, notifications)
  assert.equal(resource.snapshot().data, 42)
  assert.equal(resource.snapshot().failed, false)
})

import assert from "node:assert/strict"
import test from "node:test"

import { migrateLegacyStorage } from "./legacy-storage"

function memoryStorage(entries: Array<[string, string]> = []) {
  const items = new Map(entries)
  return {
    items,
    get length() {
      return items.size
    },
    key: (index: number) => [...items.keys()][index] ?? null,
    getItem: (key: string) => items.get(key) ?? null,
    setItem: (key: string, value: string) => void items.set(key, value),
    removeItem: (key: string) => void items.delete(key),
  }
}

test("preferences move to the podhub names and the old keys disappear", () => {
  const local = memoryStorage([
    ["ozon-pod.theme", "dark"],
    ["ozon-pod.supplier-dbs-gallery.favorites", "[1]"],
    ["ozon-pod:spa-device-id", "device-1"],
  ])
  migrateLegacyStorage(local, memoryStorage())
  assert.deepEqual(Object.fromEntries(local.items), {
    "podhub.theme": "dark",
    "podhub.supplier-dbs-gallery.favorites": "[1]",
    "podhub:spa-device-id": "device-1",
  })
})

test("a value already written under the new name wins", () => {
  const local = memoryStorage([
    ["ozon-pod.theme", "dark"],
    ["podhub.theme", "light"],
  ])
  migrateLegacyStorage(local, memoryStorage())
  assert.equal(local.getItem("podhub.theme"), "light")
  assert.equal(local.getItem("ozon-pod.theme"), null)
})

test("caches under the old names are dropped, not moved", () => {
  const local = memoryStorage([
    ["ozon-pod.workflow.category-tree.v1", "{}"],
    ["ozon-pod.render-cache.v1", "{}"],
    ["ozon-pod.upload-slot.a", "1"],
    ["podx.render-cache.v1", "{}"],
    ["unrelated", "kept"],
  ])
  const session = memoryStorage([["ozon-pod.products.snapshot.v1:acct", "{}"]])
  migrateLegacyStorage(local, session)
  assert.deepEqual([...local.items.keys()], ["unrelated"])
  assert.equal(session.length, 0)
})

test("a second run changes nothing", () => {
  const local = memoryStorage([["ozon-pod.sidebar-open", "false"]])
  migrateLegacyStorage(local, memoryStorage())
  const after = new Map(local.items)
  migrateLegacyStorage(local, memoryStorage())
  assert.deepEqual(local.items, after)
})

test("storage that throws leaves the app bootable", () => {
  const broken = {
    length: 1,
    key: () => {
      throw new Error("blocked")
    },
    getItem: () => {
      throw new Error("blocked")
    },
    setItem: () => undefined,
    removeItem: () => undefined,
  }
  assert.doesNotThrow(() => migrateLegacyStorage(broken, undefined))
})

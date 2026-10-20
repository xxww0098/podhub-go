import assert from "node:assert/strict"
import test from "node:test"

// stubStorage() installs a partial window stub; drop it after this file so a
// later suite never sees a window without the real browser surface.
test.after(() => {
  delete (globalThis as { window?: unknown }).window
})

import { readCategoryTreeCache, writeCategoryTreeCache } from "./category-tree-cache"

const KEY = "podhub.workflow.category-tree.v1"

const leaf = {
  description_category_id: 1,
  category_name: "服装",
  type_id: 2,
  type_name: "T恤",
  disabled: false,
  children: [],
}

/** A localStorage that can be told to refuse writes over a byte ceiling. */
function stubStorage(ceilingBytes = Infinity) {
  const items = new Map<string, string>()
  const used = () => [...items.values()].reduce((total, value) => total + value.length, 0)
  const storage = {
    getItem: (key: string) => items.get(key) ?? null,
    setItem: (key: string, value: string) => {
      const after = used() - (items.get(key)?.length ?? 0) + value.length
      if (after > ceilingBytes) {
        throw Object.assign(new Error("quota"), { name: "QuotaExceededError" })
      }
      items.set(key, value)
    },
    removeItem: (key: string) => void items.delete(key),
  }
  Object.defineProperty(globalThis, "window", { configurable: true, value: { localStorage: storage } })
  return items
}

function store(items: Map<string, string>, fetchedAt: string) {
  items.set(KEY, JSON.stringify({ language: "zh_hans", fetchedAt, tree: [leaf] }))
}

test("a tree fetched within the day is served from the cache", () => {
  const items = stubStorage()
  store(items, new Date(Date.now() - 60_000).toISOString())
  assert.deepEqual(readCategoryTreeCache(), [leaf])
})

test("a stale, unstamped or future-stamped tree misses and evicts itself", () => {
  for (const fetchedAt of [
    new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString(), // older than the day
    "not a date", // Date.parse -> NaN
    new Date(Date.now() + 60 * 60 * 1000).toISOString(), // clock moved backwards
  ]) {
    const items = stubStorage()
    store(items, fetchedAt)
    assert.equal(readCategoryTreeCache(), null, `should not serve ${fetchedAt}`)
    // The miss re-arms the screens' own mount fetch, so the bytes go too.
    assert.equal(items.has(KEY), false, `should not keep ${fetchedAt}`)
  }
})

test("a write over quota drops the previous tree and lands on the retry", () => {
  const items = stubStorage(400)
  items.set("podhub.theme", "dark")
  store(items, new Date().toISOString())
  const before = items.get(KEY)!

  writeCategoryTreeCache([leaf, { ...leaf, type_id: 3, type_name: "卫衣" }])

  assert.notEqual(items.get(KEY), before, "the fresh tree should have replaced the old one")
  assert.equal(items.get("podhub.theme"), "dark", "a small neighbour key must survive")
})

test("a tree too large even for an empty quota leaves the small keys alone", () => {
  const items = stubStorage(120)
  items.set("podhub.theme", "dark")

  writeCategoryTreeCache([leaf])

  assert.equal(items.has(KEY), false, "no half-written tree is left behind")
  assert.equal(items.get("podhub.theme"), "dark")
})

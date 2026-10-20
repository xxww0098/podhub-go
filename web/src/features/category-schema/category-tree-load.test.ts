import assert from "node:assert/strict"
import test from "node:test"

// stubStorage() installs a partial window stub; drop it after this file so a
// later suite never sees a window without the real browser surface.
test.after(() => {
  delete (globalThis as { window?: unknown }).window
})

import type { CategoryTreeNodeView } from "@/bindings/commands"
import { listingHttp } from "@/bindings/http-listing"
import { writeCategoryTreeCache } from "./category-tree-cache"
import { loadCategoryTree } from "./category-tree-load"

const leaf: CategoryTreeNodeView = {
  description_category_id: 1,
  category_name: "服装",
  type_id: 2,
  type_name: "T恤",
  disabled: false,
  children: [],
}

function stubStorage() {
  const items = new Map<string, string>()
  const storage = {
    getItem: (key: string) => items.get(key) ?? null,
    setItem: (key: string, value: string) => {
      items.set(key, value)
    },
    removeItem: (key: string) => void items.delete(key),
  }
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: { localStorage: storage },
  })
  return items
}

test("a cached tree is returned without a request", async (t) => {
  const items = stubStorage()
  const original = listingHttp.listingCardLoadCategoryTree
  let calls = 0
  listingHttp.listingCardLoadCategoryTree = async () => {
    calls += 1
    return [leaf]
  }
  t.after(() => {
    listingHttp.listingCardLoadCategoryTree = original
  })
  writeCategoryTreeCache([leaf])
  assert.ok(items.size > 0)
  const tree = await loadCategoryTree()
  assert.equal(tree[0]?.type_name, "T恤")
  assert.equal(calls, 0)
})

test("concurrent misses share one request and a force fences the slower write", async (t) => {
  stubStorage()
  const original = listingHttp.listingCardLoadCategoryTree
  let calls = 0
  let releaseFirst: (tree: CategoryTreeNodeView[]) => void = () => undefined
  const first = new Promise<CategoryTreeNodeView[]>((resolve) => {
    releaseFirst = resolve
  })
  listingHttp.listingCardLoadCategoryTree = () => {
    calls += 1
    if (calls === 1) return first
    return Promise.resolve([{ ...leaf, type_name: "卫衣" }])
  }
  t.after(() => {
    listingHttp.listingCardLoadCategoryTree = original
  })

  const pendingA = loadCategoryTree()
  const pendingB = loadCategoryTree({ storeId: "store-1" })
  assert.equal(calls, 1)
  const forced = loadCategoryTree({ force: true, storeId: "store-1" })
  assert.equal(calls, 2)
  releaseFirst([leaf])
  const [joinedA, joinedB, refreshed] = await Promise.all([pendingA, pendingB, forced])
  assert.equal(joinedA, joinedB)
  assert.equal(joinedA[0]?.type_name, "T恤")
  assert.equal(refreshed[0]?.type_name, "卫衣")
  const raw = window.localStorage.getItem("podhub.workflow.category-tree.v1")
  assert.match(raw ?? "", /卫衣/)
  assert.doesNotMatch(raw ?? "", /T恤/)
})

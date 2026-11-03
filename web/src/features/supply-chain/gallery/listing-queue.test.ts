import assert from "node:assert/strict"
import test, { afterEach } from "node:test"

import type { SellerSupplierDbRowData } from "@/bindings/http-supplier-dbs-catalog"

import {
  availableQueueRows,
  clearQueue,
  importableQueueRows,
  isFavorite,
  isQueued,
  queueEntriesFromStored,
  queueEntryFromRow,
  removeQueued,
  resetCollectionForTests,
  toggleFavorite,
  toggleQueued,
} from "./listing-queue"

afterEach(() => resetCollectionForTests())

test("批量上架排除下架规格，保留同款可用规格的最新信息", () => {
  const small = row({ productId: "small", variantGroup: "same", size: "40×50" })
  const large = row({ productId: "large", variantGroup: "same", size: "50×70" })
  const queue = [small, large].map(queueEntryFromRow)
  const updated = { ...large, title: "最新名称" }
  assert.deepEqual(availableQueueRows(queue, new Map([[large.productId, updated]])), [updated])
  assert.deepEqual(availableQueueRows(queue, new Map()), [])
  assert.equal(queue.length, 2, "下架条目仍留在清单供用户移除")
})

test("批量导入再按可上架性过滤：暂不可上架的行跳过并报数，条目留在清单", () => {
  const ok = row({ productId: "ok" })
  const pending = row({
    productId: "pending",
    listable: false,
    denial: "catalog_expired",
  })
  const archived = row({
    productId: "archived",
    listable: false,
    denial: "product_archived",
  })
  const queue = [ok, pending, archived].map(queueEntryFromRow)
  const rowsById = new Map(
    [ok, pending, archived].map((item) => [item.productId, item]),
  )
  const { rows, skipped } = importableQueueRows(
    availableQueueRows(queue, rowsById),
  )
  assert.deepEqual(
    rows.map((item) => item.productId),
    ["ok"],
  )
  assert.equal(skipped, 2)
  assert.equal(queue.length, 3, "跳过的行留在清单里——恢复可上架后下次再导")
  // 全部受阻时不递空数组：rows 为空、skipped 是全部。
  const none = importableQueueRows(availableQueueRows(queue, new Map([[pending.productId, pending]])))
  assert.deepEqual(none.rows, [])
  assert.equal(none.skipped, 1)
})

function row(partial: Partial<SellerSupplierDbRowData>): SellerSupplierDbRowData {
  return {
    productId: "prd_x",
    sourceId: "src_1",
    title: "货品",
    platformCode: "P000",
    listable: true,
    leadTime: "2–3 天",
    gallery: [],
    productVideos: [],
    fixedTags: [],
    description: "",
    props: {},
    listedAtMs: 0,
    ...partial,
  }
}

test("清单条目是行快照：只留上架导航需要的最小身份", () => {
  const entry = queueEntryFromRow(
    row({
      productId: "prd_1",
      title: "圣诞帽",
      platformCode: "P001",
      platformPriceCents: 1600,
      gallery: [{ url: "https://img.example/1.jpg", w: 8, h: 6 }],
    }),
  )
  assert.deepEqual(
    { ...entry, addedAtMs: 0 },
    {
      productId: "prd_1",
      sourceId: "src_1",
      title: "圣诞帽",
      platformCode: "P001",
      coverUrl: "https://img.example/1.jpg",
      platformPriceCents: 1600,
      addedAtMs: 0,
    },
  )
})

test("toggleQueued 幂等去重：再点一次是移出，不是再加一条", () => {
  const hat = row({ productId: "prd_1" })
  const box = row({ productId: "prd_2" })
  toggleQueued(hat)
  toggleQueued(box)
  toggleQueued(hat) // 第二次点击 prd_1 = 移出
  assert.equal(isQueued("prd_1"), false)
  assert.equal(isQueued("prd_2"), true)
  toggleQueued(hat)
  assert.equal(isQueued("prd_1"), true)
})

test("同款不同规格可共存，移除一个规格不影响另一个", () => {
  const small = row({ productId: "prd_small", variantGroup: "same", size: "40×50" })
  const large = row({ productId: "prd_large", variantGroup: "same", size: "50×70" })
  toggleQueued(small)
  toggleQueued(large)
  assert.equal(isQueued(small.productId), true)
  assert.equal(isQueued(large.productId), true)
  assert.equal(queueEntryFromRow(small).size, "40×50")
  assert.equal(queueEntryFromRow(large).size, "50×70")
  toggleQueued(small)
  assert.equal(isQueued(small.productId), false)
  assert.equal(isQueued(large.productId), true)
})

test("removeQueued / clearQueue 只动清单，不动收藏", () => {
  toggleQueued(row({ productId: "prd_1" }))
  toggleQueued(row({ productId: "prd_2" }))
  toggleFavorite("prd_1")
  removeQueued("prd_1")
  assert.equal(isQueued("prd_1"), false)
  assert.equal(isFavorite("prd_1"), true)
  clearQueue()
  assert.equal(isQueued("prd_2"), false)
  assert.equal(isFavorite("prd_1"), true)
})

test("toggleFavorite 来回切换", () => {
  toggleFavorite("prd_1")
  assert.equal(isFavorite("prd_1"), true)
  toggleFavorite("prd_1")
  assert.equal(isFavorite("prd_1"), false)
})

/** 收藏与清单各自持久化。 */
const QUEUE_KEY = "podhub.supplier-dbs-gallery.listing-queue"

function fakeStorage(seed: Record<string, string> = {}) {
  const store = new Map(Object.entries(seed))
  return {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => {
      store.set(key, value)
    },
    removeItem: (key: string) => {
      store.delete(key)
    },
  }
}

/** node 测试没有 window；挂一个假 localStorage 后照浏览器路径落盘。 */
function withFakeWindow<T>(storage: ReturnType<typeof fakeStorage>, run: () => T): T {
  Object.defineProperty(globalThis, "window", {
    value: { localStorage: storage },
    configurable: true,
  })
  try {
    return run()
  } finally {
    Reflect.deleteProperty(globalThis, "window")
  }
}

function storedQueue(storage: ReturnType<typeof fakeStorage>): Array<Record<string, unknown>> {
  return JSON.parse(storage.getItem(QUEUE_KEY) ?? "[]")
}

test("选品清单持久化商品身份，不包含店铺和 PSD 设置", () => {
  const storage = fakeStorage()
  withFakeWindow(storage, () => {
    toggleQueued(row({ productId: "prd_1" }))
    toggleQueued(row({ productId: "prd_2" }))
    const persisted = storedQueue(storage)
    assert.deepEqual(persisted.map((entry) => entry.productId), ["prd_1", "prd_2"])
    assert.deepEqual(queueEntriesFromStored(persisted), persisted)
    removeQueued("prd_1")
    assert.deepEqual(storedQueue(storage).map((entry) => entry.productId), ["prd_2"])
  })
})

test("存储解析只保留清单字段，忽略无商品身份的条目", () => {
  const entry = queueEntryFromRow(row({ productId: "prd_1" }))
  const [parsed] = queueEntriesFromStored([
    { ...entry, storeId: "store-1", psd: { sha256: "ab", fileName: "t.psd" } },
    { productId: "" }, null, "junk",
  ])
  assert.deepEqual(parsed, entry)
  assert.equal("storeId" in parsed!, false)
  assert.equal("psd" in parsed!, false)
  assert.deepEqual(queueEntriesFromStored("not-an-array"), [])
})

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
  queueEntryById,
  queueEntryFromRow,
  removeQueued,
  resetCollectionForTests,
  setQueuedPsd,
  setQueuedStore,
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

/** 清单键是对外承诺：老数据还在这个 key 下，增量字段也必须落在这里。 */
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

test("店铺/PSD 绑定只改目标条目，清除即摘字段，并随清单落进 localStorage", () => {
  const storage = fakeStorage()
  withFakeWindow(storage, () => {
    toggleQueued(row({ productId: "prd_1" }))
    toggleQueued(row({ productId: "prd_2" }))
    setQueuedStore("prd_1", " store-moscow ")
    setQueuedStore("prd_2", "store-spb")
    setQueuedPsd("prd_1", { sha256: " a1b2 ", fileName: "海报.psd" })

    assert.equal(queueEntryById("prd_1")?.storeId, "store-moscow")
    assert.deepEqual(queueEntryById("prd_1")?.psd, {
      sha256: "a1b2",
      fileName: "海报.psd",
    })
    assert.equal(queueEntryById("prd_2")?.storeId, "store-spb")
    assert.equal(queueEntryById("prd_2")?.psd, undefined)

    // 老 key 不变，两笔字段跟着条目一起持久化。
    const persisted = storedQueue(storage).find((entry) => entry.productId === "prd_1")
    assert.equal(persisted?.storeId, "store-moscow")
    assert.deepEqual(persisted?.psd, { sha256: "a1b2", fileName: "海报.psd" })

    // 改绑覆盖前值，clear（空串 / null）把字段整个摘掉——导入时才按「没绑定」走。
    setQueuedStore("prd_1", "store-spb")
    setQueuedPsd("prd_1", { sha256: "c3d4", fileName: "油画.psd" })
    assert.equal(queueEntryById("prd_1")?.storeId, "store-spb")
    setQueuedStore("prd_1", "")
    setQueuedPsd("prd_1", null)
    const cleared = queueEntryById("prd_1")
    assert.ok(cleared)
    assert.equal("storeId" in cleared, false)
    assert.equal("psd" in cleared, false)
    const clearedStored = storedQueue(storage).find((entry) => entry.productId === "prd_1")
    assert.ok(clearedStored)
    assert.equal("storeId" in clearedStored, false)
    assert.equal("psd" in clearedStored, false)

    // 不在清单里的商品不会被绑定「凭空补」进来。
    setQueuedStore("prd_ghost", "store-x")
    setQueuedPsd("prd_ghost", { sha256: "e5", fileName: "ghost.psd" })
    assert.equal(isQueued("prd_ghost"), false)
    assert.equal(queueEntryById("prd_ghost"), undefined)
  })
})

test("存储解析容忍老清单：没有绑定字段照读，坏绑定丢掉", () => {
  const entries = queueEntriesFromStored([
    {
      productId: "prd_old",
      sourceId: "src_1",
      title: "旧货",
      platformCode: "P0",
      coverUrl: "",
      platformPriceCents: null,
      addedAtMs: 1,
    },
    {
      productId: "prd_new",
      storeId: " store-1 ",
      psd: { sha256: " ab ", fileName: "t.psd" },
    },
    { productId: "prd_bad", psd: { sha256: 7 } },
    { productId: "", title: "没有身份" },
    null,
    "junk",
  ])
  assert.deepEqual(
    entries.map((entry) => entry.productId),
    ["prd_old", "prd_new", "prd_bad"],
  )
  // 加字段之前存下的条目：读回照旧，只是没有绑定。
  assert.equal("storeId" in entries[0]!, false)
  assert.equal("psd" in entries[0]!, false)
  assert.equal(entries[1]?.storeId, "store-1")
  assert.deepEqual(entries[1]?.psd, { sha256: "ab", fileName: "t.psd" })
  assert.equal("psd" in entries[2]!, false)
  assert.deepEqual(queueEntriesFromStored("not-an-array"), [])
})


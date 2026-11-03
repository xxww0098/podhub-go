import assert from "node:assert/strict"
import test from "node:test"
import { toast } from "@/components/ui/toast"
import { importCatalogProducts } from "@/app/screen-catalog"
import {
  isQueued,
  removeQueued,
  resetCollectionForTests,
  toggleQueued,
} from "@/features/supply-chain/gallery/listing-queue"

const hat = { productId: "prd_1", sourceId: "src_1", title: "圣诞帽", platformCode: "P001" }
const box = { productId: "prd_2", sourceId: "src_1", title: "收纳盒", platformCode: "P002" }
const blocked = { ...hat, productId: "prd_bl", listable: false, denial: "catalog_expired" } as const

type RecordedCall = { url: string; method: string; body: { supplierProductId?: string } }

function setup(refuseId?: string) {
  resetCollectionForTests()
  for (const product of [hat, box, blocked]) {
    toggleQueued({ listable: true, leadTime: "", ...product, gallery: [], productVideos: [], fixedTags: [], description: "", props: {}, listedAtMs: 0 })
  }
  const previous = globalThis.fetch
  const originalAdd = toast.add
  const calls: RecordedCall[] = []
  const notices: string[] = []
  toast.add = ((options: { title?: string }) => {
    notices.push(options.title ?? "")
    return "spy"
  }) as typeof toast.add
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const call = { url: String(input), method: init?.method ?? "GET", body: JSON.parse(String(init?.body ?? "{}")) }
    calls.push(call)
    const refused = call.body.supplierProductId === refuseId
    return new Response(JSON.stringify(refused
      ? { error: "配置已变更，请刷新商品库" }
      : { data: { id: `card-${call.body.supplierProductId}` } }), {
      status: refused ? 409 : 200,
      headers: { "Content-Type": "application/json" },
    })
  }) as typeof globalThis.fetch
  return {
    calls, notices,
    restore() {
      globalThis.fetch = previous
      toast.add = originalAdd
      resetCollectionForTests()
    },
  }
}

test("加入清单后直接建卡，仅成功商品移出清单，不读取或写入店铺、PSD", async () => {
  const stub = setup()
  try {
    const created = await importCatalogProducts([hat, box], {
      isActive: () => true, onCreated: removeQueued,
    })
    assert.deepEqual(created, ["card-prd_1", "card-prd_2"])
    assert.deepEqual(stub.calls, [hat, box].map((product) => ({
      url: "/api/listing/cards", method: "POST", body: { createMode: "fromSupplier", supplierProductId: product.productId },
    })))
    assert.equal(isQueued(hat.productId), false)
    assert.equal(isQueued(box.productId), false)
  } finally { stub.restore() }
})

test("一件创建失败不阻断其余商品，失败商品留在清单", async () => {
  const stub = setup(hat.productId)
  try {
    const created = await importCatalogProducts([hat, box], {
      isActive: () => true, onCreated: removeQueued,
    })
    assert.deepEqual(created, ["card-prd_2"])
    assert.equal(isQueued(hat.productId), true)
    assert.equal(isQueued(box.productId), false)
    assert.equal(stub.notices.length, 1)
  } finally { stub.restore() }
})

test("入口兜底：受阻商品不发建卡请求，仍留在清单", async () => {
  const stub = setup()
  try {
    const created = await importCatalogProducts([hat, blocked, box], {
      isActive: () => true, onCreated: removeQueued,
    })
    assert.deepEqual(created, ["card-prd_1", "card-prd_2"])
    assert.equal(stub.calls.length, 2)
    assert.deepEqual(stub.notices, ["已跳过 1 件暂不可上架的商品"])
    assert.equal(isQueued(blocked.productId), true)
    assert.equal(isQueued(hat.productId), false)
  } finally { stub.restore() }
})

test("换屏后不再继续导入", async () => {
  const stub = setup()
  let active = true
  try {
    const created = await importCatalogProducts([hat, box], {
      isActive: () => active, onCreated: () => { active = false },
    })
    assert.deepEqual(created, ["card-prd_1"])
    assert.equal(stub.calls.length, 1)
  } finally { stub.restore() }
})

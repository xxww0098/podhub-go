import assert from "node:assert/strict"
import test from "node:test"
import { toast } from "@/components/ui/toast"
import { importCatalogProducts } from "@/app/screen-catalog"
import { stubOpfs, restoreOpfsTestGlobals } from "@/render/opfs-test-support"
import { putTemplate } from "@/render/opfs"
import { persistUserTemplate } from "@/features/workflow/card/template-assets"
import type { SellerSupplierDbRowData } from "@/bindings/http-supplier-dbs-catalog"
import {
  queueEntryById,
  removeQueued,
  resetCollectionForTests,
  setQueuedPsd,
  setQueuedStore,
  toggleQueued,
} from "@/features/supply-chain/gallery/listing-queue"

/**
 * 商库清单绑定 → 上架方案的跨模块集成：app 层导入例程 × 清单模块 store ×
 * http-listing 的读改写（fetch 桩）。分层规则要求这类用例放 web/tests/，
 * src/lib 的测试只读 app 层源码缝。
 */

type RecordedCall = { url: string; method: string; body: any }

/** 绑一次 fetch：2xx 照 api client 的口径包 data 信封，Response 原样放行。 */
function recordFetch(run: (call: RecordedCall) => Response | unknown) {
  const previous = globalThis.fetch
  const calls: RecordedCall[] = []
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const call: RecordedCall = {
      url: String(input),
      method: init?.method ?? "GET",
      body: init?.body === undefined ? undefined : JSON.parse(String(init.body)),
    }
    calls.push(call)
    const response = run(call)
    if (response instanceof Response) return response
    return new Response(JSON.stringify({ data: response }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    })
  }) as typeof globalThis.fetch
  return {
    calls,
    restore: () => {
      globalThis.fetch = previous
    },
  }
}

function cardRecord(id: string, payload: Record<string, unknown>) {
  return { id, title: id, revision: 7, payload, createdAtMs: 1, updatedAtMs: 2 }
}

function queueRow(productId: string, title: string): SellerSupplierDbRowData {
  return {
    productId,
    sourceId: "src_1",
    listable: true,
    title,
    platformCode: "P000",
    leadTime: "2–3 天",
    gallery: [],
    productVideos: [],
    fixedTags: [],
    description: "",
    props: {},
    listedAtMs: 0,
  }
}

const hat = { productId: "prd_1", sourceId: "src_1", title: "圣诞帽", platformCode: "P001" }
const box = { productId: "prd_2", sourceId: "src_1", title: "收纳盒", platformCode: "P002" }

/**
 * 卡片读写的最小桩：GET 回一张卡，PATCH 回写后的摘要。
 *
 * PATCH 把请求携带的 payload 键合并进已存文档而不是整体替换——这是
 * `write_card_patch` 对供应商绑定卡的真实合并语义（只允许写白名单键，返回
 * 完整文档）；会话（S8）把这次响应当作下一次写入的基线，桩若整体替换会在
 * 第二笔绑定写入时把 `supplierProductId` 冲掉，误判成非供应商卡。
 */
function cardStub(reply?: (call: RecordedCall) => Response | undefined) {
  const stored = new Map<string, Record<string, unknown>>()
  return recordFetch((call) => {
    const refusal = reply?.(call)
    if (refusal) return refusal
    if (call.url === "/api/listing/templates") return { ...call.body, ready: true }
    if (call.method === "POST") {
      const id = `card-${call.body.supplierProductId}`
      stored.set(id, { supplierProductId: call.body.supplierProductId, descriptionCategoryId: 10, typeId: 20 })
      return { id }
    }
    const id = call.url.split("/").pop()!
    if (call.method === "GET") {
      const payload = stored.get(id) ?? { supplierProductId: id.replace("card-", "") }
      stored.set(id, payload)
      return cardRecord(id, payload)
    }
    const merged = { ...stored.get(id), ...call.body.payload }
    stored.set(id, merged)
    return cardRecord(id, merged)
  })
}

test("导入把清单里攒下的店铺/PSD 绑定落到新卡上", async () => {
  stubOpfs()
  const digest = await putTemplate(new Uint8Array([1, 2, 3]))
  resetCollectionForTests()
  toggleQueued(queueRow("prd_1", "圣诞帽"))
  toggleQueued(queueRow("prd_2", "收纳盒"))
  setQueuedStore("prd_1", "store-moscow")
  setQueuedPsd("prd_1", { sha256: digest, fileName: "海报.psd" })

  const stub = cardStub()
  try {
    const created = await importCatalogProducts([hat, box], {
      isActive: () => true,
      onCreated: removeQueued,
    })
    await persistUserTemplate(digest, "海报.psd", 10, 20)
    assert.deepEqual(created, ["card-prd_1", "card-prd_2"])
    // 建卡 → 店铺 → PSD 逐件落地；没绑的第二件只有建卡。店铺与 PSD 绑定复用
    // 同一张卡的会话（S8），第二笔写入不再重新 GET。
    assert.deepEqual(
      stub.calls.filter((call) => call.url !== "/api/listing/templates").map((call) => `${call.method} ${call.url}`),
      [
        "POST /api/listing/cards",
        "GET /api/listing/cards/card-prd_1",
        "PATCH /api/listing/cards/card-prd_1",
        "PATCH /api/listing/cards/card-prd_1",
        "POST /api/listing/cards",
      ],
    )
    const backup = stub.calls.findIndex((call) => call.url === "/api/listing/templates")
    assert.ok(backup > stub.calls.map((call) => call.method).lastIndexOf("PATCH"), "backup starts after local PSD binding")
    // 两笔都是「只改绑定」的读改写：先店铺、后 PSD，各自带自己的 baseRevision。
    const patches = stub.calls.filter((call) => call.method === "PATCH")
    assert.deepEqual(patches[0]!.body, {
      baseRevision: 7,
      storeId: "store-moscow",
      payload: { targetStoreId: "store-moscow" },
    })
    assert.deepEqual(patches[1]!.body, {
      baseRevision: 7,
      payload: {
        psdTemplateAssetId: digest,
        psdTemplateSha256: digest,
        psdTemplateFileName: "海报.psd",
      },
    })
    // 导入成功的商品沿用原有清理：从清单弹出。
    assert.equal(queueEntryById("prd_1"), undefined)
    assert.equal(queueEntryById("prd_2"), undefined)
  } finally {
    stub.restore()
    resetCollectionForTests()
    await restoreOpfsTestGlobals()
  }
})

test("绑定写失败只提示一次，不把整件商品判成没导入", async () => {
  stubOpfs()
  const digest = await putTemplate(new Uint8Array([1, 2, 3]))
  resetCollectionForTests()
  toggleQueued(queueRow("prd_1", "圣诞帽"))
  toggleQueued(queueRow("prd_2", "收纳盒"))
  setQueuedStore("prd_1", "store-moscow")
  setQueuedPsd("prd_1", { sha256: digest, fileName: "海报.psd" })

  const stub = cardStub((call) =>
    call.method === "PATCH"
      ? new Response(JSON.stringify({ error: "云端拒绝了这次写入" }), {
          status: 500,
          headers: { "Content-Type": "application/json" },
        })
      : undefined,
  )
  // 失败提示落在 toast 上（Cloud 的拒绝原文）；这里替掉 add 只数条数。
  const originalAdd = toast.add
  const toasts: Array<{ title?: string }> = []
  toast.add = ((options: { title?: string }) => {
    toasts.push(options)
    return "spy"
  }) as typeof toast.add
  try {
    const created = await importCatalogProducts([hat, box], {
      isActive: () => true,
      onCreated: removeQueued,
    })
    // 绑定失败不回滚商品：两张卡都算创建成功，第二件照建。
    assert.deepEqual(created, ["card-prd_1", "card-prd_2"])
    assert.equal(
      stub.calls.filter((call) => call.method === "POST" && call.url === "/api/listing/cards").length,
      2,
    )
    // 每笔失败的绑定各一条一次性提示（店铺一条、PSD 一条），原文来自 Cloud。
    assert.deepEqual(
      toasts.map((item) => item.title),
      ["云端拒绝了这次写入", "云端拒绝了这次写入"],
    )
  } finally {
    toast.add = originalAdd
    stub.restore()
    resetCollectionForTests()
    await restoreOpfsTestGlobals()
  }
})

test("入口兜底：暂不可上架的商品不建卡，跳过数一次性报数", async () => {
  resetCollectionForTests()
  toggleQueued(queueRow("prd_1", "圣诞帽"))
  toggleQueued(queueRow("prd_2", "收纳盒"))
  toggleQueued(queueRow("prd_bl", "待复核挂画"))

  // 清单点击到逐件建卡之间行可能转为不可上架——身份上的行事实快照再过滤一次。
  const staleBlocked = {
    productId: "prd_bl",
    sourceId: "src_1",
    title: "待复核挂画",
    platformCode: "PBL",
    listable: false,
    denial: "catalog_expired",
  } as const

  const stub = cardStub()
  const originalAdd = toast.add
  const toasts: Array<{ title?: string }> = []
  toast.add = ((options: { title?: string }) => {
    toasts.push(options)
    return "spy"
  }) as typeof toast.add
  try {
    const created = await importCatalogProducts([hat, staleBlocked, box], {
      isActive: () => true,
      onCreated: removeQueued,
    })
    // 只有两件可达的建卡；受阻行连 POST 都不发。
    assert.deepEqual(created, ["card-prd_1", "card-prd_2"])
    assert.deepEqual(
      stub.calls.filter((call) => call.method === "POST").map((call) => call.url),
      ["POST /api/listing/cards", "POST /api/listing/cards"].map((line) => line.split(" ")[1]),
    )
    assert.deepEqual(toasts.map((item) => item.title), [
      "已跳过 1 件暂不可上架的商品",
    ])
    // 受阻行不碰 onCreated——条目留在清单里供下次再导。
    assert.equal(queueEntryById("prd_bl")?.productId, "prd_bl")
    assert.equal(queueEntryById("prd_1"), undefined)
  } finally {
    toast.add = originalAdd
    stub.restore()
    resetCollectionForTests()
  }
})

test("换屏后迟到的导入不再往下写", async () => {
  resetCollectionForTests()
  toggleQueued(queueRow("prd_1", "圣诞帽"))
  toggleQueued(queueRow("prd_2", "收纳盒"))
  const stub = cardStub()
  let active = true
  try {
    const created = await importCatalogProducts([hat, box], {
      isActive: () => active,
      onCreated: () => {
        active = false
      },
    })
    assert.deepEqual(created, ["card-prd_1"])
    assert.deepEqual(
      stub.calls.map((call) => `${call.method} ${call.url}`),
      ["POST /api/listing/cards"],
    )
  } finally {
    stub.restore()
    resetCollectionForTests()
  }
})

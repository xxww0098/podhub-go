/**
 * 「同款规格」三条 Ops 路由的 wire 契约：方法、路径、请求体与 \`data\` 解包。
 *
 * fixtures 必须满足生成的 Rust wire 类型，防止手写前端类型与测试一起漂移。三条路径由生成物
 * \`@/api/routes\` 提供，绑定按路由键取值；这里仍把字面量钉一遍，并断言
 * 权威表与字面量逐字相等——生成物被改错（或协议悄悄改路径）时，这个文件先红。
 */
import assert from "node:assert/strict"
import test from "node:test"

import { ROUTES, route } from "../src/api/routes"
import type { components } from "../src/api/schema"
import { buildVariantPreviewRequest } from "../src/features/products/products-variant-model"
import { renderToStaticMarkup } from "react-dom/server"
import { createElement } from "react"
import { VariantTargetSummary } from "../src/features/products/products-variant-body"
import { productVariantsHttp } from "../src/bindings/http-product-variants"

type Call = { url: string; method: string; body: unknown }

function recordFetch(reply: (call: Call) => unknown): { calls: Call[]; restore: () => void } {
  const previous = globalThis.fetch
  const calls: Call[] = []
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const call: Call = {
      url: String(input),
      method: init?.method ?? "GET",
      body: init?.body === undefined ? undefined : JSON.parse(String(init.body)),
    }
    calls.push(call)
    return new Response(JSON.stringify({ data: reply(call) }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    })
  }) as typeof globalThis.fetch
  return { calls, restore: () => { globalThis.fetch = previous } }
}

const OPERATION: components["schemas"]["ProductVariantOperationData"] = {
  operation_id: "op-1",
  accepted: true,
  state: "pending",
  items: [{ product_id: "101", offer_id: "A-1", state: "pending", task_id: 123 }],
  last_checked_at_ms: null,
}

const PREVIEW: components["schemas"]["ProductVariantPreviewData"] = {
  digest: "digest-1",
  action: "merge",
  store_id: "store-1",
  target: {
    model_id: 900, model_value: "杯垫同款",
    existing_members: [{ product_id: "107", offer_id: "A-7", name: "杯垫 白", model_id: 900 }],
  },
  products: [
    {
      product_id: "101",
      offer_id: "A-1",
      name: "杯垫",
      thumbnail_url: "https://cdn.example.test/t.jpg",
      current_model_id: 11,
      target_model_id: 900,
      variant_values: [{ attribute_id: 10096, label: "尺寸", value: "M" }],
      combination_key: "10096:M",
    },
  ],
  source_remaining: [{ product_id: "109", offer_id: "A-9", name: "杯垫 灰", model_id: 11 }],
  target_existing: [{ product_id: "107", offer_id: "A-7", name: "杯垫 白", model_id: 900 }],
  problems: [{ code: "verify_first", product_id: "101" }],
}

test("冻结字面量与生成的路由权威表逐字一致", () => {
  // routes.ts 是生成的，但仍要与协议字面量对得上：两边任一被改错，这里先红。
  assert.deepEqual(
    {
      previews: ROUTES.workspaceOpsProductVariantsPreviews,
      operations: ROUTES.workspaceOpsProductVariantsOperations,
      operation: ROUTES.workspaceOpsProductVariantsOperationsByOperationId,
    },
    {
      previews: "/api/workspace/ops/product-variants/previews",
      operations: "/api/workspace/ops/product-variants/operations",
      operation: "/api/workspace/ops/product-variants/operations/{operation_id}",
    },
  )
  // 带参数的键走 route() 时，参数名就是模板里的 {operation_id}，值必须编码。
  assert.equal(
    route("workspaceOpsProductVariantsOperationsByOperationId", { operation_id: "op-1/带空格" }),
    "/api/workspace/ops/product-variants/operations/op-1%2F%E5%B8%A6%E7%A9%BA%E6%A0%BC",
  )
})

test("预览 / 执行 / 回读各走一条冻结路由，路径与请求体逐字对上", async () => {
  const stub = recordFetch((call) => call.url.endsWith("/previews") ? PREVIEW :
    call.method === "POST" ? OPERATION : { ...OPERATION, passes: 1 })
  try {
    const preview = await productVariantsHttp.preview(buildVariantPreviewRequest({
      storeId: "store-1", action: "move", rows: [{ product_id: 101 }, { product_id: 102 }],
      target: { kind: "verified", modelId: "900" },
    }))
    const operated = await productVariantsHttp.operate({
      operation_id: "op-1",
      store_id: "store-1",
      preview_digest: "digest-1",
    })
    await productVariantsHttp.operation("op-1/带空格")

    // 绑定按生成的路由键取值；路径本身由上一个测试与字面量对账。
    assert.deepEqual(
      stub.calls.map((call) => `${call.method} ${call.url}`),
      [
        `POST ${route("workspaceOpsProductVariantsPreviews")}`,
        `POST ${route("workspaceOpsProductVariantsOperations")}`,
        // 操作号进路径必须编码：它不是受控字符集。
        `GET ${route("workspaceOpsProductVariantsOperationsByOperationId", { operation_id: "op-1/带空格" })}`,
      ],
    )
    assert.deepEqual(stub.calls[0]!.body, {
      store_id: "store-1",
      action: "move",
      product_ids: ["101", "102"],
      target_model_id: 900,
    })
    // 执行体只有操作号 + 店铺 + 摘要，没有商品列表、没有属性值。
    assert.deepEqual(stub.calls[1]!.body, {
      operation_id: "op-1",
      store_id: "store-1",
      preview_digest: "digest-1",
    })
    assert.equal(stub.calls[2]!.body, undefined)
    // 2xx 的 data 直接是预览/回读对象，页面不用再拆一层。
    assert.equal(preview.digest, "digest-1")
    assert.equal(preview.target.existingMembers, 1)
    assert.equal(preview.products[0]!.thumbnailUrl, "https://cdn.example.test/t.jpg")
    assert.equal(preview.products[0]!.currentModelId, "11")
    assert.equal(preview.products[0]!.targetModelId, "900")
    assert.equal(preview.products[0]!.variantValues![0]!.attributeId, "10096")
    assert.equal(preview.sourceRemaining[0]!.currentModelId, "11")
    assert.equal(preview.targetExisting[0]!.currentModelId, "900")
    assert.match(renderToStaticMarkup(createElement(VariantTargetSummary, { data: preview })), /1 件/)
    assert.equal(preview.sourceRemaining[0]!.offerId, "A-9")
    assert.deepEqual(preview.problems, [{ code: "verify_first", productId: "101", attributeId: null }])
    assert.equal(operated.operationId, "op-1")
    assert.equal(operated.accepted, true)
    assert.equal(operated.items[0]!.taskId, "123")
  } finally {
    stub.restore()
  }
})

test("逐项结果按契约形状解包（state / taskId / detailCode）", async () => {
  const reply: components["schemas"]["ProductVariantOperationStatusData"] = {
    operation_id: "op-9",
    passes: 1,
    state: "pending",
    items: [
      { product_id: "101", offer_id: "A-1", state: "applied", task_id: 123 },
      { product_id: "102", offer_id: "A-2", state: "needs_review", detail_code: "observation_budget_exhausted" },
    ],
    last_checked_at_ms: 1_700_000_000_000,
  }
  const stub = recordFetch(() => reply)
  try {
    const data = await productVariantsHttp.operation("op-9")
    assert.equal(data.operationId, "op-9")
    assert.equal(data.items[0]!.state, "applied")
    assert.equal(data.items[0]!.taskId, "123")
    assert.equal(data.items[1]!.detailCode, "observation_budget_exhausted")
    assert.equal(data.lastCheckedAtMs, 1_700_000_000_000)
  } finally {
    stub.restore()
  }
})

test("wire 省略空集合时投影为空列表，避免预览与结果渲染崩溃", async () => {
  const preview: components["schemas"]["ProductVariantPreviewData"] = {
    digest: "empty", action: "merge", store_id: "store-1", target: {}, products: [],
  }
  const operation: components["schemas"]["ProductVariantOperationData"] = { operation_id: "op", accepted: true }
  const status: components["schemas"]["ProductVariantOperationStatusData"] = { operation_id: "op", passes: 0, state: "pending" }
  const stub = recordFetch((call) => call.url.endsWith("/previews") ? preview : call.method === "POST" ? operation : status)
  try {
    const data = await productVariantsHttp.preview({ store_id: "store-1", action: "merge", product_ids: [] })
    assert.deepEqual(data.sourceRemaining, [])
    assert.deepEqual(data.targetExisting, [])
    assert.deepEqual(data.problems, [])
    assert.equal(data.target.existingMembers, 0)
    assert.match(renderToStaticMarkup(createElement(VariantTargetSummary, { data })), /暂无成员/)
    assert.deepEqual((await productVariantsHttp.operate({ operation_id: "op", store_id: "store-1", preview_digest: "empty" })).items, [])
    assert.deepEqual((await productVariantsHttp.operation("op")).items, [])
  } finally {
    stub.restore()
  }
})

test("HTTP 边界不发送无法无损表示的目标型号", async () => {
  const stub = recordFetch(() => PREVIEW)
  try {
    for (const targetModelId of [0, -1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1]) {
      await assert.rejects(productVariantsHttp.preview({ store_id: "store-1", action: "move", product_ids: ["101"], target_model_id: targetModelId }))
    }
    assert.deepEqual(stub.calls, [])
  } finally {
    stub.restore()
  }
})

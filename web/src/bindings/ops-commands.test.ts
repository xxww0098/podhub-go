/**
 * 运维 reads (发货 / 退货 / 口碑 / 供货), 商品, 客服 and 概览. Every one is an
 * HTTP call to a Cloud domain route, so the test stubs
 * `globalThis.fetch` and pins the method, the path and the body.
 */
import assert from "node:assert/strict"
import test from "node:test"

import { opsHttp } from "./http-ops"

type Call = { url: string, method: string, body: unknown }

function recordFetch(reply: (call: Call) => unknown): { calls: Call[], restore: () => void } {
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

function routes(calls: Call[]): string[] {
  return calls.map((call) => `${call.method} ${call.url}`)
}

test("每块运维读屏各走一条自己的云端路由，Store UUID 在请求体里", async () => {
  const stub = recordFetch(() => ({}))
  try {
    await opsHttp.opsShippingList({
      store_id: "store-1",
      status: "awaiting_packaging",
      window_days: 7,
      cursor: null,
      limit: 50,
    })
    await opsHttp.opsReturnsList({
      store_id: "store-1",
      posting_number: "",
      visual_status_name: "",
      return_schema: "FBS",
      last_id: null,
    })
    await opsHttp.opsCancellationsList({
      store_id: "store-1",
      posting_number: "",
      state: "ON_APPROVAL",
      initiator: "",
      last_id: null,
    })
    await opsHttp.opsVoiceListReviews({ store_id: "store-1", last_id: null })
    await opsHttp.opsVoiceListQuestions({ store_id: "store-1", last_id: null })
    await opsHttp.opsSupplyList({
      store_id: "store-1",
      last_id: null,
      states: ["IN_TRANSIT"],
      document_number_search: null,
    })
    await opsHttp.opsSupplyWarehouseStocks({ store_id: "store-1" })

    assert.deepEqual(routes(stub.calls), [
      "POST /api/ops/shipping/list",
      "POST /api/ops/returns/list",
      "POST /api/ops/returns/cancellations",
      "POST /api/ops/voice/reviews",
      "POST /api/ops/voice/questions",
      "POST /api/ops/supply/orders",
      "POST /api/ops/supply/warehouse-stocks",
    ])
    assert.deepEqual(stub.calls[0]!.body, {
      store_id: "store-1",
      status: "awaiting_packaging",
      window_days: 7,
      cursor: null,
      limit: 50,
    })
    assert.deepEqual(stub.calls[5]!.body, {
      store_id: "store-1",
      last_id: null,
      states: ["IN_TRANSIT"],
      document_number_search: null,
    })
    assert.deepEqual(stub.calls[6]!.body, { store_id: "store-1" })
  } finally {
    stub.restore()
  }
})

test("商品四条读路由与写路由：写请求体就是命令本身，不再包一层", async () => {
  const stub = recordFetch(() => ({ operation_id: "op-1", items: [] }))
  try {
    await opsHttp.productsSync({
      store_id: "store-1",
      sku: null,
      include_metrics: true,
      metrics_days: 3,
    })
    await opsHttp.productsSyncMetrics({
      store_id: "store-1",
      sku: null,
      days: 3,
      dimension: "day",
    })
    await opsHttp.productsListWarehouses({ store_id: "store-1", skus: [42] })
    await opsHttp.productsListPromotions({ store_id: "store-1", product_ids: [7] })
    const command = {
      operation_id: "op-1",
      store_id: "store-1",
      request: {
        kind: "archive" as const,
        product_ids: [7],
      },
    }
    await opsHttp.productsMutate(command)

    assert.deepEqual(routes(stub.calls), [
      "POST /api/ops/products/sync",
      "POST /api/ops/products/metrics",
      "POST /api/ops/products/warehouses",
      "POST /api/ops/products/promotions",
      "POST /api/ops/products/mutate",
    ])
    assert.deepEqual(stub.calls[2]!.body, { store_id: "store-1", skus: [42] })
    // Cloud keys the Seller write ledger on `operation_id`; wrapping the
    // command in a `{ command }` envelope would hide it from the route.
    assert.deepEqual(stub.calls[4]!.body, command)
  } finally {
    stub.restore()
  }
})

test("客服消息中心的三条路由，收件箱一次带上整份店铺名册", async () => {
  const stub = recordFetch(() => ({}))
  try {
    await opsHttp.messageCenterInbox({
      stores: [{ store_id: "store-1", name: "旗舰店", store_number: "1" }],
    })
    await opsHttp.messageCenterHistory({ store_id: "store-1", chat_id: "chat-9" })
    await opsHttp.messageCenterSend({
      store_id: "store-1",
      chat_id: "chat-9",
      text: "Здравствуйте",
    })

    assert.deepEqual(routes(stub.calls), [
      "POST /api/ops/message-center/inbox",
      "POST /api/ops/message-center/history",
      "POST /api/ops/message-center/send",
    ])
    assert.deepEqual(stub.calls[0]!.body, {
      stores: [{ store_id: "store-1", name: "旗舰店", store_number: "1" }],
    })
    assert.deepEqual(stub.calls[2]!.body, {
      store_id: "store-1",
      chat_id: "chat-9",
      text: "Здравствуйте",
    })
  } finally {
    stub.restore()
  }
})

const SNAPSHOT = {
  roster: {
    stores: [
      {
        id: "store-1",
        label: "旗舰店",
        client_id: "12345",
        watermark_name: "",
        advertising_client_id: "",
        advertising_configured: false,
        configured: true,
        secret_status: "present",
        ref_id: "store-1",
        updated_at_ms: 0,
        verified_at_ms: null,
        last_used_at_ms: null,
        active: false,
        cloud_store_uuid: "store-1",
        create_order: 1,
        cloud_status: "active",
        manual_disabled: false,
        quota_suspended: false,
        cloud_revision: 1,
        credential_revision: 1,
        needs_reentry: false,
        can_manage: true,
    can_edit_credential: true,
    permissions: { manageStore: true, editName: true, manageKeyGrants: true, testKey: true, manageKey: true, deleteStore: true },
    assignee_key_manage: true,
      },
    ],
    active_id: null,
    store_limit: 3,
    stores_used: 1,
    suspended: 0,
  },
  ledger: [],
  metrics: [],
}

test("概览的三条路由：快照是 GET，刷新与对账是无请求体的 POST", async () => {
  const stub = recordFetch(() => SNAPSHOT)
  try {
    await opsHttp.consoleGetSnapshot()
    await opsHttp.consoleRefreshMetrics()
    await opsHttp.consoleReconcileActiveWorkspace()

    assert.deepEqual(routes(stub.calls), [
      "GET /api/ops/console/snapshot",
      "POST /api/ops/console/refresh-metrics",
      "POST /api/ops/console/reconcile",
    ])
    assert.equal(stub.calls[1]!.body, undefined)
    assert.equal(stub.calls[2]!.body, undefined)
  } finally {
    stub.restore()
  }
})

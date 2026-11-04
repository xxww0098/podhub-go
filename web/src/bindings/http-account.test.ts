import assert from "node:assert/strict"
import test from "node:test"

import { route } from "@/api/routes"
import { accountHttp } from "@/bindings/http-account"
import type { PaymentOrderView } from "@/bindings/commands"

type Fetch = typeof globalThis.fetch

function stubFetch(next: Fetch): () => void {
  const previous = globalThis.fetch
  globalThis.fetch = next
  return () => {
    globalThis.fetch = previous
  }
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  })
}

function orderView(overrides: Partial<PaymentOrderView> = {}): PaymentOrderView {
  return {
    public_id: "order-1",
    plan: "pro",
    months: 12,
    amount_cents: 192000,
    currency: "CNY",
    provider: "alipay",
    status: "pending",
    entry_state: "ready",
    remittance: null,
    qr_code: "qr://payload",
    pay_url: "https://pay.invalid/checkout/order-1",
    created_at: "2026-09-17T00:00:00Z",
    paid_at: null,
    canceled_at: null,
    ...overrides,
  }
}

function rechargeView(overrides: Record<string, unknown> = {}) {
  return {
    public_id: "recharge-1",
    amount_cents: 500,
    currency: "CNY",
    provider: "stripe",
    status: "pending",
    topup_microfen: 5_000_000,
    created_at: "2026-09-18T00:00:00Z",
    pay_url: "https://pay.invalid/recharge-1",
    qr_code: null,
    remittance: null,
    paid_at: null,
    canceled_at: null,
    ...overrides,
  }
}

test("checkout payment methods preserve the raw enabled channel list", async (t) => {
  const methods = { providers: ["alipay", "stripe"], manual: true }
  const restore = stubFetch(async (input, init) => {
    assert.equal(String(input), route("paymentMethods"))
    assert.equal(init?.credentials, "include")
    return jsonResponse(methods)
  })
  t.after(restore)
  assert.deepEqual(await accountHttp.accountGetPaymentMethods(), methods)
})

test("checkout order pagination preserves raw rows and cursor", async (t) => {
  const page = { orders: [orderView()], next_cursor: "page-2" }
  const restore = stubFetch(async (input) => {
    assert.equal(String(input), `${route("orders")}?status=pending&limit=10&cursor=page-1`)
    return jsonResponse(page)
  })
  t.after(restore)
  assert.deepEqual(await accountHttp.accountListPaymentOrderPage({ status: "pending", limit: 10, cursor: "page-1" }), page)
})

/**
 * Both paid writes carry `expected_workspace_uuid` — the Workspace the dialog
 * was opened on — so Cloud can refuse a write whose session has since
 * resolved elsewhere.
 */
test("paid writes post the Workspace the dialog confirmed", async (t) => {
  const workspaceUuid = "8f0a3f5e-6c1d-4a5f-9a3e-6d2c8b7f4a11"
  const bodies: unknown[] = []
  const restore = stubFetch(async (input, init) => {
    bodies.push(JSON.parse(String(init?.body)))
    if (String(input).endsWith(route("redeem"))) {
      return jsonResponse({ ok: true, wallet_cents: 500 })
    }
    return jsonResponse({ order: rechargeView() })
  })
  t.after(restore)

  const redeemed = await accountHttp.accountRedeemCode({ code: "ABC-123", expected_workspace_uuid: workspaceUuid })
  await accountHttp.accountCreateRechargeOrder({
    operation_id: "recharge-op",
    amount_cents: 500,
    provider: "manual",
    expected_workspace_uuid: workspaceUuid,
  })

  assert.deepEqual(redeemed, { ok: true, wallet_cents: 500 })
  assert.deepEqual(bodies, [
    { code: "ABC-123", expected_workspace_uuid: workspaceUuid },
    { operation_id: "recharge-op", amount_cents: 500, provider: "manual", expected_workspace_uuid: workspaceUuid },
  ])
})

test("plan redemption preserves the raw grant and effective dates", async (t) => {
  const grant = {
    ok: true, wallet_cents: 0, plan_key: "max", plan_stores: 100, plan_months: 1,
    starts_at: "2026-11-04T00:00:00Z", ends_at: "2026-12-04T00:00:00Z",
  }
  const restore = stubFetch(async () => jsonResponse(grant))
  t.after(restore)

  assert.deepEqual(await accountHttp.accountRedeemCode({
    code: "POD-PLAN-ABC", expected_workspace_uuid: "8f0a3f5e-6c1d-4a5f-9a3e-6d2c8b7f4a11",
  }), grant)
})

test("wallet detail keeps a pending online recharge available for recovery", async (t) => {
  const states = ["entry_unknown", "entry_confirming"]
  let call = 0
  const restore = stubFetch(async () =>
    jsonResponse({
        balance_microfen: 0, held_microfen: 0, available_microfen: 0,
        spent_microfen: 0, updated_at: "2026-10-27T00:00:00Z",
        ledger: [],
        recharges: [rechargeView({ entry_state: states[call++] })],
    }),
  )
  t.after(restore)

  for (const state of states) {
    const detail = await accountHttp.accountGetWalletDetail()
    assert.equal(detail.wallet.available_microfen, 0)
    assert.equal(detail.recharges[0].public_id, "recharge-1")
    assert.equal(detail.recharges[0].status, "pending")
    assert.equal(detail.recharges[0].pay_url, "https://pay.invalid/recharge-1")
    assert.equal((detail.recharges[0] as typeof detail.recharges[0] & { entry_state: string }).entry_state, state)
  }
})

test("recharge recovery uses the same order identity after an idempotent retry", async (t) => {
  const bodies: unknown[] = []
  const restore = stubFetch(async (_input, init) => {
    bodies.push(JSON.parse(String(init?.body)))
    return jsonResponse({ order: rechargeView() })
  })
  t.after(restore)

  const request = {
    operation_id: "recharge-retry-1",
    amount_cents: 500,
    provider: "stripe",
    expected_workspace_uuid: "8f0a3f5e-6c1d-4a5f-9a3e-6d2c8b7f4a11",
  }
  const first = await accountHttp.accountCreateRechargeOrder(request)
  const second = await accountHttp.accountCreateRechargeOrder(request)
  assert.equal(first.public_id, second.public_id)
  assert.deepEqual(bodies, [request, request])
})

test("accountRecoverRechargeOrder returns the recovered pending online order", async (t) => {
  const calls: string[] = []
  const restore = stubFetch(async (input) => {
    calls.push(String(input))
    return jsonResponse({
      order: rechargeView({ entry_state: "entry_confirming" }),
    })
  })
  t.after(restore)

  const recovered = await accountHttp.accountRecoverRechargeOrder("recharge-1")
  assert.match(calls[0], /\/api\/ai\/recharge\/orders\/recharge-1\/recover$/)
  assert.equal(recovered.public_id, "recharge-1")
  assert.equal(recovered.status, "pending")
})

test("accountRecoverPaymentOrder unwraps the recovered order", async (t) => {
  const order = orderView({ entry_state: "entry_confirming" })
  const calls: string[] = []
  const restore = stubFetch(async (input) => {
    calls.push(String(input))
    return jsonResponse({ order })
  })
  t.after(restore)

  const recovered = await accountHttp.accountRecoverPaymentOrder("order-1")
  assert.equal(calls.length, 1)
  assert.match(calls[0], /\/api\/orders\/order-1\/recover$/)
  assert.equal(recovered.status, "pending")
  assert.equal(recovered.entry_state, "entry_confirming")
})

test("accountGetPaymentOrder reads the raw checkout order DTO", async (t) => {
  const order = orderView({ status: "paid", paid_at: "2026-09-17T01:00:00Z" })
  const calls: string[] = []
  const restore = stubFetch(async (input) => {
    calls.push(String(input))
    return jsonResponse({ order })
  })
  t.after(restore)

  const fetched = await accountHttp.accountGetPaymentOrder("order-1")
  assert.equal(calls.length, 1)
  assert.match(calls[0], /\/api\/orders\/order-1$/)
  assert.equal(fetched.status, "paid")
  assert.equal(fetched.months, 12)
})

test("accountCancelPaymentOrder reads the raw checkout order DTO", async (t) => {
  const order = orderView({ status: "canceled", canceled_at: "2026-09-17T02:00:00Z" })
  const calls: string[] = []
  const restore = stubFetch(async (input) => {
    calls.push(String(input))
    return jsonResponse({ order })
  })
  t.after(restore)

  const canceled = await accountHttp.accountCancelPaymentOrder("order-1")
  assert.match(calls[0], /\/api\/orders\/order-1\/cancel$/)
  assert.equal(canceled.status, "canceled")
})

test("accountOpenPaymentOrder opens the stored checkout pay_url", async (t) => {
  const order = orderView()
  const opened: string[] = []
  const restore = stubFetch(async () => jsonResponse({ order }))
  const previousWindow = (globalThis as { window?: unknown }).window
  ;(globalThis as { window?: unknown }).window = {
    open: (url: string) => {
      opened.push(url)
      return null
    },
  }
  t.after(() => {
    restore()
    ;(globalThis as { window?: unknown }).window = previousWindow
  })

  await accountHttp.accountOpenPaymentOrder("order-1")
  assert.deepEqual(opened, ["https://pay.invalid/checkout/order-1"])
})

test("accountOpenPaymentOrder without pay_url opens nothing", async (t) => {
  const order = orderView({ pay_url: undefined })
  let opened = 0
  const restore = stubFetch(async () => jsonResponse({ order }))
  const previousWindow = (globalThis as { window?: unknown }).window
  ;(globalThis as { window?: unknown }).window = {
    open: () => {
      opened += 1
      return null
    },
  }
  t.after(() => {
    restore()
    ;(globalThis as { window?: unknown }).window = previousWindow
  })

  await accountHttp.accountOpenPaymentOrder("order-1")
  assert.equal(opened, 0)
})

test("accountListAiLogs pages the AI consume log with p and page_size", async (t) => {
  const urls: string[] = []
  const restore = stubFetch(async (input) => {
    urls.push(String(input))
    return jsonResponse({ page: 2, page_size: 20, total: 21, items: [] })
  })
  t.after(restore)

  const page = await accountHttp.accountListAiLogs(2, 20)
  assert.equal(urls[0], `${route("aiLogs")}?p=2&page_size=20`)
  assert.equal(page.total, 21)
})

test("accountExportAiLogs downloads the CSV bytes from the export route", async (t) => {
  const urls: string[] = []
  const restore = stubFetch(async (input) => {
    urls.push(String(input))
    return new Response("id,model\n1,gpt-5\n", { status: 200, headers: { "Content-Type": "text/csv" } })
  })
  t.after(restore)

  const bytes = await accountHttp.accountExportAiLogs()
  assert.equal(urls[0], route("aiLogsExport"))
  assert.equal(new TextDecoder().decode(bytes), "id,model\n1,gpt-5\n")
})

test("a failed AI log read surfaces as a rejection", async (t) => {
  const restore = stubFetch(async () => jsonResponse({ code: "INTERNAL", message: "服务暂不可用" }, 500))
  t.after(restore)
  await assert.rejects(() => accountHttp.accountListAiLogs(1, 20))
})

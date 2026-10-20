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
    member_seats: 2,
    months: 12,
    unit_month_cents: 8000,
    duration_days: 365,
    amount_cents: 192000,
    credit_cents: 0,
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

/** Cloud wraps every order read/write as `{"data":{"order":{…}}}` — never flat. */
function orderEnvelope(order: PaymentOrderView) {
  return { data: { order } }
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

test("accountCreatePaymentIntent unwraps data.order", async (t) => {
  const order = orderView()
  const calls: string[] = []
  const restore = stubFetch(async (input) => {
    calls.push(String(input))
    return jsonResponse(orderEnvelope(order))
  })
  t.after(restore)

  const created = await accountHttp.accountCreatePaymentIntent({
    seats: 2,
    term: "year",
    tier: "pro",
    provider: "alipay",
    expected_workspace_uuid: "8f0a3f5e-6c1d-4a5f-9a3e-6d2c8b7f4a11",
  })
  assert.equal(calls.length, 1)
  assert.match(calls[0], /\/api\/payment-intent$/)
  assert.equal(created.public_id, "order-1")
  assert.equal(created.status, "pending")
  assert.equal(created.qr_code, "qr://payload")
  assert.equal(created.pay_url, "https://pay.invalid/checkout/order-1")
})

/**
 * All three paid writes carry `expected_workspace_uuid` — the Workspace
 * the dialog was opened on — so Cloud can refuse a write whose session has
 * since resolved elsewhere.
 */
test("paid writes post the Workspace the dialog confirmed", async (t) => {
  const workspaceUuid = "8f0a3f5e-6c1d-4a5f-9a3e-6d2c8b7f4a11"
  const bodies: unknown[] = []
  const restore = stubFetch(async (input, init) => {
    bodies.push(JSON.parse(String(init?.body)))
    if (String(input).endsWith(route("redeem"))) {
      return jsonResponse({
        data: {
          ok: true,
          plan: { key: "pro", name: "专业版" },
          member_seats: 2,
          ocr_credits: 0,
          wallet_cents: 0,
        },
      })
    }
    return jsonResponse(orderEnvelope(orderView()))
  })
  t.after(restore)

  await accountHttp.accountCreatePaymentIntent({
    seats: 2,
    term: "year",
    tier: "pro",
    provider: "alipay",
    expected_workspace_uuid: workspaceUuid,
  })
  await accountHttp.accountRedeemCode({ code: "ABC-123", expected_workspace_uuid: workspaceUuid })
  await accountHttp.accountCreateRechargeOrder({
    operation_id: "recharge-op",
    amount_cents: 500,
    provider: "manual",
    expected_workspace_uuid: workspaceUuid,
  })

  assert.deepEqual(bodies, [
    {
      seats: 2,
      term: "year",
      tier: "pro",
      provider: "alipay",
      expected_workspace_uuid: workspaceUuid,
    },
    { code: "ABC-123", expected_workspace_uuid: workspaceUuid },
    { operation_id: "recharge-op", amount_cents: 500, provider: "manual", expected_workspace_uuid: workspaceUuid },
  ])
})

test("wallet detail keeps a pending online recharge available for recovery", async (t) => {
  const states = ["entry_unknown", "entry_confirming"]
  let call = 0
  const restore = stubFetch(async () =>
    jsonResponse({
      data: {
        wallet: { balance_microfen: 0, held_microfen: 0, available_microfen: 0 },
        ledger: [],
        recharges: [rechargeView({ entry_state: states[call++] })],
      },
    }),
  )
  t.after(restore)

  for (const state of states) {
    const detail = await accountHttp.accountGetWalletDetail()
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
    return jsonResponse({ data: { order: rechargeView() } })
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
      data: { order: rechargeView({ entry_state: "entry_confirming" }) },
    })
  })
  t.after(restore)

  const recovered = await accountHttp.accountRecoverRechargeOrder("recharge-1")
  assert.match(calls[0], /\/api\/ai\/recharge\/orders\/recharge-1\/recover$/)
  assert.equal(recovered.public_id, "recharge-1")
  assert.equal(recovered.status, "pending")
})

test("payment intents carry the attempt operation_id through", async (t) => {
  const bodies: unknown[] = []
  const restore = stubFetch(async (_input, init) => {
    bodies.push(JSON.parse(String(init?.body)))
    return jsonResponse(orderEnvelope(orderView()))
  })
  t.after(restore)

  await accountHttp.accountCreatePaymentIntent({
    seats: 2,
    term: "year",
    tier: "pro",
    provider: "alipay",
    expected_workspace_uuid: "8f0a3f5e-6c1d-4a5f-9a3e-6d2c8b7f4a11",
    operation_id: "attempt-1",
  })
  await accountHttp.accountCreateRenewalIntent({
    renews_lot_id: 7,
    term: "month",
    provider: "wechat",
    expected_workspace_uuid: "8f0a3f5e-6c1d-4a5f-9a3e-6d2c8b7f4a11",
    operation_id: "attempt-2",
  })

  assert.deepEqual(bodies, [
    {
      seats: 2,
      term: "year",
      tier: "pro",
      provider: "alipay",
      expected_workspace_uuid: "8f0a3f5e-6c1d-4a5f-9a3e-6d2c8b7f4a11",
      operation_id: "attempt-1",
    },
    {
      renews_lot_id: 7,
      term: "month",
      provider: "wechat",
      expected_workspace_uuid: "8f0a3f5e-6c1d-4a5f-9a3e-6d2c8b7f4a11",
      operation_id: "attempt-2",
    },
  ])
})

test("accountRecoverPaymentOrder unwraps the recovered order", async (t) => {
  const order = orderView({ entry_state: "entry_confirming" })
  const calls: string[] = []
  const restore = stubFetch(async (input) => {
    calls.push(String(input))
    return jsonResponse(orderEnvelope(order))
  })
  t.after(restore)

  const recovered = await accountHttp.accountRecoverPaymentOrder("order-1")
  assert.equal(calls.length, 1)
  assert.match(calls[0], /\/api\/orders\/order-1\/recover$/)
  assert.equal(recovered.status, "pending")
  assert.equal(recovered.entry_state, "entry_confirming")
})

test("accountGetPaymentOrder unwraps data.order", async (t) => {
  const order = orderView({ status: "paid", paid_at: "2026-09-17T01:00:00Z" })
  const calls: string[] = []
  const restore = stubFetch(async (input) => {
    calls.push(String(input))
    return jsonResponse(orderEnvelope(order))
  })
  t.after(restore)

  const fetched = await accountHttp.accountGetPaymentOrder("order-1")
  assert.equal(calls.length, 1)
  assert.match(calls[0], /\/api\/orders\/order-1$/)
  assert.equal(fetched.status, "paid")
  assert.equal(fetched.member_seats, 2)
})

test("accountCancelPaymentOrder unwraps data.order", async (t) => {
  const order = orderView({ status: "canceled", canceled_at: "2026-09-17T02:00:00Z" })
  const calls: string[] = []
  const restore = stubFetch(async (input) => {
    calls.push(String(input))
    return jsonResponse(orderEnvelope(order))
  })
  t.after(restore)

  const canceled = await accountHttp.accountCancelPaymentOrder("order-1")
  assert.match(calls[0], /\/api\/orders\/order-1\/cancel$/)
  assert.equal(canceled.status, "canceled")
})

test("accountOpenPaymentOrder opens the pay_url from inside data.order", async (t) => {
  const order = orderView()
  const opened: string[] = []
  const restore = stubFetch(async () => jsonResponse(orderEnvelope(order)))
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
  const restore = stubFetch(async () => jsonResponse(orderEnvelope(order)))
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

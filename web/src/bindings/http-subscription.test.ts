import assert from "node:assert/strict"
import test from "node:test"
import { route } from "@/api/routes"
import { subscriptionHttp } from "./http-subscription"
import { subscriptionFixture } from "../../tests/fixtures/subscription"

test("subscription bindings read direct JSON DTOs for every billing operation", async () => {
  const original = globalThis.fetch
  const quote = { quote_id: "quote-test", amount_cents: 0, action: "keep", free_only: true }
  const brief = { order_id: 1, public_id: "po_test", payment_deadline_at: "2026-11-21T03:00:00Z" }
  const order = { public_id: "po_test", status: "pending", amount_cents: 12000, reconciliation_reason: null, purchase_agreement: {} }
  const responses = [subscriptionFixture, quote, subscriptionFixture, brief, order]
  const calls: { path: string; method: string; body: unknown }[] = []
  globalThis.fetch = async (input, init) => {
    assert.equal(init?.credentials, "include")
    calls.push({ path: String(input), method: init?.method ?? "GET", body: init?.body ? JSON.parse(String(init.body)) : undefined })
    return Response.json(responses.shift())
  }
  try {
    const target = { plan_key: "lite", stores: 2 }
    assert.deepEqual(await subscriptionHttp.view(), subscriptionFixture)
    assert.deepEqual(await subscriptionHttp.quote({ action: "keep", period_id: 2, target, keep_store_ids: ["s1", "s2"], expected_workspace_uuid: "00000000-0000-4000-8000-000000000001" }), quote)
    assert.deepEqual(await subscriptionHttp.keep(quote.quote_id, false), subscriptionFixture)
    assert.deepEqual(await subscriptionHttp.order(quote.quote_id, "subscription-2026-10-30"), brief)
    assert.deepEqual(await subscriptionHttp.getOrder(brief.public_id), order)
    assert.deepEqual(calls.map(({ path, method }) => [method, path]), [
      ["GET", route("billingSubscription")], ["POST", route("billingQuotes")],
      ["POST", route("billingKeep")], ["POST", route("billingOrders")],
      ["GET", route("billingOrdersByPublicId", { public_id: brief.public_id })],
    ])
    assert.deepEqual(calls[2]?.body, { quote_id: quote.quote_id, cancel_pending: false })
  } finally { globalThis.fetch = original }
})

test("subscription checkout sends the selected provider and preserves stored payment entry fields", async () => {
  const original = globalThis.fetch
  const entry = { order_id: 7, public_id: "po_online", payment_deadline_at: "2026-11-21T03:00:00Z", provider: "alipay", qr_code: "https://pay.example.invalid/qr", entry_state: "ready" }
  const calls: unknown[] = []
  globalThis.fetch = async (_input, init) => {
    calls.push(init?.body ? JSON.parse(String(init.body)) : undefined)
    return Response.json(entry)
  }
  try {
    assert.deepEqual(await subscriptionHttp.order("quote-online", "agreement-1", "alipay"), entry)
    assert.deepEqual(calls, [{ quote_id: "quote-online", accepted_version: "agreement-1", provider: "alipay" }])
  } finally { globalThis.fetch = original }
})

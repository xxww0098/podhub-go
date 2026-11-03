import assert from "node:assert/strict"
import test from "node:test"
import { route } from "@/api/routes"
import { listingCardSaveProfitAssumptions } from "../card/card-writes"
import { primeCardSession, resetCardSessions, type CardPayloadView } from "../card/card-session"
import type { ManualProfitAssumptions } from "./profit-quote"

const input: ManualProfitAssumptions = { currency: "CNY", costs: [{ name: "成本", amount: "80.00", currency: "CNY" }], fees: [{ name: "佣金假设", rateBps: 1000 }], targetMarginBps: 2000 }
function card(id: string, currency: string | undefined = "CNY", revision = 1, supplier = false): CardPayloadView {
  return { id, title: "试算方案", revision, updated_at_ms: 1, payload: {
    categoryKey: "workflow:1:2", descriptionCategoryId: 1, typeId: 2,
    ...(supplier ? { supplierProductId: "s-1" } : {}),
    defaults: { values: { price: { kind: "text", value: "5.00" }, old_price: { kind: "text", value: "200.00" },
      ...(currency ? { currency_code: { kind: "text", value: currency } } : {}) }, complex_values: [] },
    aiFieldPolicy: { allowed_field_keys: [], protected_field_keys: [] }, aiPrompt: "保留提示词",
  } } as CardPayloadView
}
function response(data: unknown, status = 200) {
  return new Response(JSON.stringify(status === 200 ? { data } : { code: "CONFLICT", error: "上架方案已被他人更新" }), { status, headers: { "Content-Type": "application/json" } })
}

test("manual trial persistence preserves the fixed price; explicit apply sends an exact text price through CAS", async () => {
  const original = globalThis.fetch
  let current = card("profit-card")
  primeCardSession(current)
  const bodies: Array<{ baseRevision: number; payload: Record<string, any> }> = []
  globalThis.fetch = (async (url, init) => {
    assert.equal(String(url), `${route("listingCards")}/profit-card`)
    assert.equal(init?.method, "PATCH", "never calls store-price endpoints")
    const body = JSON.parse(String(init?.body))
    bodies.push(body)
    assert.equal(body.baseRevision, current.revision)
    current = { ...current, payload: body.payload, revision: current.revision + 1 }
    return response(current)
  }) as typeof fetch
  try {
    await listingCardSaveProfitAssumptions(current.id, input)
    assert.deepEqual(bodies[0]!.payload.pricingAssumptions, input)
    assert.deepEqual(bodies[0]!.payload.defaults.values.price, { kind: "text", value: "5.00" })
    assert.equal(bodies[0]!.payload.aiPrompt, "保留提示词")
    const saved = await listingCardSaveProfitAssumptions(current.id, input, true)
    assert.equal(saved.price, "114.29")
    assert.deepEqual(bodies[1]!.payload.defaults.values.price, { kind: "text", value: "114.29" })
    assert.equal(bodies[1]!.baseRevision, 2)
  } finally { globalThis.fetch = original; resetCardSessions() }
})

test("currency changed during conflict replay refuses the price and preserves the operator inputs", async () => {
  const original = globalThis.fetch
  const initial = card("profit-conflict", "CNY", 1)
  primeCardSession(initial)
  let patches = 0
  let gets = 0
  globalThis.fetch = (async (_url, init) => {
    if (init?.method === "PATCH") {
      patches++
      const payload = JSON.parse(String(init.body)).payload
      assert.deepEqual(payload.pricingAssumptions, input)
      assert.equal(payload.aiPrompt, "保留提示词")
      return response(null, 409)
    }
    gets++
    return response(card(initial.id, "RUB", 2))
  }) as typeof fetch
  try {
    await assert.rejects(listingCardSaveProfitAssumptions(initial.id, input, true), /币种.*不一致/)
    assert.equal(patches, 1)
    assert.equal(gets, 1)
    assert.equal(input.costs[0]!.amount, "80.00")
  } finally { globalThis.fetch = original; resetCardSessions() }
})

test("supplier trial saves only its owned inputs; applying never sends an HTTP write", async () => {
  const original = globalThis.fetch
  const supplier = card("profit-supplier", "CNY", 1, true)
  primeCardSession(supplier)
  let writes = 0
  globalThis.fetch = (async (_url, init) => {
    writes++
    const payload = JSON.parse(String(init?.body)).payload
    assert.deepEqual(Object.keys(payload), ["pricingAssumptions"])
    return response({ ...supplier, revision: 2, payload: { ...(supplier.payload as object), ...payload } })
  }) as typeof fetch
  try {
    await listingCardSaveProfitAssumptions(supplier.id, input)
    assert.equal(writes, 1)
    await assert.rejects(listingCardSaveProfitAssumptions(supplier.id, input, true), /供应方案当前仅可试算/)
    assert.equal(writes, 1)
  } finally { globalThis.fetch = original; resetCardSessions() }
})

test("unconfigured currency, invalid quote and an incompatible old price never send a write", async () => {
  const original = globalThis.fetch
  let writes = 0
  globalThis.fetch = (async () => { writes++; throw new Error("unexpected network") }) as typeof fetch
  try {
    const missing = card("profit-missing")
    delete (missing.payload as any).defaults.values.currency_code
    primeCardSession(missing)
    await assert.rejects(listingCardSaveProfitAssumptions(missing.id, input, true), /仅可试算/)
    const lowOld = card("profit-low-old")
    ;(lowOld.payload as any).defaults.values.old_price.value = "100.00"
    primeCardSession(lowOld)
    await assert.rejects(listingCardSaveProfitAssumptions(lowOld.id, input, true), /小于当前划线价/)
    await assert.rejects(listingCardSaveProfitAssumptions(missing.id, { ...input, targetMarginBps: 9000 }), /100%/)
    assert.equal(writes, 0)
  } finally { globalThis.fetch = original; resetCardSessions() }
})

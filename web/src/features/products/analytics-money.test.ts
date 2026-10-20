import assert from "node:assert/strict"
import test from "node:test"

import { analyticsRevenue } from "./analytics-money"

const metrics = {
  revenue: 500,
  revenue_currency: "RUB",
  fx_quote: "CNY",
  fx_rate: 10,
  fx_as_of: "2026-10-12",
}

test("a CNY store shows revenue divided by the recorded ruble rate", () => {
  const shown = analyticsRevenue(metrics, "CNY")
  assert.equal(shown.amount, 50)
  assert.equal(shown.currency, "CNY")
  assert.equal(shown.text, "50 CNY")
  assert.match(shown.title ?? "", /1 CNY = 10 RUB/)
  assert.match(shown.title ?? "", /2026-10-12/)
  assert.match(shown.title ?? "", /俄罗斯央行/)
  assert.match(shown.title ?? "", /₽/)
})

test("without a rate, a CNY store still shows rubles", () => {
  const shown = analyticsRevenue(
    { ...metrics, fx_quote: null, fx_rate: null, fx_as_of: null },
    "cny",
  )
  assert.equal(shown.currency, "RUB")
  assert.equal(shown.title, null)
  assert.doesNotMatch(shown.text, /CNY/)
})

test("a RUB store ignores a stray quote and keeps rubles", () => {
  const shown = analyticsRevenue(metrics, "RUB")
  assert.equal(shown.currency, "RUB")
  assert.equal(shown.amount, 500)
  assert.equal(shown.title, null)
})

test("a quote for a different currency is not applied", () => {
  const shown = analyticsRevenue(metrics, "USD")
  assert.equal(shown.currency, "RUB")
})

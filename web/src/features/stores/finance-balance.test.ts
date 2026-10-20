import assert from "node:assert/strict"
import test from "node:test"

import { financeBalanceDisplay, type StoreFinanceBalance } from "./finance-balance"

const ready: StoreFinanceBalance = {
  outcome: "ready",
  amount: "1520.50",
  currency_code: "CNY",
  period_to: "2026-10-12",
  fetched_at_ms: 1,
}

test("a non-RUB closing balance keeps the currency the API reported", () => {
  const shown = financeBalanceDisplay(ready, { configured: true, reading: false })
  assert.equal(shown.text.includes("CNY"), true)
  assert.equal(shown.text.includes("₽"), false)
  assert.equal(shown.text.includes("RUB"), false)
  assert.equal(shown.title, "期末 2026-10-12")
  assert.equal(shown.retry, false)
})

test("RUB without a central-bank stamp stays labeled RUB", () => {
  const shown = financeBalanceDisplay(
    { ...ready, amount: "1000.25", currency_code: "RUB", fx_quote: "CNY", fx_rate: "12.5" },
    { configured: true, reading: false },
  )
  assert.equal(shown.text.includes("₽"), true)
  assert.equal(shown.text.includes("CNY"), false)
})

test("RUB converts only when a positive CBR quote is stamped", () => {
  const shown = financeBalanceDisplay(
    {
      ...ready,
      amount: "1250.00",
      currency_code: "RUB",
      fx_quote: "CNY",
      fx_rate: "12.5",
      fx_as_of: "2026-10-12",
      fx_source: "cbr",
    },
    { configured: true, reading: false },
  )
  assert.equal(shown.text.includes("CNY"), true)
  assert.equal(shown.text.includes("₽"), false)
  assert.match(shown.title, /原值/)
  assert.match(shown.title, /俄罗斯央行/)
  assert.match(shown.title, /2026-10-12/)
})

test("a blank currency is never labeled RUB", () => {
  const shown = financeBalanceDisplay(
    { ...ready, currency_code: "  " },
    { configured: true, reading: false },
  )
  assert.equal(shown.text, "暂无")
  assert.equal(shown.text.includes("RUB"), false)
  assert.equal(shown.text.includes("₽"), false)
})

test("permission, absence and failure stay distinct from a balance", () => {
  assert.equal(
    financeBalanceDisplay({ ...ready, outcome: "forbidden" }, { configured: true, reading: false }).text,
    "无权限",
  )
  assert.equal(
    financeBalanceDisplay({ ...ready, outcome: "unavailable" }, { configured: true, reading: false }).text,
    "暂无",
  )
  const failed = financeBalanceDisplay(
    { ...ready, outcome: "error" },
    { configured: true, reading: false },
  )
  assert.equal(failed.text, "读取失败")
  assert.equal(failed.retry, true)
})

test("an unconfigured store and a pending read do not invent an amount", () => {
  assert.equal(
    financeBalanceDisplay(null, { configured: false, reading: true }).text,
    "—",
  )
  assert.equal(
    financeBalanceDisplay(undefined, { configured: true, reading: true }).text,
    "读取中",
  )
  assert.equal(
    financeBalanceDisplay(null, { configured: true, reading: false }).text,
    "—",
  )
})

import assert from "node:assert/strict"
import test from "node:test"
import { calculateManualProfitQuote, percentToBps, profitQuoteApplyIssue, type ManualProfitAssumptions } from "./profit-quote"

const input = (change: Partial<ManualProfitAssumptions> = {}): ManualProfitAssumptions => ({
  currency: "CNY", costs: [{ name: "采购及运费", amount: "80.00", currency: "CNY" }],
  fees: [{ name: "人工佣金假设", rateBps: 1000 }], targetMarginBps: 2000, ...change,
})

test("percentage entry and apply guards preserve exact input semantics", () => {
  assert.equal(percentToBps("0"), 0)
  assert.equal(percentToBps("99.99"), 9999)
  for (const invalid of ["", "-1", "100", "1.001", "1e2", "Infinity"]) assert.throws(() => percentToBps(invalid))
  assert.match(profitQuoteApplyIssue(undefined, "RUB", "10.00")!, /仅可试算/)
  assert.match(profitQuoteApplyIssue({ kind: "text", value: "CNY" }, "RUB", "10.00")!, /不一致/)
  assert.match(profitQuoteApplyIssue({ kind: "text", value: "CNY" }, "CNY", "10.00", "10")!, /划线价/)
  assert.equal(profitQuoteApplyIssue({ kind: "text", value: "CNY" }, "CNY", "10.00", "10.001"), undefined)
})

test("manual assumptions produce an exact minimum price and a JSON-safe loss/profit readback", () => {
  const quote = calculateManualProfitQuote(input())
  assert.equal(quote.basis, "manual_assumptions")
  assert.equal(quote.price, "114.29")
  assert.equal(quote.fixedCostMinor, "8000")
  assert.equal(quote.fees[0]!.amountMinor, "1143")
  assert.equal(quote.profitMinor, "2286")
  assert.ok(11_428n - 8000n - 1143n < (11_428n * 2000n + 9999n) / 10_000n)
  assert.ok(BigInt(quote.profitMinor) * 10_000n >= BigInt(quote.priceMinor) * 2000n)
  assert.deepEqual(JSON.parse(JSON.stringify(quote)), quote)
})

test("cross-currency costs require an explicit directional rate and round each converted cost upward", () => {
  const quote = calculateManualProfitQuote(input({ currency: "RUB", costs: [
    { name: "采购", amount: "0.01", currency: "CNY", exchangeRate: "12.34567890" },
    { name: "运费", amount: "0.01", currency: "RUB" },
  ], fees: [], targetMarginBps: 0 }))
  assert.equal(quote.costs[0]!.convertedMinor, "13")
  assert.equal(quote.fixedCostMinor, "14")
  assert.equal(quote.price, "0.14")
  assert.equal(quote.profitMinor, "0")
})

test("the minimum solver handles a non-monotone rounded-profit predicate", () => {
  const quote = calculateManualProfitQuote(input({ costs: [{ name: "成本", amount: "0.01", currency: "CNY" }], fees: [{ name: "费用", rateBps: 5000 }], targetMarginBps: 4000 }))
  assert.equal(quote.priceMinor, "10")
  const slack = (price: bigint) => price - 1n - (price * 5000n + 9999n) / 10_000n - (price * 4000n + 9999n) / 10_000n
  assert.equal(slack(10n), 0n)
  assert.equal(slack(11n), -1n)
  assert.equal(slack(12n), 0n)
})

test("separately rounded fees and boundary percentages retain the earliest attainable minor unit", () => {
  for (const [fixed, rates, margin] of [[1, [1234, 2345, 111], 2100], [2, [5000, 4998], 1], [0, [1, 1], 0], [3, [3333, 2222], 1111]] as const) {
    const quote = calculateManualProfitQuote(input({ costs: [{ name: "成本", amount: (fixed / 100).toFixed(2), currency: "CNY" }], fees: rates.map((rateBps, index) => ({ name: `费用${index}`, rateBps })), targetMarginBps: margin }))
    const pass = (price: bigint) => price - BigInt(fixed) - rates.reduce((sum, rate) => sum + (price * BigInt(rate) + 9999n) / 10_000n, 0n) >= (price * BigInt(margin) + 9999n) / 10_000n
    for (let price = 1n; price < BigInt(quote.priceMinor); price += 1n) assert.equal(pass(price), false, `unexpected earlier price ${price}`)
    assert.equal(pass(BigInt(quote.priceMinor)), true)
  }
})

test("missing, negative, over-precise, non-finite and unsafe monetary assumptions are refused", () => {
  for (const amount of ["", "-1", "1.001", "1e3", "NaN", "Infinity", "999999999999999999999999999999"]) {
    assert.throws(() => calculateManualProfitQuote(input({ costs: [{ name: "成本", amount, currency: "CNY" }] })))
  }
  for (const rate of [-1, 10_000, 1.2, NaN, Infinity]) {
    assert.throws(() => calculateManualProfitQuote(input({ fees: [{ name: "费用", rateBps: rate }] })))
    assert.throws(() => calculateManualProfitQuote(input({ targetMarginBps: rate })))
  }
  assert.throws(() => calculateManualProfitQuote(input({ costs: [] })))
  assert.throws(() => calculateManualProfitQuote(input({ costs: [{ name: "成本", amount: "1", currency: "RUB" }] })), /汇率/)
  assert.throws(() => calculateManualProfitQuote(input({ costs: [{ name: "成本", amount: "1", currency: "CNY", exchangeRate: "2" }] })), /汇率/)
  assert.throws(() => calculateManualProfitQuote(input({ costs: [{ name: "成本", amount: "1", currency: "RUB", exchangeRate: "0" }] })), /汇率/)
  assert.throws(() => calculateManualProfitQuote(input({ costs: [{ name: "成本", amount: "9999999999.99", currency: "CNY" }], fees: [], targetMarginBps: 9999 })), /上限/)
  assert.throws(() => calculateManualProfitQuote(input({ fees: [{ name: "费用", rateBps: 9000 }], targetMarginBps: 1000 })), /100%/)
})

import assert from "node:assert/strict"
import test from "node:test"

import {
  formatProductQuotaBucket,
  getProductQuotaColor,
  productQuotaItems,
  productQuotaLines,
  resolveProductQuotaItem,
} from "./product-quota"

test("minus one is unlimited remaining", () => {
  assert.equal(formatProductQuotaBucket({ limit: -1, usage: 12 }), "不限")
})

test("remaining is limit minus usage and never negative", () => {
  assert.equal(formatProductQuotaBucket({ limit: 100, usage: 12 }), "88 / 100")
  assert.equal(formatProductQuotaBucket({ limit: 10, usage: 40 }), "0 / 10")
})

test("quota lines skip missing buckets and empty snapshots", () => {
  assert.deepEqual(productQuotaLines(null), [])
  assert.deepEqual(
    productQuotaLines({
      daily_create: { limit: 100, usage: 12 },
      total: { limit: -1, usage: 80 },
    }),
    [
      { label: "新建", value: "88 / 100" },
      { label: "基础", value: "不限" },
    ],
  )
})

test("getProductQuotaColor transitions from green (high) to red (low)", () => {
  assert.equal(
    getProductQuotaColor(1),
    "color-mix(in oklch, var(--st-good) 100%, var(--st-attest))",
  )
  assert.equal(
    getProductQuotaColor(0.5),
    "color-mix(in oklch, var(--st-good) 0%, var(--st-attest))",
  )
  assert.equal(
    getProductQuotaColor(0),
    "color-mix(in oklch, var(--st-attest) 0%, var(--st-bad))",
  )
  assert.equal(
    getProductQuotaColor(0.25),
    "color-mix(in oklch, var(--st-attest) 50%, var(--st-bad))",
  )
})

test("resolveProductQuotaItem calculates decreasing progress bar attributes", () => {
  // Full quota remaining (100 / 100) -> 100% full, tier good
  const full = resolveProductQuotaItem("新建", { limit: 100, usage: 0 })
  assert.equal(full.remaining, 100)
  assert.equal(full.ratio, 1)
  assert.equal(full.percentage, 100)
  assert.equal(full.barWidth, 100)
  assert.equal(full.tier, "good")
  assert.equal(full.remainingFormatted, "100")

  // Decreased quota (633 / 1000) -> 63% full, tier good
  const partial = resolveProductQuotaItem("基础", { limit: 1000, usage: 367 })
  assert.equal(partial.remaining, 633)
  assert.equal(partial.percentage, 63)
  assert.equal(partial.barWidth, 63)
  assert.equal(partial.tier, "good")
  assert.equal(partial.remainingFormatted, "633")

  // Low quota (15 / 100) -> 15% full, tier danger (red)
  const low = resolveProductQuotaItem("新建", { limit: 100, usage: 85 })
  assert.equal(low.remaining, 15)
  assert.equal(low.percentage, 15)
  assert.equal(low.barWidth, 15)
  assert.equal(low.tier, "danger")
  assert.equal(low.remainingFormatted, "15")

  // Exhausted quota (0 / 10) -> 0% barWidth, tier danger (red)
  const exhausted = resolveProductQuotaItem("更新", { limit: 10, usage: 15 })
  assert.equal(exhausted.remaining, 0)
  assert.equal(exhausted.percentage, 0)
  assert.equal(exhausted.barWidth, 0)
  assert.equal(exhausted.tier, "danger")
  assert.equal(exhausted.remainingFormatted, "0")

  // Tiny quota remaining (1 / 1000) -> ensures minimum visible pip (barWidth >= 3)
  const sliver = resolveProductQuotaItem("基础", { limit: 1000, usage: 999 })
  assert.equal(sliver.remaining, 1)
  assert.equal(sliver.barWidth, 3)

  // Uncapped quota (-1) -> full bar, tier good, formatted 不限
  const uncapped = resolveProductQuotaItem("基础", { limit: -1, usage: 80 })
  assert.equal(uncapped.remaining, null)
  assert.equal(uncapped.percentage, 100)
  assert.equal(uncapped.barWidth, 100)
  assert.equal(uncapped.tier, "good")
  assert.equal(uncapped.remainingFormatted, "不限")
})

test("productQuotaItems returns items for all present buckets", () => {
  assert.deepEqual(productQuotaItems(null), [])
  const items = productQuotaItems({
    daily_create: { limit: 100, usage: 0 },
    daily_update: { limit: 5000, usage: 0 },
    total: { limit: 1000, usage: 367 },
  })
  assert.equal(items.length, 3)
  assert.equal(items[0]!.label, "新建")
  assert.equal(items[0]!.remainingFormatted, "100")
  assert.equal(items[1]!.label, "更新")
  assert.equal(items[1]!.remainingFormatted, "5000")
  assert.equal(items[2]!.label, "基础")
  assert.equal(items[2]!.remainingFormatted, "633")
})

test("基础 counts archived products as refunded limit like the Seller cabinet", () => {
  // LUAN4 live account: API limit 1000 / usage 367 / archived 23 → the
  // cabinet shows effective limit 1023 with 656 remaining.
  const item = productQuotaItems({
    total: { limit: 1000, usage: 367, archived: 23 },
  })[0]!
  assert.equal(item.label, "基础")
  assert.equal(item.limit, 1023)
  assert.equal(item.remainingFormatted, "656")
  assert.equal(item.formatted, "656 / 1023")
  assert.match(item.tooltip, /归档回补 \+23/)

  const missing = productQuotaItems({ total: { limit: 1000, usage: 367 } })[0]!
  assert.equal(missing.remainingFormatted, "633")

  const uncapped = productQuotaItems({
    total: { limit: -1, usage: 367, archived: 23 },
  })[0]!
  assert.equal(uncapped.formatted, "不限")
})

test("附加 aggregates quota_by_category and lists each pool in the tooltip", () => {
  const quota = {
    total: {
      limit: 1000,
      usage: 367,
      categories: [
        { category_id: 17027490, limit: 200, usage: 0 },
        { category_id: 17027495, limit: 200, usage: 30 },
      ],
    },
  }
  const items = productQuotaItems(quota)
  assert.equal(items.length, 2)
  const extra = items[1]!
  assert.equal(extra.label, "附加")
  assert.equal(extra.limit, 400)
  assert.equal(extra.usage, 30)
  assert.equal(extra.remainingFormatted, "370")
  assert.match(extra.tooltip, /类目 17027490：200 \/ 200/)
  assert.match(extra.tooltip, /类目 17027495：170 \/ 200/)

  const named = productQuotaItems(quota, (id) =>
    new Map([
      [17027490, "古董和收藏品"],
      [17027495, "汽车用品"],
    ]).get(id),
  )[1]!
  assert.match(named.tooltip, /古董和收藏品（17027490）：200 \/ 200/)
  assert.match(named.tooltip, /汽车用品（17027495）：170 \/ 200/)
})

test("附加 shows 不限 when any category pool is uncapped", () => {
  const lines = productQuotaLines({
    total: {
      limit: 1000,
      usage: 0,
      categories: [
        { category_id: 1, limit: -1, usage: 5 },
        { category_id: 2, limit: 200, usage: 0 },
      ],
    },
  })
  assert.deepEqual(lines.at(-1), { label: "附加", value: "不限" })
})

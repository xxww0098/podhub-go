import assert from "node:assert/strict"
import test from "node:test"
import type { ListingCardSummary } from "@/bindings/commands"
import { planPrice } from "./recent-plans"

const card = (price: string | undefined, currency?: string) => ({
  draft_id: "draft-1", display_name: "方案", description_category_id: 1, type_id: 1, language: "zh-CN",
  ai_prompt_file_name: "", psd_template_file_name: "", target_store_id: "store-1", video_count: 0,
  price, updated_at_ms: 1,
  defaults: currency
    ? { values: { currency_code: { kind: "text" as const, value: currency } }, complex_values: [] }
    : undefined,
}) as ListingCardSummary

test("a plan price names its contract currency", () => {
  assert.equal(planPrice(card("1290", "CNY")), "1290 CNY")
  assert.equal(planPrice(card("1290")), "1290")
  assert.equal(planPrice(card("  ")), "—")
  assert.equal(planPrice(card(undefined)), "—")
})

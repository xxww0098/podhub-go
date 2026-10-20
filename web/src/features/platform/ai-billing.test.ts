import assert from "node:assert/strict"
import test from "node:test"

import type { AiPriceView } from "@/bindings/commands"
import {
  billingDraftFromPrice,
  parseYuanToMicrofen,
  publishRequestFromBilling,
} from "./ai-price-billing"

test("元输入按 microfen 入账，且与已发布价往返一致", () => {
  assert.equal(parseYuanToMicrofen("2"), 200_000_000)
  assert.equal(parseYuanToMicrofen("0.2"), 20_000_000)
  assert.equal(parseYuanToMicrofen("2.35"), 235_000_000)
  // 一个 microfen 就是最细的一档：¥0.00000001 / 百万 tokens。
  assert.equal(parseYuanToMicrofen("0.00000001"), 1)
  for (const bad of ["", " ", "-1", "0.000000001", "abc", "1e3", "12345678"]) {
    assert.equal(parseYuanToMicrofen(bad), undefined, bad)
  }

  const price: AiPriceView = {
    model: "gpt-5.6-luna",
    billing_mode: "token",
    input_microfen_per_million: 200_000_000,
    cached_input_microfen_per_million: 20_000_000,
    output_microfen_per_million: 800_000_000,
    reasoning_microfen_per_million: 12_500,
    per_request_microfen: 0,
    max_request_microfen: 5_000_000,
    effective_from: "2026-08-21T00:00:00+08:00",
  }
  const draft = billingDraftFromPrice(price)
  assert.equal(draft.rateInput, "2")
  assert.equal(draft.rateCachedInput, "0.2")
  assert.equal(draft.rateReasoning, "0.000125")
  assert.equal(draft.holdYuan, "0.05")
  assert.deepEqual(publishRequestFromBilling(price.model, draft), {
    model: price.model,
    billing_mode: "token",
    input_microfen_per_million: 200_000_000,
    cached_input_microfen_per_million: 20_000_000,
    output_microfen_per_million: 800_000_000,
    reasoning_microfen_per_million: 12_500,
    per_request_microfen: 0,
    max_request_microfen: 5_000_000,
  })
})

test("空白草稿的缓存与思考默认置零，发布请求允许留空由后端入零", () => {
  const blank = billingDraftFromPrice(undefined)
  assert.equal(blank.mode, "token")
  assert.equal(blank.rateInput, "")
  assert.equal(blank.rateCachedInput, "0")
  assert.equal(blank.rateOutput, "")
  assert.equal(blank.rateReasoning, "0")
  assert.equal(blank.holdYuan, "0.05")

  // 用户只填输入和输出价格，其余按占位符留空，发布请求合法且置零
  const filled = {
    ...blank,
    rateInput: "0.5",
    rateOutput: "1.5",
    rateCachedInput: "",
    rateReasoning: "",
  }
  const req = publishRequestFromBilling("qwen-vl", filled)
  assert.ok(req)
  assert.equal(req.model, "qwen-vl")
  assert.equal(req.input_microfen_per_million, 50_000_000)
  assert.equal(req.output_microfen_per_million, 150_000_000)
  assert.equal(req.cached_input_microfen_per_million, 0)
  assert.equal(req.reasoning_microfen_per_million, 0)
  assert.equal(req.max_request_microfen, 5_000_000)
})

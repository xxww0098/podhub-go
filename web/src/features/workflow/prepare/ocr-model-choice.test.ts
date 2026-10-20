import assert from "node:assert/strict"
import test from "node:test"
import {
  estimateCallMicrofen,
  ocrEstimateText,
  ocrModelFace,
  ocrUnitPriceText,
  type OcrPriceRates,
} from "./ocr-model-choice"
import { readOcrModelChoice, routingForNewTask, writeOcrModelChoice } from "./ocr-model-preference"

const tokenPrice = (patch: Partial<OcrPriceRates> = {}): OcrPriceRates => ({
  billing_mode: "token",
  input_microfen_per_million: 40_000_000,
  cached_input_microfen_per_million: 20_000_000,
  output_microfen_per_million: 160_000_000,
  reasoning_microfen_per_million: 160_000_000,
  ...patch,
})

function memory() {
  const items = new Map<string, string>()
  return {
    getItem: (key: string) => items.get(key) ?? null,
    setItem: (key: string, value: string) => { items.set(key, value) },
    removeItem: (key: string) => { items.delete(key) },
    raw: () => items.get("podhub.ocr-model.v1") ?? null,
  }
}

test("named models lead with thinking tier and display name; unknown models are not high precision", () => {
  const deepseek = ocrModelFace("deepseek/deepseek-v4.1-flash")
  assert.equal(deepseek.headline, "关闭思考 · DeepSeek 4.1 Flash")
  assert.equal(deepseek.modelId, "deepseek/deepseek-v4.1-flash")
  const qwen = ocrModelFace("qwen/qwen3.7-flash")
  assert.equal(qwen.headline, "关闭思考 · 千问 3.7 Flash")
  assert.equal(qwen.modelId, "qwen/qwen3.7-flash")
  assert.equal(ocrModelFace("qwen3.7-flash-2026-07-15").displayName, "千问 3.7 Flash")
  assert.equal(ocrModelFace("glm-5.3-flash").headline, "低思考 · GLM 5.3 Flash")
  const unknown = ocrModelFace("vendor/unevaluated-max")
  assert.equal(unknown.tier, "未分档")
  assert.equal(unknown.headline, "未分档 · vendor/unevaluated-max")
  for (const face of [deepseek, qwen, unknown, ocrModelFace("glm-5.3-flash")]) {
    assert.equal(JSON.stringify(face).includes("高精度"), false)
  }
})

test("unit price lists every published rate and the estimate ignores cache", () => {
  const price = tokenPrice({
    input_microfen_per_million: 100_000_000,
    cached_input_microfen_per_million: 1_000_000,
  })
  const unit = ocrUnitPriceText(price)
  assert.match(unit, /输入 ¥1\.00\/百万/)
  assert.match(unit, /缓存 ¥0\.01\/百万/)
  assert.match(unit, /输出 ¥1\.60\/百万/)
  assert.match(unit, /思考 ¥1\.60\/百万/)
  assert.doesNotMatch(unit, /缓存 ¥0\.05\/百万/)
  assert.equal(estimateCallMicrofen(price), 4_560_000)
  assert.equal(ocrEstimateText(price), "单次约 ¥0.0456")
  assert.equal(ocrEstimateText(tokenPrice()), "单次约 ¥0.0216")
  const flat = tokenPrice({ billing_mode: "per_request", per_request_microfen: 500_000 })
  assert.equal(ocrUnitPriceText(flat), "按次 ¥0.005/次")
  assert.equal(ocrEstimateText(flat), "单次约 ¥0.005")
})

test("the browser choice stores only primary and optional backup", () => {
  const store = memory()
  writeOcrModelChoice({ primary_model: " qwen3.7-flash " }, store)
  assert.equal(readOcrModelChoice(store), undefined)
  writeOcrModelChoice({ primary_model: "qwen3.7-flash", backup_model: "qwen3.7-flash" }, store)
  assert.deepEqual(readOcrModelChoice(store), { primary_model: "qwen3.7-flash" })
  assert.equal(store.raw()?.includes("price"), false)
  writeOcrModelChoice({ primary_model: "qwen3.7-flash", backup_model: "glm-5.3-flash" }, store)
  assert.deepEqual(readOcrModelChoice(store), { primary_model: "qwen3.7-flash", backup_model: "glm-5.3-flash" })
  writeOcrModelChoice(undefined, store)
  assert.equal(readOcrModelChoice(store), undefined)
  store.setItem("podhub.ocr-model.v1", "{")
  assert.equal(readOcrModelChoice(store), undefined)
})

test("system default is pinned at task creation without a backup or a price version", () => {
  const pinned = routingForNewTask(undefined, { default_ocr_model: "deepseek/deepseek-v4.1-flash" })
  assert.deepEqual(pinned, { primary_model: "deepseek/deepseek-v4.1-flash" })
  assert.equal(pinned && "backup_model" in pinned, false)
  assert.equal(JSON.stringify(pinned).includes("price"), false)
  assert.equal(routingForNewTask(undefined, { default_ocr_model: "  " }), undefined)
  assert.deepEqual(
    routingForNewTask({ primary_model: "glm-5.3-flash", backup_model: "qwen3.7-flash" }, { default_ocr_model: "deepseek/deepseek-v4.1-flash" }),
    { primary_model: "glm-5.3-flash", backup_model: "qwen3.7-flash" },
  )
})

import assert from "node:assert/strict"
import test from "node:test"
import { renderToStaticMarkup } from "react-dom/server"
import { commitOcrModelChoice, OcrModelControls, OcrModelSelects } from "./ocr-model-controls"
import { patchListingWorkbench, peekListingWorkbench, resetListingWorkbench } from "./listing-workbench-store"

const data = { prices: [], ocr_models: ["primary", "backup"], default_ocr_model: "primary" }
const noop = () => undefined
const priced = {
  prices: [{
    model: "deepseek/deepseek-v4.1-flash",
    billing_mode: "token",
    input_microfen_per_million: 40_000_000,
    cached_input_microfen_per_million: 20_000_000,
    output_microfen_per_million: 160_000_000,
    reasoning_microfen_per_million: 160_000_000,
    per_request_microfen: 0,
    max_request_microfen: 50_000_000,
    effective_from: "2026-09-04T00:00:00Z",
  }],
  ocr_models: ["deepseek/deepseek-v4.1-flash", "vendor/unevaluated-max"],
  default_ocr_model: "deepseek/deepseek-v4.1-flash",
}

test("OCR selection labels default and optional backup, and locks both during preparation", () => {
  const html = renderToStaticMarkup(<OcrModelSelects data={data} loading={false} disabled
    routing={{ primary_model: "primary", backup_model: "backup" }} retry={noop} onChange={noop} />)
  assert.match(html, /主模型/)
  assert.match(html, /备用模型/)
  assert.match(html, /仅未派发或明确认证拒绝时切换；按实际模型计费/)
  assert.match(html, /未分档 · primary/)
  assert.match(html, /未分档 · backup/)
  assert.doesNotMatch(html, /高精度/)
  assert.equal((html.match(/aria-haspopup="listbox"/g) ?? []).length, 2)
  assert.equal((html.match(/<button[^>]* disabled=""/g) ?? []).length, 2)
  const defaults = renderToStaticMarkup(<OcrModelSelects data={data} loading={false} disabled={false} retry={noop} onChange={noop} />)
  assert.match(defaults, /系统默认 · 未分档 · primary/)
  assert.match(defaults, /备用默认关闭/)
  assert.match(defaults, /无/)
  assert.doesNotMatch(defaults, /高精度/)
  assert.equal((defaults.match(/<button[^>]* disabled=""/g) ?? []).length, 1, "backup needs an explicit primary")
})

test("priced options show the full unit price and a single-call estimate", () => {
  const html = renderToStaticMarkup(<OcrModelSelects data={priced} loading={false} disabled={false} retry={noop} onChange={noop} />)
  assert.match(html, /关闭思考 · DeepSeek 4.1 Flash/)
  assert.match(html, /deepseek\/deepseek-v4\.1-flash/)
  assert.match(html, /输入 ¥0\.40\/百万/)
  assert.match(html, /缓存 ¥0\.20\/百万/)
  assert.match(html, /输出 ¥1\.60\/百万/)
  assert.match(html, /思考 ¥1\.60\/百万/)
  assert.match(html, /单次约 ¥0\.0216/)
  assert.match(html, /4 万未缓存输入 \+ 3\.5 千普通输出/)
  assert.match(html, /不含额外思考用量/)
  const unknown = renderToStaticMarkup(<OcrModelSelects data={priced} loading={false} disabled={false}
    routing={{ primary_model: "vendor/unevaluated-max" }} retry={noop} onChange={noop} />)
  assert.match(unknown, /未分档 · vendor\/unevaluated-max/)
  assert.doesNotMatch(html, /高精度/)
})

test("empty catalogue offers refresh; a stored choice survives changing tasks", () => {
  const html = renderToStaticMarkup(<OcrModelSelects data={{ prices: [], ocr_models: [] }} loading={false}
    disabled={false} retry={noop} onChange={noop} />)
  assert.match(html, /暂无可选模型/)
  assert.match(html, /刷新模型/)
  const previous = globalThis.localStorage
  const items = new Map<string, string>()
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: {
    getItem: (key: string) => items.get(key) ?? null,
    setItem: (key: string, value: string) => { items.set(key, value) },
    removeItem: (key: string) => { items.delete(key) },
  } })
  try {
    resetListingWorkbench()
    patchListingWorkbench({ modelRouting: { primary_model: "primary", backup_model: "backup" } })
    resetListingWorkbench()
    assert.equal(peekListingWorkbench().modelRouting, undefined, "an in-memory patch is not the browser preference")
    commitOcrModelChoice({ primary_model: "qwen3.7-flash", backup_model: "glm-5.3-flash" })
    resetListingWorkbench()
    assert.deepEqual(peekListingWorkbench().modelRouting, { primary_model: "qwen3.7-flash", backup_model: "glm-5.3-flash" })
    commitOcrModelChoice(undefined)
    resetListingWorkbench()
    assert.equal(peekListingWorkbench().modelRouting, undefined)
  } finally {
    Object.defineProperty(globalThis, "localStorage", { configurable: true, value: previous })
    resetListingWorkbench()
  }
})


test("the ribbon exposes one compact popover trigger instead of inline model selects", () => {
  const html = renderToStaticMarkup(<OcrModelControls disabled={false} />)
  assert.match(html, /识图模型/)
  assert.equal((html.match(/<button/g) ?? []).length, 1)
  assert.doesNotMatch(html, /aria-haspopup="listbox"/)
})

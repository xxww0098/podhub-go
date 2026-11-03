import assert from "node:assert/strict"
import { test } from "node:test"
import { renderToStaticMarkup } from "react-dom/server"
import type { ImageSet } from "@/bindings/http-ai-image-sets"
import { MediaRoleCell } from "../workbench/workbench-media-cell"
import { idleLifecycle } from "../workbench/workbench-test-fixtures"
import { rememberedImageSetURLs, rememberImageSet } from "./image-set-cache"
import { saveImageSetIntent, type ImageSetIntent } from "./image-set-state"

test("only the current source's GET/create candidates become AI media previews; lifecycle evidence stays intact", () => {
  const values = new Map<string, string>()
  const storage: Storage = { getItem: (key) => values.get(key) ?? null, setItem: (key, value) => { values.set(key, value) }, removeItem: (key) => { values.delete(key) }, clear: () => values.clear(), key: () => null, get length() { return values.size } }
  const originalStorage = Object.getOwnPropertyDescriptor(globalThis, "localStorage")
  try {
    Object.defineProperty(globalThis, "localStorage", { configurable: true, value: storage })
  const intent: ImageSetIntent = { owner: "display-owner:workspace", cardId: "card", rowId: "row", draftId: "draft", sourceHandle: "local-source", rawSHA256: "a".repeat(64), key: "image-set-00000000-0000-4000-8000-000000000003", setId: "00000000-0000-4000-8000-000000000004" }
  const view: ImageSet = { id: intent.setId!, requested_model: "qwen-image-2.1-pro", source_sha256: "b".repeat(64), status: "ready", items: [0, 1, 2].map((ordinal) => ({ ordinal, status: "ready", request_id: String(ordinal), charged_microfen: 25_000_000, asset: { object_id: String(ordinal), sha256: String(ordinal).repeat(64), url: `https://podhub-supplier.ozon-pod.com/display/orgs/1/images/${String(ordinal).repeat(64)}.jpg` } })) }
  saveImageSetIntent(intent)
  rememberImageSet(intent, view)
  const urls = rememberedImageSetURLs(intent)
  assert.equal(urls.length, 3)
  assert.deepEqual(rememberedImageSetURLs({ ...intent, sourceHandle: "other-source" }), [])
  const lifecycle = { ...idleLifecycle, media: "ready" as const }
  const before = JSON.stringify(lifecycle)
  const draft = { values: { images: { kind: "url_list" as const, value: urls }, primary_image: { kind: "text" as const, value: urls[1]! } }, complex_values: [] }
  const images = renderToStaticMarkup(<MediaRoleCell draftId="draft" role="images" lifecycle={lifecycle} draft={draft} aiImageURLs={urls} onRetryMedia={() => {}} />)
  const primary = renderToStaticMarkup(<MediaRoleCell draftId="draft" role="primary_image" lifecycle={lifecycle} draft={draft} aiImageURLs={urls} onRetryMedia={() => {}} />)
  assert.match(images, /查看 AI 商品图（3 张）/)
  assert.match(primary, /查看 AI 主图/)
  assert.equal(JSON.stringify(lifecycle), before)
  const untrusted = renderToStaticMarkup(<MediaRoleCell draftId="draft" role="images" lifecycle={lifecycle} draft={draft} onRetryMedia={() => {}} />)
  assert.doesNotMatch(untrusted, /查看 AI 商品图/)
  saveImageSetIntent({ ...intent, key: "image-set-00000000-0000-4000-8000-000000000005" })
  assert.deepEqual(rememberedImageSetURLs(intent), [], "a newer purchase invalidates old candidate previews")
  } finally { if (originalStorage) Object.defineProperty(globalThis, "localStorage", originalStorage); else Reflect.deleteProperty(globalThis, "localStorage") }
})

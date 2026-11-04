import assert from "node:assert/strict"
import test from "node:test"
import type { ImageSet } from "@/bindings/http-ai-image-sets"
import { emptyListingWorkbench } from "../workbench/listing-workbench-store"
import { row, instance, slice } from "../workbench/workbench-test-fixtures"
import { imageSetEditOpen, imageSetMediaDraft, imageSetUnknown, readImageSetIntent, readyImageSetURLs, reserveImageSetIntent, retryableImageSet, saveImageSetIntent, updateImageSetIntent, type ImageSetIntent } from "./image-set-state"

const intent: ImageSetIntent = { owner: "owner:workspace", cardId: "card", rowId: "image-1", draftId: "draft-1", sourceHandle: "source", rawSHA256: "a".repeat(64), key: "image-set-00000000-0000-4000-8000-000000000001", setId: "00000000-0000-4000-8000-000000000002" }
const view: ImageSet = { id: intent.setId!, requested_model: "qwen-image-2.1-pro", source_sha256: "b".repeat(64), status: "ready", items: [0, 1, 2].map((ordinal) => ({ ordinal, status: "ready", request_id: String(ordinal), charged_microfen: 25_000_000, asset: { object_id: String(ordinal), sha256: String(ordinal).repeat(64), url: `https://podhub-go-supplier.ozon-pod.com/test/orgs/1/images/${String(ordinal).repeat(64)}.jpg` } })) }
const urls = readyImageSetURLs(view)
function runtime() {
  const source = row(1, { id: intent.rowId, draftId: intent.draftId, source: { handle: intent.sourceHandle, file_name: "source.jpg" } as never })
  const product = instance(source)
  product.lifecycle = { ...product.lifecycle, media: "ready", images: [slice(0, { phase: "public_ready", public_url: "https://media.example.invalid/original.jpg" })] }
  product.draft.values.name = { kind: "text", value: "manual name" }
  return { ...emptyListingWorkbench(), cardId: intent.cardId, rows: [source], productDrafts: { [intent.draftId]: product } }
}
test("small intent roundtrips without bytes; corrupt and cross-scope records cannot authorize recovery", () => {
  const values = new Map<string, string>()
  const storage: Storage = { getItem: (key) => values.get(key) ?? null, setItem: (key, value) => { values.set(key, value) }, removeItem: (key) => { values.delete(key) }, clear: () => values.clear(), key: (index) => [...values.keys()][index] ?? null, get length() { return values.size } }
  saveImageSetIntent(intent, storage)
  const scope = { owner: intent.owner, cardId: intent.cardId, rowId: intent.rowId, draftId: intent.draftId, sourceHandle: intent.sourceHandle }
  assert.deepEqual(readImageSetIntent(scope, storage), intent, "reload reads by scope alone, without purchase metadata")
  assert.ok([...values.values()][0]!.length < 1024)
  assert.equal(readImageSetIntent({ ...intent, owner: "other" }, storage), undefined)
  const key = [...values.keys()][0]!
  values.set(key, JSON.stringify({ ...intent, rawSHA256: "broken" }))
  assert.equal(readImageSetIntent(intent, storage), undefined)
  assert.throws(() => saveImageSetIntent(intent, { ...storage, setItem: () => { throw Error("quota") } }), /quota/)
})
test("partial status with an unknown sibling stays locked; only confirmed canonical output URLs are selectable", () => {
  assert.equal(imageSetUnknown({ ...view, status: "partial", items: view.items.map((item, i) => i === 2 ? { ...item, status: "unknown", asset: undefined } : item) }), true)
  assert.equal(urls.length, 3)
  assert.deepEqual(readyImageSetURLs({ ...view, items: view.items.map((item) => ({ ...item, asset: { ...item.asset!, url: "https://attacker.invalid/x.jpg" } })) }), [])
})
test("concurrent components reserve one purchase identity; reload and a later tab recover the same key", async () => {
  const values = new Map<string, string>()
  const storage: Storage = { getItem: (key) => values.get(key) ?? null, setItem: (key, value) => { values.set(key, value) }, removeItem: (key) => { values.delete(key) }, clear: () => values.clear(), key: () => null, get length() { return values.size } }
  let turn = Promise.resolve()
  const locks = { request: <T,>(_name: string, callback: () => T | Promise<T>): Promise<T> => { const next = turn.then(callback); turn = next.then(() => undefined, () => undefined); return next } }
  const scope = { owner: intent.owner, cardId: intent.cardId, rowId: intent.rowId, draftId: intent.draftId, sourceHandle: intent.sourceHandle }
  const results = await Promise.all([reserveImageSetIntent(scope, intent.rawSHA256, () => true, locks, storage), reserveImageSetIntent(scope, intent.rawSHA256, () => true, locks, storage)])
  assert.equal(results.filter((result) => result.created).length, 1)
  assert.equal(results[0]!.intent.key, results[1]!.intent.key)
  assert.equal(readImageSetIntent(scope, storage)?.key, results[0]!.intent.key)
  const oldKey = results[0]!.intent.key
  const replacement = await reserveImageSetIntent(scope, intent.rawSHA256, () => true, locks, storage, oldKey)
  assert.equal(replacement.created, true)
  assert.notEqual(replacement.intent.key, oldKey)
  const delayed = await updateImageSetIntent(scope, oldKey, intent.setId!, locks, storage)
  assert.equal(delayed?.key, replacement.intent.key, "late old POST cannot overwrite a newer purchase")
  await updateImageSetIntent(scope, oldKey, null, locks, storage)
  assert.equal(readImageSetIntent(scope, storage)?.key, replacement.intent.key, "old price refusal cannot delete a newer purchase")
  const repeated = await reserveImageSetIntent(scope, intent.rawSHA256, () => true, locks, storage, oldKey)
  assert.equal(repeated.created, false)
  await assert.rejects(reserveImageSetIntent(scope, intent.rawSHA256, () => false, locks, storage), /状态已变化/)
  values.set([...values.keys()][0]!, "{corrupt")
  await assert.rejects(reserveImageSetIntent(scope, intent.rawSHA256, () => true, locks, storage), /记录损坏/)
})
test("only a complete confirmed failure may be explicitly replaced; runtime freezes prevent purchase and apply", () => {
  const failed = { ...view, status: "failed" as const, items: view.items.map((item) => ({ ...item, status: "failed" as const, asset: undefined })) }
  assert.equal(retryableImageSet(failed), true)
  assert.equal(retryableImageSet(view), false)
  assert.equal(retryableImageSet({ ...failed, items: failed.items.map((item, i) => i === 2 ? { ...item, status: "unknown" } : item) }), false)
  for (const frozen of ["queue", "removing", "removed"]) {
    const current = runtime()
    if (frozen === "queue") current.queueFrozenIds = [intent.draftId]
    if (frozen === "removing") current.pendingRemovalIds = new Set([intent.draftId])
    if (frozen === "removed") current.removedProducts = new Set([intent.draftId])
    assert.equal(imageSetEditOpen(current, intent, intent.owner), false)
    assert.throws(() => imageSetMediaDraft(current, intent.draftId, { intent, view, urls }, intent.owner), /状态已变化/)
  }
})
test("apply and restore update images+primary atomically, preserve PSD evidence and other manual fields", () => {
  const current = runtime(); const before = JSON.stringify(current)
  const next = imageSetMediaDraft(current, intent.draftId, { intent, view, urls: [urls[2]!, urls[0]!] }, intent.owner)
  assert.deepEqual(next.draft.values.images, { kind: "url_list", value: [urls[2], urls[0]] })
  assert.deepEqual(next.draft.values.primary_image, { kind: "text", value: urls[2] })
  assert.equal(next.draft.values.name, current.productDrafts[intent.draftId]!.draft.values.name)
  assert.equal(next.lifecycle, current.productDrafts[intent.draftId]!.lifecycle)
  assert.deepEqual(next.hand_edited_keys?.slice(-2), ["images", "primary_image"])
  assert.equal(JSON.stringify(current), before)
  current.productDrafts[intent.draftId] = next
  const restored = imageSetMediaDraft(current, intent.draftId, { intent, restore: true }, intent.owner)
  assert.deepEqual(restored.draft.values.images, { kind: "url_list", value: ["https://media.example.invalid/original.jpg"] })
  assert.deepEqual(restored.draft.values.primary_image, { kind: "text", value: "https://media.example.invalid/original.jpg" })
})
test("stale owner/source/card/row and publish/preparation fences all reject before an edit is queued", () => {
  const edit = { intent, view, urls }
  for (const stage of ["queued", "submitting", "accepted", "outcome_unknown", "operator_attested"] as const) {
    const current = runtime(); current.rows[0]!.stage = stage
    assert.throws(() => imageSetMediaDraft(current, intent.draftId, edit, intent.owner), /状态已变化/)
  }
  for (const patch of [{ owner: "other" }, { cardId: "other" }, { sourceHandle: "other" }, { rowId: "other" }]) assert.throws(() => imageSetMediaDraft(runtime(), intent.draftId, { ...edit, intent: { ...intent, ...patch } }, intent.owner), /状态已变化/)
  const current = runtime(); current.rows[0]!.publishUnconfirmed = true
  assert.throws(() => imageSetMediaDraft(current, intent.draftId, edit, intent.owner), /状态已变化/)
  assert.throws(() => imageSetMediaDraft(runtime(), intent.draftId, { ...edit, urls: ["https://attacker.invalid/x"] }, intent.owner), /本次已就绪/)
})

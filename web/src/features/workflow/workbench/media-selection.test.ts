import assert from "node:assert/strict"
import test from "node:test"
import { golden, goldenSchema, wasmCore } from "../submit/send-test-support"
import { idleLifecycle, instance, row as fixtureRow, slice } from "./workbench-test-fixtures"
import { deliveredMediaSlices, mediaSelectionValue, selectedMediaState, validateMediaSelection } from "./media-selection"

const a = "https://media.example.invalid/a.jpg"
const b = "https://media.example.invalid/b.jpg"
const lifecycle = { ...idleLifecycle, media: "ready" as const, images: [
  slice(1, { phase: "public_ready", public_url: b }),
  slice(0, { phase: "public_ready", public_url: a }),
  slice(2, { phase: "uploading", public_url: "https://media.example.invalid/pending.jpg" }),
] }

test("selection uses only confirmed slices, keeps operator order and projects the same primary fallback", () => {
  assert.deepEqual(deliveredMediaSlices(lifecycle).map((image) => image.public_url), [a, b])
  const images = mediaSelectionValue(lifecycle, "images", [b, a])
  const draft = { values: { images }, complex_values: [] }
  assert.deepEqual(selectedMediaState(lifecycle, draft, "images").slices.map((image) => image.public_url), [b, a])
  assert.deepEqual(selectedMediaState(lifecycle, draft, "primary_image").urls, [b])
  assert.deepEqual(selectedMediaState(lifecycle, draft, "color_image").urls, [b])
  const color = { ...lifecycle, images: lifecycle.images.map((image) => image.public_url === a ? { ...image, group_name: "颜色样本" } : image) }
  assert.deepEqual(selectedMediaState(color, draft, "color_image").urls, [a], "a real colour group wins over the selected image fallback")
  assert.deepEqual(mediaSelectionValue(lifecycle, "primary_image", [b]), { kind: "text", value: b })
  for (const urls of [[], [a, a], ["https://other.example.invalid/a.jpg"], ["https://media.example.invalid/pending.jpg"]]) {
    assert.throws(() => mediaSelectionValue(lifecycle, "images", urls), /已交付/)
  }
  assert.throws(() => mediaSelectionValue(lifecycle, "primary_image", [a, b]), /已交付/)
  const failed = selectedMediaState({ ...lifecycle, media: "failed", media_failure_stage: "upload" }, draft, "images")
  assert.equal(failed.tone, "bad", "manual fields never replace a failure with a ready verdict")
})

test("real compiled WASM freezes manual image order and primary choice without changing its input verdict", async () => {
  const core = await wasmCore()
  const handle = core.loadSchema({ snapshot: goldenSchema })
  const row = structuredClone(golden.row)
  row.draft.values.images = mediaSelectionValue(lifecycle, "images", [b, a])
  row.draft.values.primary_image = mediaSelectionValue(lifecycle, "primary_image", [a])
  row.handEditedKeys = ["images", "primary_image"]
  const before = JSON.stringify(row)
  const output = core.freezeListing(handle, { rowId: golden.rowId, row, card: golden.card })
  assert.equal(output.status, "frozen")
  if (output.status !== "frozen") return
  const item = (output.import.items as Record<string, unknown>[])[0]!
  assert.deepEqual(item.images, [b, a])
  assert.equal(item.primary_image, a)
  assert.equal(item.color_image, selectedMediaState(lifecycle, row.draft, "color_image").urls[0], "the read-only swatch cell mirrors the core's selected-images fallback")
  assert.equal(JSON.stringify(row), before, "freezing does not mark a row ready or persist anything")
  core.dropSchema(handle)
})

test("an open picker's action refuses changed publish facts and cannot remove the explicit primary", () => {
  const row = fixtureRow(1)
  const product = { ...instance(row), lifecycle, draft: { values: { images: mediaSelectionValue(lifecycle, "images", [a, b]), primary_image: mediaSelectionValue(lifecycle, "primary_image", [a]) }, complex_values: [] } }
  const value = mediaSelectionValue(lifecycle, "images", [b, a])
  assert.deepEqual(validateMediaSelection(row, product, "images", value), value)
  for (const stage of ["queued", "submitting", "accepted", "outcome_unknown", "operator_attested"] as const) {
    assert.throws(() => validateMediaSelection({ ...row, stage }, product, "images", value), /不能修改/)
    assert.throws(() => validateMediaSelection(row, { ...product, lifecycle: { ...lifecycle, stage } }, "images", value), /不能修改/)
  }
  assert.throws(() => validateMediaSelection({ ...row, publishUnconfirmed: true }, product, "images", value), /不能修改/)
  for (const media of ["rendering", "uploading", "failed"] as const) assert.throws(() => validateMediaSelection(row, { ...product, lifecycle: { ...lifecycle, media } }, "images", value), /不能修改/)
  assert.throws(() => validateMediaSelection(row, product, "images", mediaSelectionValue(lifecycle, "images", [b])), /选择其他主图/)
  assert.throws(() => validateMediaSelection(row, { ...product, draft: { values: { images: mediaSelectionValue(lifecycle, "images", [a]) }, complex_values: [] } }, "primary_image", mediaSelectionValue(lifecycle, "primary_image", [b])), /选用的商品图/)
})

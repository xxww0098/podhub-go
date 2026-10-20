import assert from "node:assert/strict"
import test from "node:test"
import { createWorkflowPublishNative } from "./workflow-publish-native"
import { publishRepairFixture } from "./product-instances-test-fixtures"
import { serve } from "./submit/send-test-support"
import { nativeRow } from "./submit/send-local"
import { cardPayload } from "@/bindings/listing-projection"
import type { WorkflowVideoMetadata } from "@/listing-core/types"
import { getDiagnosticDetail, setErrorTelemetryContext } from "@/lib/error-telemetry"
import { currentWorkbenchDiagnostic } from "./workbench/publish-diagnostic-producer"
import { peekListingWorkbench } from "./workbench/listing-workbench-store"

test("production native repair invokes op2 and op7 and preserves media with Manual provenance", async () => {
  const fx = await publishRepairFixture()
  const cloud = serve(() => { throw new Error("native repair is local") })
  try {
    const result = await createWorkflowPublishNative(() => fx.core).clearSearchTags(fx.raw, fx.card, () => true)
    assert.deepEqual(fx.calls, ["op2", "op7", "schema-drop"])
    assert.equal(result.fact, "Passed")
    assert.equal(result.row.draft.values.native_search_tags, undefined)
    assert.ok(result.row.draft.cleared?.includes("native_search_tags"))
    assert.ok(result.row.handEditedKeys.includes("native_search_tags"))
    assert.match(JSON.stringify(result.row.fieldOrigins), /manual/i)
    assert.deepEqual(result.row.media, fx.raw.media)
    assert.deepEqual(result.row.ai, fx.raw.ai)
    assert.equal(cloud.calls.length, 0)
  } finally { cloud.restore(); fx.restore() }
})

for (const origin of ["managed_upload", "public_url"] as const) {
  test(`compiled native repair and revalidation preserve persisted ${origin} video and cover without HTTP`, async () => {
    const fx = await publishRepairFixture()
    const cloud = serve(() => { throw new Error("native media validation is local") })
    try {
      const parsed = nativeRow(fx.raw)
      assert.ok("row" in parsed)
      const video: WorkflowVideoMetadata = {
        role: "product", origin, file_name: "product.mp4", content_type: "video/mp4",
        size_bytes: 2048, duration_ms: 1500, public_url: "https://media.example.test/product.mp4",
        object_key: origin === "managed_upload" ? "media/product.mp4" : "",
        content_hash: "sha256:product-video",
      }
      const videoCover: WorkflowVideoMetadata = {
        ...video, role: "cover", file_name: "cover.png", content_type: "image/png",
        size_bytes: 128, duration_ms: 0, public_url: "https://media.example.test/cover.png",
        object_key: origin === "managed_upload" ? "media/cover.png" : "",
        content_hash: "sha256:video-cover",
      }
      const payload = structuredClone(parsed.row)
      payload.media = { ...payload.media, videos: [video], videoCover }
      const raw = { ...fx.raw, payload, media: payload.media }
      const card = { ...fx.card, payload: { ...cardPayload(fx.card), videos: [video], videoCover } }
      const original = structuredClone({ payload, card: card.payload })
      const native = createWorkflowPublishNative(() => fx.core)

      const repaired = await native.clearSearchTags(raw, card, () => true)
      assert.deepEqual(fx.calls, ["op2", "op7", "schema-drop"])
      const edited = fx.lastEdit()
      assert.ok(edited)
      for (const result of [edited, repaired]) {
        assert.equal(result.fact, "Passed")
        assert.deepEqual(result.row.media, original.payload.media)
        assert.deepEqual(result.row.ai, original.payload.ai)
        assert.deepEqual(result.row.source, original.payload.source)
        assert.equal(result.row.draft.values.native_search_tags, undefined)
        assert.ok(result.row.draft.cleared?.includes("native_search_tags"))
        assert.ok(result.row.handEditedKeys.includes("native_search_tags"))
        assert.match(JSON.stringify(result.row.fieldOrigins), /manual/i)
        for (const [key, value] of Object.entries(original.payload.draft.values)) {
          if (key !== "native_search_tags") assert.deepEqual(result.row.draft.values[key], value)
        }
      }
      assert.deepEqual(repaired.row.fieldOrigins, edited.row.fieldOrigins)

      const validated = await native.revalidate({ ...raw, payload: repaired.row,
        media: repaired.row.media }, card, () => true)
      assert.deepEqual(fx.calls, ["op2", "op7", "schema-drop", "op7", "schema-drop"])
      assert.equal(validated.fact, "Passed")
      assert.deepEqual(validated.row.media, original.payload.media)
      assert.deepEqual(validated.row.fieldOrigins, repaired.row.fieldOrigins)
      assert.deepEqual(validated.row.handEditedKeys, repaired.row.handEditedKeys)
      assert.deepEqual({ payload, card: card.payload }, original, "native calls leave their input snapshots intact")
      assert.equal(cloud.calls.length, 0)
    } finally { cloud.restore(); fx.restore() }
  })
}

test("native repair stops between edit and validation when its action fence changes", async () => {
  const fx = await publishRepairFixture()
  let current = true
  fx.afterEdit(() => { current = false })
  try {
    await assert.rejects(createWorkflowPublishNative(() => fx.core).clearSearchTags(fx.raw, fx.card, () => current), /已变化/)
    assert.deepEqual(fx.calls, ["op2", "schema-drop"])
  } finally { fx.restore() }
})

test("a native trap retires the instance without a drop or automatic retry", async () => {
  const fx = await publishRepairFixture()
  const edit = fx.core.editRow
  fx.core.editRow = async () => { fx.calls.push("trap"); throw new WebAssembly.RuntimeError("test trap") }
  let factories = 0
  const restart = fx.core.restart.bind(fx.core)
  fx.core.restart = async () => { fx.calls.push("restart"); await restart() }
  const native = createWorkflowPublishNative(() => { factories++; return fx.core })
  setErrorTelemetryContext({ sessionKey: "native-trap-production-boundary" })
  try {
    await assert.rejects(native.clearSearchTags(fx.raw, fx.card, () => true), WebAssembly.RuntimeError)
    assert.deepEqual(fx.calls, ["trap"])
    assert.equal(factories, 1)
    const reference = currentWorkbenchDiagnostic(peekListingWorkbench().rows[0]!)
    assert.ok(reference?.diagnosticId)
    const detail = getDiagnosticDetail(reference.diagnosticId)
    assert.equal(detail.event?.code, "wasm_exception")
    assert.equal(detail.event?.stage, "repair")
    assert.equal(detail.event?.payload_sha256, null, "op2 arguments are not an exact native freeze result")
    assert.deepEqual(detail.event?.summary, [])
    assert.equal(detail.originalUnavailableReason, "no_exact_payload")
    fx.core.editRow = edit
    await native.clearSearchTags(fx.raw, fx.card, () => true)
    assert.equal(factories, 1, "the next action reinstantiates the cached module without fetching")
    assert.deepEqual(fx.calls, ["trap", "restart", "op2", "op7", "schema-drop"])
  } finally { setErrorTelemetryContext({ sessionKey: null }); fx.restore() }
})

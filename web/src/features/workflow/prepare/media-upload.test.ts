/**
 * The media.render / media.upload rail: OPFS render, the static-slice cache and public confirmation.
 *
 * The renderer and OPFS are stubbed (executor-test-support): what these tests
 * are for is the wire — the route a verb takes, the pin it writes under, and
 * the shape Cloud will refuse if it drifts.
 */
import assert from "node:assert/strict"
import test, { beforeEach } from "node:test"

import { route } from "@/api/routes"

import { invalidateAccountOverview, rememberAccountOverview } from "@/features/account/account-overview-cache"
import { lookupMediaObject, forgetMediaObjects } from "../media/media-objects"
import { interceptMediaCompletion, json as mediaJson } from "../media/direct-media-test-fixtures"
import { requestStop, setCardContext } from "./execution-context"
import { RENDERER_CONTRACT_VERSION } from "./media-job"
import { advanceBusyClock, busy, FIXED_TAGS, record, ROW, SLICE_DIGEST, slicePrepareReply, withStubbedDevice } from "./executor-test-support"

// Native batch fixtures can share the same millisecond across independent tests.
beforeEach(forgetMediaObjects)

test("upload delivers committed slices without rendering again", async () => {
  setCardContext({ psdTemplateSha256: "template-sha" })
  const sliced = {
    ...ROW,
    revision: 10,
    media_state: "processing",
    media: {
      images: [{
        index: 0,
        file_name: "slice-1.jpg",
        content_hash: `sha256:${SLICE_DIGEST}`,
        group_name: "主图",
        width: 900,
        height: 1200,
        byte_size: 1,
        phase: "rendered",
      }],
      videos: [],
    },
    render_evidence: {
      source_sha256: "source-sha",
      template_sha256: "pinned-template-sha",
      renderer_contract_version: RENDERER_CONTRACT_VERSION,
      manifest_digest: "manifest:v1:row-1:sha256:abc",
      slice_count: 1,
      degradations: [],
    },
  }
  const stub = record((call) => {
    if (call.url.endsWith("/prepare")) {
      return { outcome: "running", jobs: [{ id: "job-upload", kind: "media.upload", aggregate_id: "row-1", aggregate_type: "listing_row", input_revision: 10, state: "queued", attempt: 0, payload: { manifest_digest: sliced.render_evidence.manifest_digest, manifest: { images: sliced.media.images }, recognition_prompt: { prompt_id: "prompt-1", fixed_tags: FIXED_TAGS, content: "识图提示词", sha256: "prompt-sha" }, executor: "browser", pinned_revision: 10, psd_template_sha256: "pinned-template-sha" }, updated_at_ms: 0 }] }
    }
    if (call.method === "PUT") return new Response(null, { status: 204 })
    if (call.url.endsWith("/media")) return { applied: true, jobs: [], row: sliced }
    return sliced
  })
  const lines: string[] = []
  const originalLog = console.log
  console.log = (...args: unknown[]) => { lines.push(args.map(String).join(" ")) }
  try {
    const { runRows } = await import("./run-rows")
    await withStubbedDevice(() =>
      runRows({ row_ids: ["row-1"], expected_revisions: [{ row_id: "row-1", revision: 9 }] }, "upload"),
    )
    assert.deepEqual(
      stub.calls.map((call) => call.method === "PUT" ? "PUT [anonymous object storage]" : `${call.method} ${call.url}`),
      [
        "POST /api/listing/rows/row-1/prepare",
        "GET /api/listing/rows/row-1",
        "POST /api/media/upload-batches",
        // Bytes go only to anonymous storage; Cloud confirms the actual object.
        "POST /api/media/objects/presign-batch",
        "PUT [anonymous object storage]",
        "POST /api/media/objects/complete-batch",
        "POST /api/listing/rows/row-1/media/images",
      ],
    )
    const put = stub.calls.find((call) => call.method === "PUT")!
    assert.equal(put.headers["x-amz-checksum-sha256"], `${"a".repeat(43)}=`)
    assert.equal(put.headers["X-Listing-Job-Id"], undefined)
    assert.equal(put.headers["X-Listing-Lease-Owner"], undefined)
    assert.equal(put.headers["X-Listing-Lease-Epoch"], undefined)
    const writeback = stub.calls.find((call) => call.url.endsWith("/media/images"))!.body
    assert.equal(writeback.job_id, "job-upload")
    const confirmation = stub.calls.find((call) => call.url.endsWith("/complete-batch"))!.body.objects[0]
    assert.equal(writeback.images[0].object_key, confirmation.object_key, "Listing uses only the confirmed grant target")
    assert.equal(writeback.images[0].account_id, "acct")
    assert.equal(writeback.images[0].public_url, undefined, "Cloud supplies its own confirmed URL")
    const upload = lines.filter((line) => line.startsWith("[prepare] upload "))
    assert.equal(upload.length, 1)
    assert.match(upload[0]!, /manifestBytes=1 putBytes=1 /)
    assert.match(upload[0]!, /via=put:1 checksum=trusted:1$/)
    assert.equal(lines.some((line) => line.includes("upload.confirm")), false)
    assert.equal(lines.filter((line) => line.startsWith("[prepare] upload.batch ")).length, 1)
    assert.equal(lines.filter((line) => line.includes("已确认上传")).length, 1)
  } finally {
    console.log = originalLog
    stub.restore()
  }
})

test("refresh after four of six uploads keeps receipts and reads only the missing slices", async () => {
  setCardContext({ psdTemplateSha256: "template-sha" })
  const { sha256Hex } = await import("@/render/opfs")
  const bytes = Array.from({ length: 6 }, (_, index) => new Uint8Array([index + 20]))
  const hashes = await Promise.all(bytes.map(sha256Hex))
  const images = hashes.map((hash, index) => ({ index, file_name: `slice-${index}.jpg`, content_hash: `sha256:${hash}`,
    group_name: "main", width: 1, height: 1, byte_size: 1, phase: "rendered" }))
  const sliced = { ...ROW, revision: 10, media_state: "rendered", media: { images, videos: [] },
    render_evidence: { manifest_digest: "manifest:six", manifest: { images } } }
  let attempt = 0
  const read: string[] = []
  const stub = record((call) => {
    if (call.url.endsWith("/prepare")) return { outcome: "running", jobs: [{ id: `upload-${++attempt}`, kind: "media.upload",
      aggregate_id: ROW.id, aggregate_type: "listing_row", input_revision: 10, state: "queued", attempt: 0,
      payload: { executor: "browser", manifest_digest: "manifest:six", manifest: { images } }, updated_at_ms: 0 }] }
    if (call.method === "PUT") {
      const digest = new URL(call.url).pathname.split("/").at(-1)!.split(".")[0]!
      return { byteLength: 1, deduplicated: false, publicUrl: `https://cdn.invalid/${digest}.jpg`, objectKey: `${digest}.jpg`, accountId: "acct" }
    }
    if (call.url.endsWith("/media/images")) {
      return { items: (call.body.images ?? []).map((image: { index: number }) => ({
        index: image.index, applied: true, completed: image.index + 1, media_state: "ready",
      })) }
    }
    if (call.url.endsWith("/media")) return { applied: true, row: sliced, jobs: [] }
    return sliced
  })
  try {
    const { runRows } = await import("./run-rows")
    const execute = () => withStubbedDevice(() => runRows({ row_ids: [ROW.id], expected_revisions: [] }, "upload"), {
      getRender: async (_row: string, file: string) => {
        read.push(file)
        const index = images.findIndex((image) => image.file_name === file)
        // First run loses the last two local slices. After refresh, only those
        // two are restored; the first four no longer have any local bytes.
        return (attempt === 1 ? index < 4 : index >= 4) ? bytes[index] : null
      },
      getSource: async () => { throw new Error("upload must not reopen source") },
    }, { renderProduct: async () => { throw new Error("upload must not rerender") } })
    // The stage retry is the refresh: attempt 1 confirms the four delivered
    // slices and loses the last two locally; the replanned Job keeps those
    // receipts and its next attempt reads only the missing pair.
    const [result] = await execute()
    assert.equal(result?.error, undefined)
    assert.deepEqual(images.map((image) => read.filter((file) => file === image.file_name).length), [1, 1, 1, 1, 2, 2])
    assert.equal(stub.calls.filter((call) => call.method === "PUT").length, 6, "no successful object was uploaded twice")
    assert.equal(stub.calls.filter((call) => call.url.endsWith("/media/images")).map(call => call.body.images.length).join(","), "4,2", "four kept receipts plus the two retried slices use two batches")
  } finally { stub.restore() }
})

test("an upload with all images already public reconfirms and finishes without local bytes", async () => {
  const workspace = { id: 7, uuid: "reconfirm-workspace", name: "Test", plan: "pro", role: "owner", is_owned: true }
  forgetMediaObjects()
  rememberAccountOverview({
    session: { authenticated: true, email: "test@example.invalid", role: "user" },
    entitlement: { plan: "pro", features: { ai_relay: true, ocr: true, batch_listing: true, field_package: true },
      limits: { stores: 1, stores_used: 0, seats: 1, seats_used: 1, s3_upload_bytes_monthly: 0,
        s3_upload_bytes_used: 0, ai_tokens_monthly: 0, ai_tokens_used: 0, ai_calls_per_day: 0 } },
    active_workspace: workspace, workspaces: [workspace], account_mode: "owner", owned_count: 1, owned_limit: 3,
  })
  const oldKey = `images/teams/${workspace.uuid}/old/sha256/${SLICE_DIGEST}.jpg`
  const newKey = `uploads/2026-09-16/1700000000000-reconfirm/images/teams/${workspace.uuid}/sha256/${SLICE_DIGEST}.jpg`
  const image = { index: 0, file_name: "gone.jpg", content_hash: `sha256:${SLICE_DIGEST}`, group_name: "main",
    width: 1, height: 1, byte_size: 1, phase: "public_ready", object_key: oldKey, account_id: "old", public_url: "https://cdn.invalid/old.jpg" }
  const row = { ...ROW, media_state: "uploading", media: { images: [image], videos: [] }, render_evidence: { manifest_digest: "existing" } }
  let confirmations = 0
  const stub = record((call) => {
    if (call.url.endsWith("/prepare")) return { outcome: "running", jobs: [{ id: "reconfirm",kind:"media.upload",payload:{manifest_digest:"existing",manifest:{images:[image]}} }] }
    if (call.url.endsWith("/media/images")) return new Response(JSON.stringify({code:"media_confirmation_required",error:"proof expired"}),{status:400})
    if (call.url.includes("/media/images/") && ++confirmations === 1) return new Response(JSON.stringify({code:"media_confirmation_required",error:"proof expired"}),{status:400})
    if (call.url.endsWith("/probe")) return {exists:true,object_key:newKey,account_id:"current",public_url:"https://cdn.invalid/new.jpg"}
    if (call.url.endsWith("/presign-batch")) return new Error("remote object requires no upload")
    if (call.method === "PUT") throw new Error("remote object requires no bytes")
    return row
  })
  try {
    const { runRows } = await import("./run-rows")
    const result = await withStubbedDevice(() => runRows({row_ids:[ROW.id],expected_revisions:[]},"upload"), {
      getRender: async () => { throw new Error("local cache was cleared") },
    })
    assert.equal(result[0]!.error,undefined)
    assert.equal(confirmations,2)
    assert.equal(stub.calls.filter((call)=>call.url.endsWith("/probe")).length,1)
    assert.equal(stub.calls.at(-1)!.body.object_key,newKey)
    // Recovery landed under the freshly issued timestamp batch; without that
    // scope it must never leak into the legacy cross-run cache.
    assert.equal(lookupMediaObject(SLICE_DIGEST, "jpg"), undefined)
  } finally { stub.restore(); forgetMediaObjects(); invalidateAccountOverview() }
})

test("upload prefers a final row on equal revisions, but still reads back missing or newer receipts", async () => {
  const { runRows } = await import("./run-rows")
  for (const mode of ["same-revision", "no-final-row", "newer-partial", "wrong-index"] as const) {
    const images = [0, 1].map(index => ({ index, file_name: `slice-${index}.jpg`, content_hash: `sha256:${SLICE_DIGEST}`,
      group_name: "main", width: 1, height: 1, byte_size: 1, phase: "public_ready",
      object_key: `existing-${index}.jpg`, account_id: "acct", public_url: `https://cdn.invalid/${index}.jpg` }))
    const sliced = { ...ROW, view_revision: 10, media_state: "uploading", media: { images, videos: [] },
      render_evidence: { manifest_digest: "manifest:receipts" } }
    const finalRow = { ...sliced, media_state: "ready", projection: { ...ROW.projection, media: "ready" } }
    let confirmations = 0
    const stub = record(async call => {
      if (call.url.endsWith("/prepare")) return { outcome: "running", jobs: [{ id: `upload-${mode}`, kind: "media.upload",
        payload: { manifest_digest: "manifest:receipts", manifest: { images } } }] }
      if (call.url.endsWith("/media/images")) {
        confirmations++
        return new Response(JSON.stringify({ data: { items: call.body.images.map(({ index }: { index: number }) => ({
          applied: true, index: mode === "wrong-index" ? index + 10 : index, phase: "public_ready", media_state: "ready", total: 2,
          ...(index === 1 && mode !== "no-final-row" ? { row: finalRow } : {}),
          // A newer partial receipt still outranks the older final row.
          ...(index === 0 && mode === "newer-partial" ? { row: { ...sliced, view_revision: 11 } } : {}),
        })), total: call.body.images.length } }), { status: 200 })
      }
      if (call.method === "POST" && call.url.endsWith("/media")) {
        assert.equal(call.body.media_state, "failed")
        return { applied: true, row: sliced, jobs: [] }
      }
      return confirmations ? { ...finalRow, view_revision: 12 } : sliced
    })
    try {
      const [result] = await withStubbedDevice(() => runRows({ row_ids: [ROW.id], expected_revisions: [] }, "upload"), {
        getRender: async () => { throw new Error("public receipts do not need local bytes") },
      })
      if (mode === "wrong-index") {
        assert.equal(result?.error?.code, "workflow_media_confirmation_mismatch")
        continue
      }
      assert.equal(result?.error, undefined, mode)
      // `same-revision` settles on the receipt's own row; `newer-partial` carries
      // its newer partial row projection on the receipt; the rest re-read the row.
      assert.equal(stub.calls.filter(call => call.method === "GET" && call.url.endsWith(`/rows/${ROW.id}`)).length,
        mode === "same-revision" || mode === "newer-partial" ? 1 : 2, mode)
      assert.equal(result?.product?.lifecycle.view_revision, mode === "same-revision" ? 10 : mode === "newer-partial" ? 11 : 12, mode)
    } finally { stub.restore() }
  }
})

test("stopping after delivery does not issue a new confirmation batch", async () => {
  const image = { index: 0, file_name: "stop.jpg", content_hash: `sha256:${SLICE_DIGEST}`,
    group_name: "main", width: 1, height: 1, byte_size: 1, phase: "rendered" }
  const sliced = { ...ROW, media_state: "uploading", media: { images: [image], videos: [] },
    render_evidence: { manifest_digest: "manifest:stop" } }
  const stub = record(call => {
    if (call.url.endsWith("/prepare")) return { outcome: "running", jobs: [{ id: "upload-stop", kind: "media.upload",
      payload: { manifest_digest: "manifest:stop", manifest: { images: [image] } } }] }
    if (call.method === "PUT") {
      requestStop([ROW.id])
      return { byteLength: 1, deduplicated: false, publicUrl: "https://cdn.invalid/stop.jpg", objectKey: "stop.jpg", accountId: "acct" }
    }
    return sliced
  })
  try {
    const { runRows } = await import("./run-rows")
    await withStubbedDevice(() => runRows({ row_ids: [ROW.id], expected_revisions: [] }, "upload"))
    assert.equal(stub.calls.filter(call => call.method === "PUT").length, 1)
    assert.equal(stub.calls.some(call => call.url.includes("/media/images")), false)
  } finally { stub.restore() }
})

test("a shed storage PUT confirms absence before Retry-After and one grant renewal", async () => {
  setCardContext({ psdTemplateSha256: "template-sha" })
  let puts = 0
  let manifest: unknown
  const stub = record((call) => {
    if (call.url.endsWith("/prepare")) {
      if (call.body?.operation === "prepare") {
        return { outcome: "running", jobs: [
          { id: "job-ai", kind: "ai.recognize", payload: { source_sha256: "source-sha", recognition_prompt: { fixed_tags: FIXED_TAGS, content: "prompt" } } },
          { id: "job-render", kind: "media.render", payload: { psd_template_sha256: "pinned-template-sha" } },
        ] }
      }
      if (call.body?.operation === "slice") {
        return { outcome: "running", jobs: [{ id: "job-render", kind: "media.render", aggregate_id: "row-1", aggregate_type: "listing_row", input_revision: 10, state: "queued", attempt: 0, payload: { executor: "browser", pinned_revision: 10, psd_template_sha256: "pinned-template-sha" }, updated_at_ms: 0 }] }
      }
      if (call.body?.operation === "upload") {
        return { outcome: "running", jobs: [{ id: "job-upload", kind: "media.upload", aggregate_id: "row-1", aggregate_type: "listing_row", input_revision: 10, state: "queued", attempt: 0, payload: { executor: "browser", manifest_digest: "manifest:test:job-render", manifest }, updated_at_ms: 0 }] }
      }
      return { outcome: "prepared", jobs: [] }
    }
    if (call.method === "PUT") {
      puts += 1
      if (puts === 1) return busy(503, "服务繁忙，请稍后重试")
      return { byteLength: 1, deduplicated: true, publicUrl: "https://cdn.example.invalid/slice-1.jpg", objectKey: "o/slice-1.jpg", accountId: "acct" }
    }
    if (call.url.endsWith("/media")) {
      if (call.body?.media_state === "rendered") {
        manifest = { renderer: call.body.payload.render_evidence.manifest, images: call.body.payload.media.images }
      }
      return { applied: true, jobs: [], row: ROW }
    }
    return { ...ROW, revision: 10, media_state: "processing" }
  })
  interceptMediaCompletion(() => puts === 1 ? mediaJson({}, 404) : undefined)
  try {
    const { runRows } = await import("./run-rows")
    const [result] = await withStubbedDevice(() =>
      runRows({ row_ids: ["row-1"], expected_revisions: [{ row_id: "row-1", revision: 9 }] }, "prepare"),
    )
    assert.equal(result!.error, undefined)
    const writeback = stub.calls.find((call) => call.url.endsWith("/media"))!.body
    assert.equal(writeback.media_state, "rendered", "render was persisted before upload")
    assert.equal(stub.calls.some((call) => call.url.endsWith("/media") && call.body.media_state === "failed"), false)
    assert.equal(puts, 2)
  } finally {
    stub.restore()
  }
})

test("a static slice shared by every row travels once per session, and never probes", async () => {
  const { rememberAccountOverview, invalidateAccountOverview } = await import("@/features/account/account-overview-cache")
  const { forgetMediaObjects } = await import("../media/media-objects")
  const WORKSPACE = "550e8400-e29b-41d4-a716-446655440000"
  const workspace = { id: 7, uuid: WORKSPACE, name: "运营", plan: "pro", role: "owner", is_owned: true }
  forgetMediaObjects()
  rememberAccountOverview({
    session: { authenticated: true, email: "op@example.invalid", role: "user" },
    entitlement: {
      plan: "pro",
      features: { ai_relay: true, ocr: true, batch_listing: true, field_package: true },
      limits: { stores: 1, stores_used: 0, seats: 1, seats_used: 1, s3_upload_bytes_monthly: 0, s3_upload_bytes_used: 0, ai_tokens_monthly: 0, ai_tokens_used: 0, ai_calls_per_day: 0 },
    },
    active_workspace: workspace,
    workspaces: [workspace],
    account_mode: "owner",
    owned_count: 1,
    owned_limit: 3,
  })
  setCardContext({ psdTemplateSha256: "template-sha" })
  const manifests = new Map<string, unknown>()
  const stub = record((call) => {
    const rowId = call.url.split(route("listingRowsById", { id: "placeholder" }).replace("placeholder", ""))[1]?.split("/")[0]
    if (call.url.endsWith("/prepare")) {
      if (call.body?.operation === "prepare") {
        return { outcome: "running", jobs: [{ id: `job-${rowId}`, kind: "media.render", aggregate_id: rowId, aggregate_type: "listing_row", input_revision: 10, state: "queued", attempt: 0, payload: { executor: "browser", pinned_revision: 10, psd_template_sha256: "pinned-template-sha" }, updated_at_ms: 0 }] }
      }
      if (call.body?.operation === "slice") {
        return { outcome: "running", jobs: [{ id: `job-${rowId}`, kind: "media.render", aggregate_id: rowId, aggregate_type: "listing_row", input_revision: 10, state: "queued", attempt: 0, payload: { recognition_prompt: { prompt_id: "prompt-1", fixed_tags: FIXED_TAGS, content: "识图提示词", sha256: "prompt-sha" }, executor: "browser", pinned_revision: 10, psd_template_sha256: "pinned-template-sha" }, updated_at_ms: 0 }] }
      }
      if (call.body?.operation === "upload") {
        return { outcome: "running", jobs: [{ id: `job-${rowId}-upload`, kind: "media.upload", aggregate_id: rowId, aggregate_type: "listing_row", input_revision: 10, state: "queued", attempt: 0, payload: { executor: "browser", manifest_digest: `manifest:test:job-${rowId}`, manifest: manifests.get(rowId) }, updated_at_ms: 0 }] }
      }
      return { outcome: "prepared", jobs: [] }
    }
    if (call.method === "PUT") {
      return { byteLength: 1, deduplicated: false, publicUrl: `https://media.example.com/images/teams/${WORKSPACE}/sha256/${SLICE_DIGEST}.jpg`, objectKey: `images/teams/${WORKSPACE}/sha256/${SLICE_DIGEST}.jpg`, accountId: "env-media" }
    }
    if (call.url.endsWith("/media")) {
      if (call.body?.media_state === "rendered" && rowId) {
        manifests.set(rowId, { renderer: call.body.payload.render_evidence.manifest, images: call.body.payload.media.images })
      }
      return { applied: true, jobs: [], row: ROW }
    }
    return { ...ROW, id: rowId, revision: 10, media_state: "processing" }
  })
  try {
    const { runRows } = await import("./run-rows")
    const results = await withStubbedDevice(() =>
      runRows({ row_ids: ["row-1", "row-2", "row-3"], expected_revisions: [] }, "prepare"),
    )
    assert.ok(results.every((result) => result.error === undefined))
    // Every row renders the same slice (the stubbed renderer's static output):
    // three rows, one PUT, no probe, three `public_ready` writebacks with Cloud's URL.
    assert.equal(stub.calls.filter((call) => call.method === "PUT").length, 1)
    assert.equal(stub.calls.filter((call) => call.url.endsWith("/probe")).length, 0)
    const writebacks = stub.calls.filter((call) => call.url.endsWith("/media/images"))
    assert.equal(writebacks.length, 3)
    assert.ok(writebacks.every((call) => call.body.images[0].object_key.endsWith(`/${SLICE_DIGEST}.jpg`)))
  } finally {
    stub.restore()
    forgetMediaObjects()
    invalidateAccountOverview()
  }
})

test("browser media outlives the old lease without claims or heartbeats and shares one upload authorization", async (t) => {
  setCardContext({ psdTemplateSha256: "template-sha" })
  t.mock.timers.enable({ apis: ["setInterval"] })
  let now = Date.now()
  t.mock.method(Date, "now", () => now)
  const advancePastLease = () => {
    now += 120_000
    t.mock.timers.tick(120_000)
  }
  const ids = ["local-media-1", "local-media-2"]
  const stub = record(call => {
    const id = call.url.match(/rows\/([^/]+)/)?.[1] ?? ids[0]!
    if (call.url.endsWith("/prepare")) return slicePrepareReply(id)
    if (call.url.endsWith("/media")) return { applied: true, row: { ...ROW, id }, jobs: [] }
    if (call.method === "PUT") {
      advancePastLease()
      return { byteLength: 1, publicUrl: "https://cdn.invalid/local.jpg", objectKey: "local.jpg", accountId: "acct" }
    }
    return { ...ROW, id }
  })
  try {
    const { runRows } = await import("./run-rows")
    const results = await withStubbedDevice(() => runRows({ row_ids: ids, expected_revisions: [] }, "prepare"), {}, {
      renderProduct: async () => {
        advancePastLease()
        return { manifest: {}, slices: [{ index: 0, groupName: "main", fileName: "image.jpg", width: 1, height: 1,
          contentHash: `sha256:${SLICE_DIGEST}`, bytes: new Uint8Array([1]) }] }
      },
    })
    assert.equal(results.length, ids.length)
    assert.ok(results.every(row => !row.error))
    assert.equal(stub.calls.some(call => /\/(?:claim|claim-window|heartbeat)$/.test(call.url)), false)
    assert.equal(stub.calls.filter(call => call.url.endsWith("/media/upload-batches")).length, 1)
    assert.equal(stub.calls.filter(call => call.url.endsWith("/media/images")).length, ids.length)
    for (const call of stub.calls) {
      assert.equal(call.headers["X-Listing-Lease-Owner"], undefined)
      assert.equal(call.headers["X-Listing-Lease-Epoch"], undefined)
    }
  } finally {
    stub.restore()
    t.mock.restoreAll()
    t.mock.timers.reset()
    setCardContext({ psdTemplateSha256: "" })
  }
})

test("upload cooldown stops after the first wave and preserves its successful receipts", async (context) => {
  const { sha256Hex } = await import("@/render/opfs")
  const bytes = Array.from({ length: 20 }, (_, i) => new Uint8Array([90 + i]))
  const hashes = await Promise.all(bytes.map(sha256Hex))
  const images = hashes.map((hash, index) => ({ index, file_name: `cool-${index}.jpg`, content_hash: `sha256:${hash}`, group_name: "main", width: 1, height: 1, byte_size: 1, phase: "rendered" }))
  const row = { ...ROW, media_state: "rendered", media: { images, videos: [] }, render_evidence: { manifest_digest: "cool", manifest: { images } } }
  const reads: string[] = []
  const puts: string[] = []
  const refused = new Set<string>()
  let waited = false
  const stub = record(call => {
    if (call.url.endsWith("/prepare")) return { outcome: "running", jobs: [{ id: "cool-job", kind: "media.upload", payload: { manifest_digest: "cool", manifest: { images } } }] }
    if (call.method === "PUT") {
      const digest = new URL(call.url).pathname.split("/").at(-1)!.split(".")[0]!
      puts.push(digest)
      if ((digest === hashes[0] || digest === hashes[1]) && !refused.has(digest)) {
        refused.add(digest)
        return new Response(JSON.stringify({ code: "busy", error: "full" }), { status: 429, headers: { "Retry-After": "30" } })
      }
      return { byteLength: 1, publicUrl: `https://cdn.invalid/${digest}.jpg`, objectKey: `${digest}.jpg`, accountId: "acct" }
    }
    return row
  })
  interceptMediaCompletion((_body, url) => {
    const digest = url.split("/").at(-3)!
    return refused.has(digest) && puts.filter(hash => hash === digest).length === 1 ? mediaJson({}, 404) : undefined
  })
  try {
    const { runRows } = await import("./run-rows")
    const { SLICE_PUT_CONCURRENCY } = await import("./slice-batch-upload")
    const [result] = await advanceBusyClock(context, () => withStubbedDevice(() => runRows({ row_ids: [ROW.id], expected_revisions: [] }, "upload", progress => {
      if (progress.interim && !waited && puts.length > 0
        && progress.preparation_progress?.some(stage => stage.stage === "upload" && stage.state === "waiting")) {
        waited = true
        assert.equal(reads.length, Math.min(SLICE_PUT_CONCURRENCY, images.length), "no later slice was read before cooldown")
        assert.equal(puts.length, Math.min(SLICE_PUT_CONCURRENCY, images.length))
      }
    }), { getRender: async (_row: string, file: string) => { reads.push(file); return bytes[images.findIndex(image => image.file_name === file)] } }))
    assert.ok(waited)
    assert.equal(result?.error, undefined)
    assert.equal(puts.length, images.length + 2)
    assert.equal(puts.filter(hash => hash === hashes[2]).length, 1)
    assert.equal(puts.filter(hash => hash === hashes[3]).length, 1)
    assert.deepEqual(stub.calls.filter(call => call.url.endsWith("/media/images")).map(call => call.body.images.length), [20], "the row binds once after the batched confirm")
  } finally { stub.restore() }
})

for (const recovery of ["present", "missing"] as const) test(`later explicit upload reconciles an uncertain old batch: ${recovery}`, async () => {
  const image = { index: 0, file_name: "uncertain.jpg", content_hash: `sha256:${SLICE_DIGEST}`, group_name: "main", width: 1, height: 1, byte_size: 1, phase: "rendered" }
  const row = { ...ROW, media_state: "rendered", media: { images: [image], videos: [] }, render_evidence: { manifest_digest: "uncertain" } }
  let online = false, puts = 0, reads = 0
  let originalBatch: string | undefined, recoveryBoundary = 0, reconciledBeforeCapability = false
  const stub = record(call => {
    if (call.url.endsWith("/prepare")) return { outcome: "running", jobs: [{ id: "uncertain-upload", kind: "media.upload", payload: { manifest_digest: "uncertain", manifest: { images: [image] } } }] }
    if (call.method === "PUT") { puts += 1; if (!online) throw new TypeError("offline"); return {} }
    if (call.url.endsWith("/media")) return { applied: true, row, jobs: [] }
    return row
  })
  interceptMediaCompletion(body => {
    originalBatch ??= String(body.upload_batch)
    if (!online) return mediaJson({}, 502, "media_complete_unavailable")
    if (body.upload_batch === originalBatch) reconciledBeforeCapability = !stub.calls.slice(recoveryBoundary).some(call => /\/presign(-batch)?$/.test(call.url) || call.method === "PUT")
    return recovery === "missing" && body.upload_batch === originalBatch ? mediaJson({}, 404) : undefined
  })
  try {
    const { runRows } = await import("./run-rows")
    const execute = () => withStubbedDevice(() => runRows({ row_ids: [ROW.id], expected_revisions: [] }, "upload"), {
      getRender: async () => { reads += 1; return new Uint8Array([1]) },
      getSource: async () => { throw new Error("upload must not reopen source") },
    }, { renderProduct: async () => { throw new Error("upload must not rerender") } })
    const [failed] = await execute()
    assert.ok(failed?.error)
    assert.equal(puts, 1, "unconfirmed uncertainty cannot renew or trigger stage retries")
    assert.equal(stub.calls.filter(call => call.url.endsWith("/prepare")).length, 1)
    recoveryBoundary = stub.calls.length
    online = true
    const [recovered] = await execute()
    assert.equal(recovered?.error, undefined)
    const later = stub.calls.slice(recoveryBoundary)
    assert.ok(reconciledBeforeCapability, "original signed scope is reconciled before every new capability")
    const laterGrants = later.filter(call => /\/presign(-batch)?$/.test(call.url))
    if (recovery === "missing") assert.notEqual(laterGrants[0]!.body.upload_batch, originalBatch)
    assert.equal(puts, recovery === "present" ? 1 : 2)
    assert.equal(reads, recovery === "present" ? 1 : 2, "confirmed prior objects need no local bytes")
    assert.equal(laterGrants.length, recovery === "present" ? 0 : 1)
  } finally { stub.restore() }
})

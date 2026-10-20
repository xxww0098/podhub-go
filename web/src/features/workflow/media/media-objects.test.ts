import assert from "node:assert/strict"
import test from "node:test"
import { route } from "@/api/routes"
import { invalidateAccountOverview, rememberAccountOverview } from "@/features/account/account-overview-cache"
import { hashUploadBody } from "@/bindings/direct-upload"
import { deliverMediaObject, createMediaUploadBatch, lookupMediaObject } from "./media-objects"
import { fresh, directHarness, image, answer, activeWorkspace, DIGEST, OTHER, WORKSPACE, json } from "./direct-media-test-fixtures"

function phases(calls: Array<{ method: string; url: string }>): string[] {
  return calls.map(call => call.method === "PUT" ? "PUT" : call.url.split("/").at(-1)!)
}
for (const extension of ["jpg", "png", "mp4", "mov"]) {
  test(extension + " uses restricted anonymous PUT then authenticated complete, never relay/probe/HEAD", async () => {
    fresh()
    const h = directHarness()
    try {
      const contentType = { jpg: "image/jpeg", png: "image/png", mp4: "video/mp4", mov: "video/quicktime" }[extension]!
      const value = await deliverMediaObject({ ...image(DIGEST, 2), extension, contentType })
      assert.equal(value.via, "put")
      assert.deepEqual(phases(h.calls), ["presign-batch", "PUT", "complete"])
      const put = h.calls[1]!
      assert.equal(put.headers.get("content-type"), contentType)
      assert.equal(put.headers.get("if-none-match"), "*")
      assert.equal(put.headers.has("x-amz-content-sha256"), false)
      assert.equal(put.headers.has("authorization"), false)
      assert.equal(put.headers.has("x-workspace-uuid"), false)
      const body = JSON.parse(String(h.calls[2]!.body))
      assert.equal(body.upload_ticket, "ticket-1")
      assert.equal(body.byte_length, 2)
      assert.equal(body.workspace_uuid, WORKSPACE)
      assert.equal((await deliverMediaObject({ ...image(DIGEST, 2), extension, contentType })).via, "local")
    } finally { h.restore() }
  })
}

test("ready preserves laziness and cannot send bytes", async () => {
  fresh(); const h = directHarness({ ready: true })
  try {
    const result = await deliverMediaObject({ ...image(DIGEST, 2), bytes: () => { throw new Error("must not read") } })
    assert.equal(result.via, "ready"); assert.deepEqual(phases(h.calls), ["presign-batch"])
  } finally { h.restore() }
})

test("exact typed-array view rather than backing buffer is hashed and PUT", async () => {
  fresh(); const h = directHarness()
  try {
    const view = new Uint8Array([255, 1, 2, 255]).subarray(1, 3)
    await deliverMediaObject({ ...image(DIGEST, 2), bytes: () => view })
    const body = h.calls.find(call => call.method === "PUT")!.body as Uint8Array
    assert.equal(body.byteLength, 2); assert.deepEqual([...body], [1, 2])
  } finally { h.restore() }
})

test("412 is success-to-confirm only, not completion or a relay", async () => {
  fresh(); const h = directHarness({ putStatuses: [412] })
  try { assert.equal((await deliverMediaObject(image(DIGEST, 2))).via, "put"); assert.deepEqual(phases(h.calls), ["presign-batch", "PUT", "complete"]) }
  finally { h.restore() }
})

for (const status of [0, 403, 429, 500]) {
  test("uncertain/expired PUT " + status + " confirms before renewing exactly once only after object-missing", async () => {
    fresh(); const h = directHarness({ putStatuses: [status, 200], completeStatuses: [404, 200] })
    try {
      assert.equal((await deliverMediaObject(image(DIGEST, 2))).via, "put")
      assert.deepEqual(phases(h.calls), ["presign-batch", "PUT", "complete", "presign-batch", "PUT", "complete"])
    } finally { h.restore() }
  })
}

test("unknown network PUT that actually landed confirms without retransmission", async () => {
  fresh(); const h = directHarness({ putStatuses: [0] })
  try { await deliverMediaObject(image(DIGEST, 2)); assert.deepEqual(phases(h.calls), ["presign-batch", "PUT", "complete"]) }
  finally { h.restore() }
})

test("generic404, integrity400 and conflict409 never authorize retransmission", async () => {
  for (const status of [404, 400, 409]) {
    fresh(); const h = directHarness({ completeStatuses: [status], completeCode: "validation" })
    try { await assert.rejects(deliverMediaObject(image(DIGEST, 2))); assert.deepEqual(phases(h.calls), ["presign-batch", "PUT", "complete"]); assert.equal(lookupMediaObject(DIGEST, "jpg"), undefined) }
    finally { h.restore() }
  }
})

test("confirmation retry never reopens PUT or admission; failed confirm is reconciled on next caller retry", async () => {
  fresh(); const h = directHarness({ completeStatuses: [409, 200] })
  try {
    await assert.rejects(deliverMediaObject(image(DIGEST, 2)))
    await deliverMediaObject({ ...image(DIGEST, 2), bytes: () => { throw new Error("no reread") } })
    assert.deepEqual(phases(h.calls), ["presign-batch", "PUT", "complete", "complete"])
  } finally { h.restore() }
})

test("bounded confirmation backpressure retries only control plane", async () => {
  fresh(); const h = directHarness({ completeStatuses: [503, 200] })
  try {
    await deliverMediaObject({ ...image(DIGEST, 2), retry: { baseDelayMs: 0, maxDelayMs: 0, random: () => 0 } })
    assert.deepEqual(phases(h.calls), ["presign-batch", "PUT", "complete", "complete"])
  } finally { h.restore() }
})

test("declared hash mismatch and malformed restricted headers fail closed", async () => {
  fresh(); let h = directHarness()
  try { await assert.rejects(deliverMediaObject({ ...image(DIGEST, 2), digest: "a".repeat(64) }), { code: "media_digest_mismatch" }); assert.equal(h.calls.some(c => c.method === "PUT"), false) }
  finally { h.restore() }
  fresh(); h = directHarness({ grantHeaders: { if_none_match: "bad" } })
  try { await assert.rejects(deliverMediaObject(image(DIGEST, 2)), { code: "media_direct_headers_invalid" }); assert.equal(h.calls.some(c => c.method === "PUT"), false) }
  finally { h.restore() }
})

test("workspace switch during read fences PUT and confirmations", async () => {
  fresh(); const h = directHarness()
  try {
    await assert.rejects(deliverMediaObject({ ...image(DIGEST, 2), bytes: () => {
      invalidateAccountOverview(); rememberAccountOverview(activeWorkspace("other")); return new Uint8Array([1, 2])
    } }), { code: "workflow_workspace_changed" })
    assert.deepEqual(phases(h.calls), ["presign-batch"])
  } finally { h.restore() }
})

test("singleflight settles once and identical objects only reuse inside one4h batch", async () => {
  fresh(); const h = directHarness()
  try {
    const batch = await createMediaUploadBatch(WORKSPACE)
    const request = { ...image(DIGEST, 2), uploadBatch: batch.uploadBatch }
    const [a, b] = await Promise.all([deliverMediaObject(request), deliverMediaObject(request)])
    assert.deepEqual(a, b)
    assert.equal((await deliverMediaObject(request)).via, "local")
    const next = await createMediaUploadBatch(WORKSPACE)
    await deliverMediaObject({ ...request, uploadBatch: next.uploadBatch })
    assert.equal(h.calls.filter(c => c.method === "PUT").length, 2)
    assert.equal(h.calls.filter(c => c.url === route("mediaUploadBatches")).length, 2)
  } finally { h.restore() }
})

test("same digest different directory is not authority for batch-local cache", async () => {
  fresh(); const h = directHarness()
  try {
    const { rememberMediaObject } = await import("./media-objects")
    rememberMediaObject(answer(), DIGEST, "jpg", Date.now(), { workspaceUuid: WORKSPACE, uploadBatch: "bad.batch.sig" })
    await deliverMediaObject({ ...image(DIGEST, 2), uploadBatch: "bad.batch.sig" })
    assert.equal(h.calls.filter(c => c.method === "PUT").length, 1)
  } finally { h.restore() }
})

test("unknown size is read once inside admission before presign", async () => {
  fresh(); const h = directHarness(); let reads = 0
  try { await deliverMediaObject({ ...image(), bytes: () => { reads++; return new Uint8Array([1, 2]) } }); assert.equal(reads, 1) }
  finally { h.restore() }
})

test("unknown size hashes one large buffer once before the first PUT", async () => {
  fresh(); const h = directHarness()
  const bytes = new Uint8Array(1024 * 1024).fill(7)
  const digest = [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))]
    .map((byte) => byte.toString(16).padStart(2, "0")).join("")
  const original = crypto.subtle.digest.bind(crypto.subtle)
  let hashes = 0
  crypto.subtle.digest = (async (algorithm, data) => {
    hashes += 1
    return original(algorithm, data)
  }) as typeof crypto.subtle.digest
  try {
    await deliverMediaObject({ digest, extension: "jpg", contentType: "image/jpeg", bytes: () => bytes })
    assert.equal(hashes, 1)
    assert.equal(h.calls.filter((call) => call.method === "PUT").length, 1)
    const presign = h.calls.find((call) => call.url.endsWith("/presign-batch"))
    assert.equal(JSON.parse(String(presign?.body)).objects[0].byte_length, bytes.byteLength)
  } finally {
    crypto.subtle.digest = original
    h.restore()
  }
})

test("videos use bounded chunk hashing without probe->relay regression", async () => {
  fresh(); const h = directHarness()
  try {
    const bytes = new Uint8Array([3, 4])
    assert.equal(await hashUploadBody(bytes), OTHER)
    await deliverMediaObject({ ...image(OTHER, 2), extension: "mov", contentType: "video/quicktime" })
    assert.deepEqual(phases(h.calls), ["presign-batch", "PUT", "complete"])
  } finally { h.restore() }
})

for (const invalid of [{ transport: "direct" }, { deduplicated: "false" }]) {
  test("completion requires explicit ready proof and a typed receipt outcome " + JSON.stringify(invalid), async () => {
    fresh(); const h = directHarness({ intercept(call) {
      if (!call.url.endsWith("/complete")) return undefined
      const body = JSON.parse(String(call.body))
      const wire = { account_id: answer().accountId, workspace_uuid: answer().workspaceUuid, storage_revision: answer().storageRevision,
        object_key: answer().objectKey, public_url: answer().publicUrl }
      return json({ ...wire, transport: "ready", deduplicated: false, byte_length: body.byte_length, ...invalid })
    } })
    try {
      await assert.rejects(deliverMediaObject(image(DIGEST, 2)), { code: "media_complete_mismatch" })
      assert.equal(lookupMediaObject(DIGEST, "jpg"), undefined)
      assert.deepEqual(phases(h.calls), ["presign-batch", "PUT", "complete"])
    } finally { h.restore() }
  })
}

test("storage Retry-After waits only after authoritative missing and with native permits released", async () => {
  fresh(); let puts = 0, waits = 0
  const { acquireDelivery, MEDIA_UPLOAD_CONCURRENCY } = await import("./direct-media-budget")
  const h = directHarness({ completeStatuses: [404, 200], intercept(call) {
    if (call.method === "PUT" && puts++ === 0) return new Response(null, { status: 429, headers: { "Retry-After": "30" } })
    return undefined
  } })
  try {
    await deliverMediaObject({ ...image(DIGEST, 2), retry: { random: () => 0,
      onWait(wait) { assert.equal(wait.status, 429); assert.equal(wait.delayMs, 30_000) },
      sleep: async () => {
        waits++
        const releases = await Promise.all(Array.from({ length: MEDIA_UPLOAD_CONCURRENCY }, () => acquireDelivery(1)))
        for (const release of releases) release()
        assert.deepEqual(phases(h.calls), ["presign-batch", "PUT", "complete"])
      },
    } })
    assert.equal(waits, 1)
    assert.deepEqual(phases(h.calls), ["presign-batch", "PUT", "complete", "presign-batch", "PUT", "complete"])
  } finally { h.restore() }
})

test("even Ready grants must belong to the requested four-hour image directory", async () => {
  fresh(); let reads = 0
  const h = directHarness({ intercept(call) {
    if (call.url.endsWith("/presign-batch")) {
      const found = answer()
      return json({ objects: [{ account_id: found.accountId, workspace_uuid: found.workspaceUuid, storage_revision: found.storageRevision,
        object_key: found.objectKey, public_url: found.publicUrl, transport: "ready" }] })
    }
    return undefined
  } })
  try {
    const batch = await createMediaUploadBatch(WORKSPACE)
    await assert.rejects(deliverMediaObject({ ...image(DIGEST, 2), uploadBatch: batch.uploadBatch,
      bytes: () => { reads++; return new Uint8Array([1, 2]) },
    }), { code: "media_upload_batch_mismatch" })
    assert.equal(reads, 0)
    assert.equal(h.calls.some(c => c.method === "PUT"), false)
  } finally { h.restore() }
})

import assert from "node:assert/strict"
import test, { beforeEach } from "node:test"
import { forgetMediaObjects } from "../media/media-objects"
import { requestStop, setCardContext } from "./execution-context"
import { invalidateAccountOverview, peekAccountOverview, rememberAccountOverview } from "@/features/account/account-overview-cache"
import { record, ROW, SLICE_DIGEST, withStubbedDevice } from "./executor-test-support"

beforeEach(forgetMediaObjects)

async function runChangedStorage(input: {
  phase: "presign" | "complete"
  alwaysReject?: boolean
  code?: string
  interrupt?: "stop" | "workspace"
}) {
  const ids = ["batch-change-1", "batch-change-2"]
  const previousOverview = peekAccountOverview()
  const images = [{ index: 0, file_name: "slice-1.jpg", content_hash: `sha256:${SLICE_DIGEST}`,
    group_name: "main", width: 1, height: 1, byte_size: 1, phase: "rendered" }]
  const row = { ...ROW, media_state: "rendered", media: { images, videos: [] },
    render_evidence: { manifest_digest: "batch-change", manifest: { images } } }
  const stub = record(call => {
    const id = call.url.match(/\/rows\/([^/?]+)/)?.[1] ?? ids[0]!
    if (call.url.endsWith("/prepare")) return { outcome: "running", jobs: [{ id: `upload-${id}`,
      kind: "media.upload", executor: "browser", state: "queued",
      payload: { manifest_digest: "batch-change", manifest: { images } } }] }
    if (call.url.endsWith("/media")) return { applied: true, jobs: [], row: { ...row, id } }
    return { ...row, id }
  })
  const send = globalThis.fetch
  let invalidBatch: string | undefined
  const refused: string[] = []
  const attempts: string[] = []
  globalThis.fetch = (async (url, init) => {
    const path = String(url)
    if (path.endsWith(`/media/objects/${input.phase}-batch`)
      || (input.phase === "complete" && /\/media\/objects\/[^/]+\/[^/]+\/complete$/.test(path))) {
      const body = JSON.parse(String(init?.body))
      invalidBatch ??= body.upload_batch
      attempts.push(body.upload_batch)
      if (input.alwaysReject || body.upload_batch === invalidBatch) {
        refused.push(body.upload_batch)
        if (input.interrupt === "stop") requestStop(ids)
        if (input.interrupt === "workspace") {
          const overview = peekAccountOverview()
          assert.ok(overview?.active_workspace)
          rememberAccountOverview({ ...overview,
            active_workspace: { ...overview.active_workspace, uuid: "another-workspace" } })
        }
        return Response.json({ code: input.code ?? "MEDIA_UPLOAD_BATCH_INVALID", error: "stale upload batch" }, { status: 403 })
      }
    }
    return send(url, init)
  }) as typeof fetch
  setCardContext({ psdTemplateSha256: "template-sha" })
  try {
    const { runRows } = await import("./run-rows")
    const results = await withStubbedDevice(() => runRows({ row_ids: ids, expected_revisions: [] }, "upload"))
    return { results, refused, attempts, calls: stub.calls, invalidBatch }
  } finally {
    stub.restore()
    setCardContext({ psdTemplateSha256: "" })
    if (previousOverview) rememberAccountOverview(previousOverview)
    else invalidateAccountOverview()
  }
}

for (const phase of ["presign", "complete"] as const) {
  test(`storage change at ${phase} refreshes the shared batch and finishes without OCR or rendering`, async () => {
    const { results, calls, attempts, invalidBatch } = await runChangedStorage({ phase })
    assert.equal(results.length, 2)
    assert.ok(results.every(row => !row.error))
    assert.equal(calls.filter(call => call.url.endsWith("/media/upload-batches")).length, 2)
    assert.ok(attempts.some(batch => batch !== invalidBatch))
    assert.equal(calls.some(call => /\/ai\/|\/render/.test(call.url)), false)
    assert.equal(calls.filter(call => call.url.endsWith("/media/images")).length, 2)
  })
}

test("invalid batches cannot cause an unbounded upload retry", async () => {
  const { results, calls, attempts } = await runChangedStorage({ phase: "presign", alwaysReject: true })
  assert.ok(results.every(row => row.error))
  assert.ok(attempts.length >= 2 && attempts.length <= 6)
  assert.ok(new Set(attempts).size > 1)
  assert.ok(calls.filter(call => call.url.endsWith("/media/upload-batches")).length <= 7)
  assert.equal(calls.some(call => call.method === "PUT"), false)
})

test("ordinary forbidden requests never refresh the upload batch", async () => {
  const { results, calls } = await runChangedStorage({ phase: "presign", code: "FORBIDDEN", alwaysReject: true })
  assert.ok(results.every(row => row.error))
  assert.equal(calls.filter(call => call.url.endsWith("/media/upload-batches")).length, 1)
  assert.equal(calls.some(call => call.method === "PUT"), false)
})

for (const interrupt of ["stop", "workspace"] as const) {
  test(`${interrupt} change fences batch refresh after rejection`, async () => {
    const { calls } = await runChangedStorage({ phase: "presign", interrupt })
    assert.equal(calls.filter(call => call.url.endsWith("/media/upload-batches")).length, 1)
    assert.equal(calls.some(call => call.method === "PUT"), false)
  })
}

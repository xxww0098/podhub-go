import assert from "node:assert/strict"
import test from "node:test"
import { hashUploadBody } from "@/bindings/direct-upload"
import { MEDIA_UPLOAD_CONCURRENCY, deliverMediaObject } from "./media-objects"
import { fresh, directHarness, image } from "./direct-media-test-fixtures"
const tick = () => new Promise<void>(resolve => setImmediate(resolve))
async function until(predicate: () => boolean): Promise<void> {
  for (let i = 0; i < 1000; i++) { if (predicate()) return; await tick() }
  throw new Error("bounded test wait expired")
}
async function objects(count: number) {
  return await Promise.all(Array.from({ length: count }, async (_, i) => {
    const bytes = new Uint8Array([i + 1])
    return { bytes, digest: await hashUploadBody(bytes) }
  }))
}

test("singleflight followers spend no permits and queued byte reads stay lazy", async () => {
  fresh(); const h = directHarness(); h.hold(); const data = await objects(MEDIA_UPLOAD_CONCURRENCY + 2)
  let reads = 0; const running: Promise<unknown>[] = []
  try {
    for (let i = 0; i < 12; i++) running.push(deliverMediaObject({ ...image(data[0]!.digest, 1), bytes: () => { reads++; return data[0]!.bytes } }))
    for (const obj of data.slice(1)) running.push(deliverMediaObject({ ...image(obj.digest, 1), bytes: () => { reads++; return obj.bytes } }))
    await until(() => reads === MEDIA_UPLOAD_CONCURRENCY)
    await tick()
    assert.equal(reads, MEDIA_UPLOAD_CONCURRENCY)
    assert.equal(h.calls.filter(c => c.method === "PUT").length, MEDIA_UPLOAD_CONCURRENCY)
    h.release(); await Promise.all(running)
    assert.equal(reads, data.length)
  } finally { h.release(); await Promise.allSettled(running); h.restore() }
})

test("cancelled asynchronous ByteSource settles before a reusable upload permit", async () => {
  fresh(); const h = directHarness(); h.hold(); const data = await objects(MEDIA_UPLOAD_CONCURRENCY + 1)
  let cancelled = false, readerEntered = 0, queuedRead = false
  const finish: Array<() => void> = []
  const running = data.slice(0, MEDIA_UPLOAD_CONCURRENCY).map((obj, i) => deliverMediaObject({
    ...image(obj.digest, 1), retry: { cancelled: () => i === 0 && cancelled },
    bytes: () => new Promise<Uint8Array<ArrayBuffer>>(resolve => { readerEntered++; finish[i] = () => resolve(obj.bytes) }),
  }))
  // Attach the rejection handler before cancelling so no unhandled rejection races the assertion.
  const first = assert.rejects(running[0]!, { code: "workflow_cancelled" })
  let queued: Promise<unknown> | undefined
  try {
    await until(() => readerEntered === MEDIA_UPLOAD_CONCURRENCY)
    cancelled = true
    const obj = data.at(-1)!
    queued = deliverMediaObject({ ...image(obj.digest, 1), bytes: () => { queuedRead = true; return obj.bytes } })
    await tick(); await tick()
    assert.equal(queuedRead, false, "cancel alone cannot release an unresolved source")
    finish[0]!(); await first
    await until(() => queuedRead)
    for (const resolve of finish.slice(1)) resolve()
    h.release(); await Promise.all(running.slice(1)); await queued
  } finally {
    for (const resolve of finish) resolve?.()
    h.release(); await Promise.allSettled([...running, ...(queued ? [queued] : [])]); h.restore()
  }
})

test("cancelled queued request neither reads bytes nor waits for occupied PUTs", async () => {
  fresh(); const h = directHarness(); h.hold(); const data = await objects(MEDIA_UPLOAD_CONCURRENCY + 1)
  const running = data.slice(0, -1).map(obj => deliverMediaObject({ ...image(obj.digest, 1), bytes: () => obj.bytes }))
  let cancel = false, read = false
  try {
    await until(() => h.calls.filter(c => c.method === "PUT").length === MEDIA_UPLOAD_CONCURRENCY)
    const obj = data.at(-1)!
    const queued = deliverMediaObject({ ...image(obj.digest, 1), retry: { cancelled: () => cancel }, bytes: () => { read = true; return obj.bytes } })
    const rejected = assert.rejects(queued, { code: "workflow_cancelled" })
    await tick(); cancel = true; await rejected
    assert.equal(read, false)
  } finally { h.release(); await Promise.allSettled(running); h.restore() }
})

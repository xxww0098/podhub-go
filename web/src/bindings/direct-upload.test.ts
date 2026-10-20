import assert from "node:assert/strict"
import { afterEach, describe, test } from "node:test"
import { hashUploadBody, putDirectUpload } from "./direct-upload"

const originalFetch = globalThis.fetch
afterEach(() => { globalThis.fetch = originalFetch })
const grant = () => ({ url: "https://bucket.example.test/a?secret=signed-bearer",
  headers: { content_type: "application/octet-stream", if_none_match: "*" }, expires_at_ms: Date.now() + 600000 })

describe("anonymous direct upload", () => {
  test("sends the store checksum only when the grant carries one", async () => {
    let init: RequestInit | undefined
    globalThis.fetch = (async (_url, options) => { init = options; return new Response(null, { status: 200 }) }) as typeof fetch
    const checksum = "ungWv48Bz+pBQUDeXa4iI7ADYaOWF3qctBD/YfIAFa0="
    await putDirectUpload({ ...grant(), headers: { ...grant().headers, checksum_sha256: checksum } },
      new Uint8Array([97, 98, 99]), { expectedByteLength: 3 })
    assert.deepEqual(init?.headers, {
      "Content-Type": "application/octet-stream",
      "If-None-Match": "*",
      "x-amz-checksum-sha256": checksum,
    })
    await assert.rejects(putDirectUpload({ ...grant(), headers: { ...grant().headers, checksum_sha256: "nope" } },
      new Uint8Array([1]), { expectedByteLength: 1 }))
  })
  test("sends only exact view with anonymous restricted Fetch", async () => {
    const backing = Uint8Array.from([99, 1, 2, 3, 88])
    const bytes = backing.subarray(1, 4)
    let init: RequestInit | undefined
    globalThis.fetch = (async (_url, options) => { init = options; return new Response(null, { status: 200 }) }) as typeof fetch
    await putDirectUpload(grant(), bytes, { expectedByteLength: 3 })
    assert.equal(init?.body, bytes)
    assert.equal(init?.credentials, "omit")
    assert.equal(init?.redirect, "error")
    assert.equal(init?.referrerPolicy, "no-referrer")
    assert.deepEqual(init?.headers, { "Content-Type": "application/octet-stream", "If-None-Match": "*" })
  })
  test("412 is confirmable but does not report transferred bytes", async () => {
    const progress: number[] = []
    globalThis.fetch = (async () => new Response(null, { status: 412 })) as typeof fetch
    await putDirectUpload(grant(), new Blob(["abc"]), { expectedByteLength: 3, onProgress: loaded => progress.push(loaded) })
    assert.deepEqual(progress, [0])
  })
  test("unknown network and origin errors discard raw secrets", async () => {
    globalThis.fetch = (async () => { throw new Error("https://bucket.test?secret=LEAK") }) as typeof fetch
    const error = await putDirectUpload(grant(), new Uint8Array(3), { expectedByteLength: 3 }).catch(x => x)
    assert.equal(error.outcomeUnknown, true)
    assert.equal(error.message, "网络已断开")
    assert.equal(error.cause, undefined)
    assert.doesNotMatch(String(error), /LEAK/)
    globalThis.fetch = (async () => new Response("<xml>LEAK</xml>", { status: 503 })) as typeof fetch
    const http = await putDirectUpload(grant(), new Uint8Array(3), { expectedByteLength: 3 }).catch(x => x)
    assert.equal(http.status, 503)
    assert.equal(http.outcomeUnknown, true)
    assert.doesNotMatch(String(http), /LEAK/)
  })
  test("invalid/stale/cancelled grants do not transmit", async () => {
    let calls = 0
    globalThis.fetch = (async () => { calls++; return new Response() }) as typeof fetch
    await assert.rejects(putDirectUpload({ ...grant(), url: "http://evil.test/object" }, new Uint8Array(3), { expectedByteLength: 3 }))
    await assert.rejects(putDirectUpload(grant(), new Uint8Array(4), { expectedByteLength: 3 }))
    await assert.rejects(
      putDirectUpload({ ...grant(), expires_at_ms: 1 }, new Uint8Array(3), { expectedByteLength: 3 }),
      { message: "上传签名已过期" },
    )
    await assert.rejects(putDirectUpload(grant(), new Uint8Array(3), { expectedByteLength: 3, signal: AbortSignal.abort() }))
    assert.equal(calls, 0)
  })
})

const HASH_PAD = 32

test("SHA hashes exact views and only bounded Blob slices", async () => {
  const bytes = new Uint8Array(2 * 1024 * 1024 + 11).fill(57)
  const blob = new Blob([bytes])
  const native = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))).map(x => x.toString(16).padStart(2, "0")).join("")
  blob.arrayBuffer = async () => { throw new Error("must not eagerly read whole File") }
  assert.equal(await hashUploadBody(blob), native)
  assert.equal(await hashUploadBody(bytes), native)
  const sliced = Uint8Array.from([7, 97, 98, 99, 8]).subarray(1, 4)
  assert.equal(await hashUploadBody(sliced), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad")
  const backing = new Uint8Array(HASH_PAD + 1024 * 1024)
  backing.fill(9)
  backing[0] = 1
  backing[backing.length - 1] = 2
  const window = backing.subarray(8, 8 + 1024 * 1024)
  const viewDigest = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", window)))
    .map((byte) => byte.toString(16).padStart(2, "0")).join("")
  assert.equal(await hashUploadBody(window), viewDigest)
  assert.notEqual(viewDigest, native)
  await assert.rejects(hashUploadBody(blob, AbortSignal.abort()))
  await assert.rejects(hashUploadBody(bytes, AbortSignal.abort()))
})

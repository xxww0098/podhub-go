import assert from "node:assert/strict"
import test from "node:test"
import { route } from "@/api/routes"
import { hashUploadBody } from "@/bindings/direct-upload"
import { analyzeImageBody, OCR_MAX_IMAGE_BYTES, prepareOcrImage, stageOcrImage } from "./ocr-upload"

const bytes = new Uint8Array([0xff, 0xd8, 0xff, 4])
const image = prepareOcrImage(bytes)
const headers = { "X-Listing-Job-Id": "job", "X-Listing-Lease-Owner": "owner", "X-Listing-Lease-Epoch": "7" }
const target = { upload_ticket: "private-ticket", upload: { url: "https://private.invalid/put?secret=capability", expires_at_ms: Date.now() + 600_000,
  headers: { content_type: "image/jpeg", if_none_match: "*" } } }
type Call = { path: string; init?: RequestInit; json?: any }
async function fixture(run: (calls: Call[]) => Promise<void>, respond: (call: Call) => Response | Promise<Response>) {
  const previous = globalThis.fetch; const calls: Call[] = []
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const call = { path: String(input), init, json: typeof init?.body === "string" ? JSON.parse(init.body) : undefined }
    calls.push(call)
    if (call.path === route("aiOcrUploads")) return Response.json({ data: target })
    return respond(call)
  }) as typeof fetch
  try { await run(calls) } finally { globalThis.fetch = previous }
}
function error(code: string, status = 409) { return Response.json({ code, error: "safe refusal" }, { status }) }
async function verified() { return Response.json({ data: { bytes: bytes.byteLength, content_type: "image/jpeg", sha256: await hashUploadBody(bytes) } }) }

 test("OCR JSON is a bounded ticket and private PUT carries the identical prepared bytes", async () => {
  await fixture(async calls => {
    assert.deepEqual(await stageOcrImage(image, headers), analyzeImageBody("private-ticket"))
    assert.equal(calls.length, 2)
    assert.deepEqual(calls[0]!.json, { image: { bytes: 4, content_type: "image/jpeg", sha256: await hashUploadBody(bytes) } })
    assert.equal(calls[0]!.init?.credentials, "include")
    const put = calls[1]!
    assert.equal(put.init?.credentials, "omit"); assert.equal(put.init?.redirect, "error")
    assert.deepEqual(put.init?.body, bytes)
    assert.equal(new Headers(put.init?.headers).get("If-None-Match"), "*")
    assert.equal(new Headers(put.init?.headers).get("X-Listing-Job-Id"), null)
    assert.ok(!JSON.stringify(calls[0]!.json).includes("base64"))
  }, () => new Response(null, { status: 200 }))
})

test("lost PUT response confirms first and never uploads twice", async () => {
  await fixture(async calls => {
    assert.deepEqual(await stageOcrImage(image, headers), { uploadTicket: "private-ticket" })
    assert.deepEqual(calls.map(c => c.init?.method), ["POST", "PUT", "POST"])
    assert.equal(calls[2]!.path, route("aiOcrUploadsConfirm"))
    assert.deepEqual(calls[2]!.json, { upload_ticket: "private-ticket" })
  }, call => { if (call.init?.method === "PUT") throw new TypeError("lost response with secret URL")
    return verified() })
})

test("only authenticated MEDIA_COMPLETE_MISSING permits another PUT", async () => {
  let puts = 0
  await fixture(async calls => {
    await stageOcrImage(image, headers)
    assert.deepEqual(calls.map(c => c.init?.method), ["POST", "PUT", "POST", "PUT"])
  }, call => { if (call.init?.method === "PUT") { if (++puts === 1) throw new TypeError("lost"); return new Response(null, { status: 200 }) }
    return error("MEDIA_COMPLETE_MISSING", 404) })
})

test("unavailable confirm is bounded at three and cannot trigger a blind retransmission", async () => {
  await fixture(async calls => {
    await assert.rejects(stageOcrImage(image, headers))
    assert.equal(calls.filter(c => c.init?.method === "PUT").length, 1)
    assert.equal(calls.filter(c => c.path.endsWith("/confirm")).length, 3)
  }, call => { if (call.init?.method === "PUT") throw new TypeError("lost")
    return error("UNAVAILABLE", 503) })
})

test("missing and uncertain PUT stop after three attempts total", async () => {
  await fixture(async calls => {
    await assert.rejects(stageOcrImage(image, headers))
    assert.equal(calls.filter(c => c.init?.method === "PUT").length, 3)
    assert.equal(calls.filter(c => c.path.endsWith("/confirm")).length, 3)
  }, call => { if (call.init?.method === "PUT") throw new TypeError("lost")
    return error("MEDIA_COMPLETE_MISSING", 404) })
})

test("corrupt, foreign and mismatched confirmations cannot overwrite an object or buy OCR", async () => {
  for (const answer of [() => error("CONFLICT"), () => error("FORBIDDEN", 403),
    () => Response.json({ data: { bytes: 4, content_type: "image/jpeg", sha256: "foreign" } })]) {
    await fixture(async calls => {
      await assert.rejects(stageOcrImage(image, headers))
      assert.equal(calls.filter(c => c.init?.method === "PUT").length, 1)
      assert.equal(calls.some(c => c.path.endsWith("/completions")), false)
    }, call => { if (call.init?.method === "PUT") throw new TypeError("lost")
      return answer() })
  }
})

test("cancel interrupts an in-flight private PUT without confirming or processing", async () => {
  const controller = new AbortController()
  await fixture(async calls => {
    await assert.rejects(stageOcrImage(image, headers, { signal: controller.signal }), /准备已停止/)
    assert.equal(calls.length, 2)
  }, call => new Promise<Response>((_, reject) => {
    call.init?.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true })
    controller.abort()
  }))
})

test("workspace/input switch after PUT refuses the paid body", async () => {
  let switched = false
  await fixture(async calls => {
    await assert.rejects(stageOcrImage(image, headers, { assertCurrent: () => { if (switched) throw new Error("workspace switched") } }), /workspace switched/)
    assert.equal(calls.length, 2)
  }, () => { switched = true; return new Response(null, { status: 200 }) })
})

test("oversized or empty rasters cannot request a grant", async () => {
  assert.throws(() => prepareOcrImage(new Uint8Array()), /大小上限/)
  assert.throws(() => prepareOcrImage(new Uint8Array(OCR_MAX_IMAGE_BYTES + 1)), /大小上限/)
})

import assert from "node:assert/strict"
import test from "node:test"
import type { components } from "@/api/schema"
import { uploadPsdTemplate } from "./http-templates"

type Template = components["schemas"]["PsdTemplateView"]
function template(): Template {
  return { id: "t", sha256: "a".repeat(64), file_name: "x.psd", bytes: 4,
    description_category_id: 10, type_id: 20, ready: false,
    upload: { url: "https://s3.example.invalid/private/x.psd?X-Amz-Signature=DO_NOT_LOG",
      headers: { content_type: "application/octet-stream", if_none_match: "*" }, expires_at_ms: Date.now() + 600_000 } }
}

test("PSD PUT is direct, cookie-free, conditional and sends only the exact byte view", async () => {
  const original = globalThis.fetch
  const view = new Uint8Array([9, 1, 2, 3, 4, 8]).subarray(1, 5)
  const grant = template()
  Object.assign(grant.upload!.headers, { authorization: "must-not-send", contentLength: "999" })
  globalThis.fetch = async (input, init) => {
    assert.equal(String(input), grant.upload!.url)
    assert.equal(init?.method, "PUT")
    assert.equal(init?.mode, "cors")
    assert.equal(init?.credentials, "omit")
    assert.equal(init?.cache, "no-store")
    assert.equal(init?.redirect, "error")
    assert.equal(init?.referrerPolicy, "no-referrer")
    assert.ok(init?.signal)
    assert.equal(init?.body, view)
    assert.deepEqual(Array.from(init!.body as Uint8Array), [1, 2, 3, 4])
    const headers = new Headers(init?.headers)
    assert.deepEqual(Array.from(headers.keys()), ["content-type", "if-none-match"])
    assert.equal(headers.get("if-none-match"), "*")
    return new Response(null, { status: 204 })
  }
  try { await uploadPsdTemplate(grant, view) } finally { globalThis.fetch = original }
})

test("S3 412 permits confirmation, while 409 has an unknown outcome", async () => {
  const original = globalThis.fetch
  try {
    globalThis.fetch = async () => new Response("existing", { status: 412 })
    await uploadPsdTemplate(template(), new Uint8Array(4))
    globalThis.fetch = async () => new Response("conditional conflict", { status: 409 })
    await assert.rejects(uploadPsdTemplate(template(), new Uint8Array(4)), { status: 409, outcomeUnknown: true })
  } finally { globalThis.fetch = original }
})

test("origin failures retain status/retry delay but never URL, XML or raw fetch cause", async () => {
  const original = globalThis.fetch
  try {
    globalThis.fetch = async () => new Response("DO_NOT_LOG XML", { status: 503, headers: { "Retry-After": "2" } })
    await assert.rejects(uploadPsdTemplate(template(), new Uint8Array(4)), (reason: unknown) => {
      assert.equal((reason as { retryAfterMs: number }).retryAfterMs, 2000)
      assert.equal((reason as { status: number }).status, 503)
      assert.doesNotMatch(String(reason) + JSON.stringify(reason), /DO_NOT_LOG|X-Amz|example.invalid/)
      return true
    })
    globalThis.fetch = async () => { throw new TypeError(template().upload!.url) }
    await assert.rejects(uploadPsdTemplate(template(), new Uint8Array(4)), (reason: unknown) => {
      assert.equal((reason as { outcomeUnknown: boolean }).outcomeUnknown, true)
      assert.doesNotMatch(String(reason) + JSON.stringify(reason), /DO_NOT_LOG|X-Amz|example.invalid/)
      assert.equal((reason as Error).cause, undefined)
      return true
    })
  } finally { globalThis.fetch = original }
})

test("near-expiry, unsafe URL, wrong length and weakened conditional header spend no PUT", async () => {
  const original = globalThis.fetch
  let calls = 0
  globalThis.fetch = async () => { calls++; return new Response(null, { status: 204 }) }
  try {
    const expired = template(); expired.upload!.expires_at_ms = Date.now() + 1000
    await assert.rejects(uploadPsdTemplate(expired, new Uint8Array(4)), { status: 403 })
    const unsafe = template(); unsafe.upload!.url = "http://s3.example.invalid/private/x"
    await assert.rejects(uploadPsdTemplate(unsafe, new Uint8Array(4)), { code: "workflow_template_upload_unavailable" })
    const weakened = template(); weakened.upload!.headers.if_none_match = ""
    await assert.rejects(uploadPsdTemplate(weakened, new Uint8Array(4)), { code: "workflow_template_upload_unavailable" })
    await assert.rejects(uploadPsdTemplate(template(), new Uint8Array(5)), { code: "workflow_template_upload_unavailable" })
    assert.equal(calls, 0)
  } finally { globalThis.fetch = original }
})

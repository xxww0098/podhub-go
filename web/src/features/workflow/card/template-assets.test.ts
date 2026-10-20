import assert from "node:assert/strict"
import test, { afterEach } from "node:test"
import { persistUserTemplate } from "./template-assets"
import { renderOpfs } from "@/bindings/render-opfs"
import { route } from "@/api/routes"
import { sha256Hex, putTemplate, getTemplate } from "@/render/opfs"
import { clearCacheFamily } from "@/render/opfs-cache"
import { stubOpfs, restoreOpfsTestGlobals } from "@/render/opfs-test-support"

afterEach(restoreOpfsTestGlobals)

test("a private fixed template survives cache eviction and coalesces concurrent recovery", async () => {
  const fs = stubOpfs()
  const bytes = new Uint8Array([1, 2, 3, 4])
  const digest = await sha256Hex(bytes)
  const original = globalThis.fetch
  let calls = 0
  const objectUrl = "https://s3.example.invalid/private/templates/x.psd?X-Amz-Signature=test"
  const grant = (body: Uint8Array, sha = digest) => Response.json({
    data: {
      url: objectUrl,
      expires_at_ms: Date.now() + 60_000,
      bytes: body.byteLength,
      file_name: "x.psd",
      content_type: "application/octet-stream",
      sha256: sha,
    },
  })
  globalThis.fetch = async (input, init) => {
    calls++
    const url = String(input)
    if (url === route("listingCardsByIdTemplatesByDigest", { id: "card-1", digest })) {
      assert.equal(new Headers(init?.headers).get("accept"), "application/json")
      return grant(bytes)
    }
    assert.equal(url, objectUrl)
    assert.equal(init?.credentials, "omit")
    assert.equal(init?.redirect, "error")
    return new Response(bytes)
  }
  try {
    await Promise.all([
      renderOpfs.workflowRestoreTemplatePsd(digest, undefined, "card-1"),
      renderOpfs.workflowRestoreTemplatePsd(digest, undefined, "card-1"),
    ])
    assert.equal(calls, 2)
    assert.deepEqual(await getTemplate(digest), bytes)
    await renderOpfs.workflowRestoreTemplatePsd(digest, undefined, "card-1")
    assert.equal(calls, 2, "valid cache needs no backend request")
    fs.contents.set(`templates/${digest}.psd`, new Uint8Array([9]))
    await renderOpfs.workflowRestoreTemplatePsd(digest, undefined, "card-1")
    assert.equal(calls, 4, "corrupt cached bytes are recovered")
    await clearCacheFamily("templates")
    globalThis.fetch = async (input) => {
      if (String(input) === objectUrl) return new Response(new Uint8Array([9]))
      return grant(new Uint8Array([9]))
    }
    await assert.rejects(renderOpfs.workflowRestoreTemplatePsd(digest, undefined, "card-1"), { code: "workflow_template_digest_mismatch" })
    assert.equal(await getTemplate(digest), null, "corrupt download is never cached")
  } finally { globalThis.fetch = original }
})

test("PSD persistence coalesces upload, confirms before success and replays one lost confirmation", async () => {
  stubOpfs()
  const bytes = new Uint8Array([1, 2, 3, 4])
  const digest = await putTemplate(bytes)
  const original = globalThis.fetch
  const calls: string[] = []
  let confirmations = 0
  const uploadUrl = "https://s3.example.invalid/templates/x.psd?sig=1"
  const template = { id: "template-1", sha256: digest, file_name: "x.psd", bytes: bytes.length,
    description_category_id: 10, type_id: 20, ready: false,
    upload: { url: uploadUrl, headers: { content_type: "application/octet-stream", if_none_match: "*" }, expires_at_ms: Date.now() + 60_000 } }
  globalThis.fetch = async (input, init) => {
    const path = String(input)
    calls.push(path)
    if (path === route("listingTemplates")) {
      assert.deepEqual(JSON.parse(String(init?.body)), { sha256: digest, file_name: "x.psd", bytes: 4, description_category_id: 10, type_id: 20 })
      return Response.json({ data: template })
    }
    if (path === uploadUrl) {
      assert.equal(init?.method, "PUT")
      assert.equal(new Headers(init?.headers).get("content-type"), "application/octet-stream")
      assert.equal(new Headers(init?.headers).get("if-none-match"), "*")
      assert.deepEqual(init?.body, bytes)
      return new Response(null, { status: 204 })
    }
    assert.equal(path, route("listingTemplatesByIdConfirm", { id: template.id }))
    confirmations++
    if (confirmations === 1) throw new TypeError("response lost")
    return Response.json({ data: { ...template, ready: true } })
  }
  try {
    await Promise.all([persistUserTemplate(digest, "x.psd", 10, 20), persistUserTemplate(digest, "x.psd", 10, 20)])
    assert.equal(calls.length, 4)
    assert.equal(confirmations, 2)
    globalThis.fetch = async () => Response.json({ error: "digest mismatch", code: "conflict" }, { status: 409 })
    await assert.rejects(persistUserTemplate(digest, "x.psd", 10, 20), { code: "cloud_conflict" })
  } finally { globalThis.fetch = original }
})

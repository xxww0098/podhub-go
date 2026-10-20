/**
 * The OPFS cluster answers local presence without a Cloud round trip.
 */
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"

import { renderOpfs } from "./render-opfs"
import { downloadSupplierTemplate } from "./http-media"
import { route } from "@/api/routes"

test("supplier template download uses the product route and refuses a mismatched identity", async () => {
  const original = globalThis.fetch
  let header = "expected-digest"
  let objectFetches = 0
  const objectUrl = "https://s3.example.invalid/supplier/template.psd?X-Amz-Signature=test"
  globalThis.fetch = async (input, init) => {
    const url = String(input)
    if (url === objectUrl) {
      objectFetches++
      return new Response(new Uint8Array([56, 66, 80, 83]))
    }
    assert.equal(url, route("mediaSupplierProductsByProductIdTemplatesByDigest", { product_id: "product-17", digest: "expected-digest" }))
    assert.equal(new Headers(init?.headers).get("accept"), "application/json")
    return Response.json({
      data: {
        url: objectUrl,
        expires_at_ms: Date.now() + 60_000,
        bytes: 4,
        file_name: "template.psd",
        content_type: "application/octet-stream",
        sha256: header,
      },
    })
  }
  try {
    assert.deepEqual(await downloadSupplierTemplate("product-17", "expected-digest"), new Uint8Array([56, 66, 80, 83]))
    assert.equal(objectFetches, 1)
    header = "other-digest"
    await assert.rejects(downloadSupplierTemplate("product-17", "expected-digest"), { code: "workflow_template_digest_mismatch" })
    assert.equal(objectFetches, 1, "a mismatched grant is not fetched")
  } finally {
    globalThis.fetch = original
  }
})

test("an operator PSD digest is never downloaded as supplier media", async () => {
  const original = globalThis.fetch
  const calls: string[] = []
  globalThis.fetch = async (input) => {
    calls.push(String(input))
    return new Response(JSON.stringify({ data: { psd_sha256: "supplier-digest" } }), {
      headers: { "Content-Type": "application/json" },
    })
  }
  try {
    await assert.rejects(
      renderOpfs.workflowStageSupplierTemplate("product-17", "operator-digest", "picked.psd"),
      { code: "workflow_template_missing" },
    )
    assert.deepEqual(calls, [route("mediaSupplierProductsByProductIdVerify", { product_id: "product-17" })])
  } finally {
    globalThis.fetch = original
  }
})

test("supplier verification failures keep their own error", async () => {
  const original = globalThis.fetch
  globalThis.fetch = async () => new Response(JSON.stringify({ error: "供应商校验失败", code: "supplier_unavailable" }), {
    status: 503,
    headers: { "Content-Type": "application/json" },
  })
  try {
    await assert.rejects(
      renderOpfs.workflowStageSupplierTemplate("product-17", "supplier-digest"),
      { code: "cloud_supplier_unavailable" },
    )
  } finally {
    globalThis.fetch = original
  }
})

test("commands.ts no longer forwards the render/OPFS cluster", () => {
  const source = readFileSync(new URL("./commands.ts", import.meta.url), "utf8")
  assert.doesNotMatch(source, /workflowSourcePreview|workflowRenderedSlicePreview/)
  assert.doesNotMatch(source, /workflowRestoreProductInstances|workflowRestoreTemplatePsd/)
  assert.doesNotMatch(source, /workflowPickTemplatePsd|workflowImportTemplatePsdPath/)
  assert.doesNotMatch(source, /export \{[\s\S]*renderOpfs/)
})

test("restore reports a miss when this device has no source bytes", async () => {
  const restored = await renderOpfs.workflowRestoreProductInstances([
    { draft_id: "row-1", handle: "deadbeef/source.jpg" },
    { draft_id: "row-2", handle: "" },
  ])
  assert.deepEqual(restored, [
    { draft_id: "row-1", source: undefined },
    { draft_id: "row-2", source: undefined },
  ])
})

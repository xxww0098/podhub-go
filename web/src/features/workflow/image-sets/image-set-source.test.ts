import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { Blob as NativeBlob, resolveObjectURL } from "node:buffer"
import { URL as NativeURL } from "node:url"
import { test } from "node:test"
import type { NetworkGuard } from "../../../../tests/network-guard.preload"
import { renderOpfs } from "@/bindings/render-opfs"
import { imageSetSource, imageSourceType } from "./image-set-source"

async function isolatedSourceTest(run: () => Promise<void>) {
  const previous = { preview: renderOpfs.workflowSourcePreview, bitmap: globalThis.createImageBitmap, fetch: globalThis.fetch }
  try { await run() }
  finally { renderOpfs.workflowSourcePreview = previous.preview; globalThis.createImageBitmap = previous.bitmap; globalThis.fetch = previous.fetch }
}
function emptyMIMEBlobFetch() {
  const guard = (globalThis as unknown as Record<symbol, NetworkGuard | undefined>)[Symbol.for("podhub.network-guard")]
  assert.ok(guard, "run with --preload ./tests/network-guard.preload.ts")
  // Bun assigns text/plain to an untyped blob URL; browsers preserve its empty MIME.
  // Read through the preload's stable guard, never another suite's captured API stub.
  globalThis.fetch = (async (input, init) => {
    const response = await guard.fetch(input, init)
    const bytes = await response.arrayBuffer()
    Object.defineProperty(response, "blob", { value: async () => new NativeBlob([bytes]) })
    return response
  }) as typeof fetch
}
test("local OPFS blob URLs with no MIME use actual JPEG bytes despite an unrelated API fetch stub", () => isolatedSourceTest(async () => {
  globalThis.fetch = (async () => Response.json({ data: { unrelated: "API response" } })) as typeof fetch
  emptyMIMEBlobFetch()
  const bytes = readFileSync(new NativeURL("../../../../public/site/product-tote.jpg", import.meta.url))
  assert.equal(bytes.subarray(0, 3).toString("hex"), "ffd8ff")
  let receivedType = "", closed = false, edge: number | undefined, ownedURL = ""
  renderOpfs.workflowSourcePreview = async (_handle, requestedEdge) => { edge = requestedEdge; ownedURL = NativeURL.createObjectURL(new NativeBlob([bytes])); return { data_url: ownedURL } }
  globalThis.createImageBitmap = (async (blob: Blob) => { receivedType = blob.type; return { width: 1254, height: 1254, close: () => { closed = true } } }) as typeof createImageBitmap
  const value = await imageSetSource("actual-local-handle")
  assert.equal(receivedType, "image/jpeg")
  assert.equal(edge, 1600)
  assert.equal(closed, true)
  assert.deepEqual(Buffer.from(value.base64, "base64"), bytes)
  assert.equal(value.sha256.length, 64)
  assert.equal(resolveObjectURL(ownedURL), undefined, "the source helper revokes its owned blob URL")
  assert.throws(() => imageSourceType(new Uint8Array(bytes), "image/png"), /JPEG\/PNG/)
  assert.throws(() => imageSourceType(new TextEncoder().encode("not an image.jpg"), "image/jpeg"), /JPEG\/PNG/)
}))
test("oversized image dimensions and remote preview URLs fail before a purchase can be formed", () => isolatedSourceTest(async () => {
  emptyMIMEBlobFetch()
  const bytes = readFileSync(new NativeURL("../../../../public/site/product-tote.jpg", import.meta.url))
  renderOpfs.workflowSourcePreview = async () => ({ data_url: NativeURL.createObjectURL(new NativeBlob([bytes])) })
  globalThis.createImageBitmap = (async () => ({ width: 2001, height: 2000, close: () => {} })) as typeof createImageBitmap
  await assert.rejects(imageSetSource("large"), /400 万像素/)
  renderOpfs.workflowSourcePreview = async () => ({ data_url: "https://unverified.example.invalid/product.jpg" })
  await assert.rejects(imageSetSource("external"), /不可读取/)
}))

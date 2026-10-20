import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"
import { ListingCoreClient } from "@/listing-core/client"
import type { WbSchemaHandle } from "@/listing-core/wb-types"
import { goldenSchema, wasmCore } from "../../submit/send-test-support"
import { wbConfigFixture, wbMaterialFixture } from "../../../../../tests/publish-pipeline-fixtures"

test("WB op14/op15 use the existing ABI, preserve variant order and return exact outer-array upload bytes", async () => {
  const core = await wasmCore()
  const handle = core.loadWbMaterial(wbMaterialFixture())
  assert.deepEqual(core.wbMetadataIssues(handle), [])
  const config = wbConfigFixture()
  config.variants.push({ ...config.variants[0]!, vendorCode: "SECOND", kizMarked: true, wholesale: { enabled: true, quantum: 5 }, documents: { excludeDocuments: true } })
  const result = core.wbPreview(handle, config)
  assert.deepEqual(result.issues, [])
  assert.deepEqual(result.group!.variants.map((variant) => variant.vendorCode), ["ART-7", "SECOND"])
  assert.deepEqual(result.group!.variants[1]!.wholesale, { enabled: true, quantum: 5 })
  const bytes = new Uint8Array(result.uploadBytes!)
  assert.equal(bytes[0], 91); assert.equal(bytes[bytes.length - 1], 93)
  assert.deepEqual(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)), [result.group])
  config.variants[1]!.characteristics = { "300": [" "] }
  const refused = core.wbPreview(handle, config)
  assert.equal(refused.group, null); assert.equal(refused.uploadBytes, null)
  assert.deepEqual(refused.issues.map((issue) => [issue.key.code, issue.variantIndex]), [["blank_text", 1]])
})

test("WB rejects cross-platform, foreign-instance, dropped and restarted handles without HTTP", async () => {
  const core = await wasmCore(), other = await wasmCore()
  const handle = core.loadWbMaterial(wbMaterialFixture())
  const ozon = core.loadSchema({ snapshot: goldenSchema })
  assert.throws(() => core.wbPreview({ platform: "wb", handle: ozon } as WbSchemaHandle, wbConfigFixture()), /different or retired/)
  assert.throws(() => other.wbPreview(handle, wbConfigFixture()), /different or retired/)
  core.dropWbMaterial(handle)
  assert.throws(() => core.wbMetadataIssues(handle), /different or retired/)
  const client = new ListingCoreClient(readFileSync(new URL("../../../../../../wasm/dist/browser/listing-state.wasm", import.meta.url)))
  const old = await client.loadWbMaterial(wbMaterialFixture())
  const original = globalThis.fetch
  let calls = 0
  globalThis.fetch = async () => { calls++; throw new Error("network forbidden") }
  try {
    await client.restart()
    await assert.rejects(client.wbPreview(old, wbConfigFixture()), /different or retired/)
    const fresh = await client.loadWbMaterial(wbMaterialFixture())
    assert.deepEqual((await client.wbPreview(fresh, wbConfigFixture())).issues, [])
    assert.equal(calls, 0)
  } finally { globalThis.fetch = original }
})

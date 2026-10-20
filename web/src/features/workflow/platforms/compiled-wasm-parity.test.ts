import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"
import type { LeanRow, SubmitDraft, KnownIssueKey } from "@/listing-core/types"
import { createListingCore } from "@/listing-core/wasm"
import { golden, goldenSchema, wasmCore } from "../submit/send-test-support"

const native = JSON.parse(readFileSync(new URL("../../../../../rust/crates/listing-core-wasm/tests/fixtures/ambient/ozon-submit-draft-golden.json", import.meta.url), "utf8")) as {
  rowId: string; row: LeanRow; expected: SubmitDraft; manifest: KnownIssueKey[]
}
const manifest = JSON.parse(readFileSync(new URL("../../../../../rust/crates/listing-core-wasm/tests/fixtures/ambient/known-issue-manifest-golden.json", import.meta.url), "utf8")) as KnownIssueKey[]

test("compiled op12 matches native SubmitDraft golden and op13 matches the same producer manifest", async () => {
  const core = await wasmCore()
  assert.deepEqual(core.projectSubmitDraft({ rowId: native.rowId, row: native.row }), native.expected)
  assert.deepEqual(core.issueManifest(), manifest)
  assert.deepEqual(manifest.filter((key) => key.platform === "ozon"), native.manifest, "the Ozon projection golden remains independent")
  const rebuilt = core.submitDraft({ draft: native.expected, card: golden.card })
  assert.deepEqual(rebuilt.draft, native.expected.draft, "op9 still reconstructs a LeanRow")
  assert.deepEqual(rebuilt.validationIssues, [])
  assert.equal(rebuilt.renderEvidence, null)
  const handle = core.loadSchema({ snapshot: goldenSchema })
  const frozen = core.freezeListing(handle, { rowId: golden.rowId, row: golden.row, card: golden.card })
  assert.equal(frozen.status, "frozen", "op11 remains the preview, never a SubmitDraft")
})

test("a WASM trap retires the instance: later calls, schema loads and drops invoke zero exports", () => {
  let calls = 0
  const memory = new WebAssembly.Memory({ initial: 1 })
  const counted = () => { calls++; return 1 }
  const core = createListingCore(Object.freeze({ memory, alloc: counted, free: counted,
    call: () => { calls++; throw new WebAssembly.RuntimeError("unreachable") }, schema_load: counted, schema_drop: counted,
    result_ptr: counted, result_len: counted, drop_result: counted, last_error_ptr: counted, last_error_len: counted,
  }))
  const wb = core.loadWbMaterial({ subjectId: 105, language: "ru", catalog: null, defaults: null })
  assert.throws(() => core.issueManifest(), WebAssembly.RuntimeError)
  const after = calls
  assert.throws(() => core.issueManifest(), WebAssembly.RuntimeError)
  assert.throws(() => core.loadSchema({ snapshot: goldenSchema }), WebAssembly.RuntimeError)
  assert.throws(() => core.dropSchema(1), WebAssembly.RuntimeError)
  assert.throws(() => core.wbPreview(wb, { subjectId: 105, language: "ru", variants: [] }), WebAssembly.RuntimeError)
  assert.throws(() => core.wbMetadataIssues(wb), WebAssembly.RuntimeError)
  assert.throws(() => core.dropWbMaterial(wb), WebAssembly.RuntimeError)
  assert.equal(calls, after)
})

test("explicit restart uses the resident compiled module and invalidates old schema handles without fetch", async () => {
  const { ListingCoreClient } = await import("@/listing-core/client")
  const { createSchemaCache } = await import("../schema-cache")
  const bytes = readFileSync(new URL("../../../../../wasm/dist/browser/listing-state.wasm", import.meta.url))
  const client = new ListingCoreClient(bytes)
  const cache = createSchemaCache(client)
  const identity = { platform: "ozon", coordinate: [1, 2], language: "default", materialDigest: "fixture", defaultsRevision: "1", sessionFence: "fixture" }
  await cache.load(identity, { snapshot: goldenSchema })
  const original = globalThis.fetch
  let fetches = 0
  globalThis.fetch = async () => { fetches++; throw new Error("restart may not fetch") }
  try {
    await client.restart()
    assert.equal(cache.get(identity), undefined)
    await cache.load(identity, { snapshot: goldenSchema })
    assert.equal(fetches, 0)
  } finally { globalThis.fetch = original }
})

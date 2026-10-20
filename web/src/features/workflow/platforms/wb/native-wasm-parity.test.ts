import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { readFileSync } from "node:fs"
import test from "node:test"
import { createListingCore } from "@/listing-core/wasm"
import type { WbIssue, WbMaterial, WbPreview, WbProductConfig } from "@/listing-core/wb-types"

type InputCase = { id: string; material: WbMaterial; config: WbProductConfig }
type ExpectedCase = { id: string; metadataIssues: WbIssue[]; preview: WbPreview }

const fixtures = new URL("../../../../../../rust/crates/listing-core-wasm/tests/fixtures/ambient/", import.meta.url)
// Read-only: missing fixtures and malformed JSON fail; this test has no exporter.
const inputBytes = readFileSync(new URL("wb-preview-input.json", fixtures))
const goldenBytes = readFileSync(new URL("wb-preview-golden.json", fixtures))
const cases = JSON.parse(inputBytes.toString("utf8")) as InputCase[]
const expected = JSON.parse(goldenBytes.toString("utf8")) as ExpectedCase[]
const wasmBytes = readFileSync(new URL("../../../../../../wasm/dist/browser/listing-state.wasm", import.meta.url))
const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex")
const binding = { inputSha256: sha256(inputBytes), nativeGoldenSha256: sha256(goldenBytes), wasmSha256: sha256(wasmBytes) }

assert.equal(cases.length, 8, "keep valid Unicode/zero cases and all refusal families")
assert.equal(new Set(cases.map((item) => item.id)).size, cases.length, "unique shared case identities")
assert.deepEqual(expected.map((item) => item.id), cases.map((item) => item.id), "every case needs a fixed native golden in input order")
assert.deepEqual(new Uint8Array(wasmBytes.subarray(0, 8)), new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]), "use an actual compiled wasm32 module")

for (const [index, input] of cases.entries()) {
  test(`compiled WB op14/op15 match independent native golden: ${input.id}`, async (t) => {
    // Instantiate local compiled bytes directly: no fake exports, host ABI,
    // queue/adapter fixture, HTTP request or JavaScript expected serialization.
    let memory: WebAssembly.Memory | undefined
    const { instance } = await WebAssembly.instantiate(wasmBytes, {
      env: { fill_random: (ptr: number, len: number) => crypto.getRandomValues(new Uint8Array(memory!.buffer, ptr, len)) },
    })
    memory = instance.exports.memory as WebAssembly.Memory
    const core = createListingCore(instance.exports)
    const native = expected[index]!
    const handle = core.loadWbMaterial(input.material)
    try {
      assert.deepEqual(core.wbMetadataIssues(handle), native.metadataIssues, `${input.id}: native metadata coordinates`)
      const preview = core.wbPreview(handle, input.config)
      if (native.preview.uploadBytes === null) {
        assert.equal(preview.uploadBytes, null, `${input.id}: refused upload must have no bytes`)
        assert.equal(preview.group, null, `${input.id}: refused upload must have no partial group`)
        assert.ok(native.preview.issues.length > 0, "refusals retain stage, field and variant/characteristic coordinates")
      } else {
        assert.ok(preview.uploadBytes !== null, `${input.id}: expected a valid upload`)
        const actualBytes = new Uint8Array(preview.uploadBytes)
        const nativeBytes = new Uint8Array(native.preview.uploadBytes)
        // This is the independent byte assertion, not parsed JSON equality
        // with group from the same WASM call and not a hash-only comparison.
        assert.deepEqual(actualBytes, nativeBytes, `${input.id}: every upload byte must match native listing-core`)
        t.diagnostic(JSON.stringify({ caseId: input.id, ...binding, uploadBytes: actualBytes.length, uploadSha256: sha256(actualBytes) }))
      }
      assert.deepEqual(preview, native.preview, `${input.id}: complete native preview, issue stage/field/scope and coordinates`)
      // Reuse the same resident material without loading metadata again.
      assert.deepEqual(core.wbPreview(handle, input.config), native.preview, `${input.id}: resident repeat`)
      t.diagnostic(JSON.stringify({ caseId: input.id, ...binding }))
    } finally {
      core.dropWbMaterial(handle)
    }
  })
}

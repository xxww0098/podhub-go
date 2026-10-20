/** Old TS cases now exercise compiled native rules. No TS validation stages remain. */
import assert from "node:assert/strict"
import test from "node:test"
import { createHash } from "node:crypto"
import { getDiagnosticCopyData, getDiagnosticDetail, setErrorTelemetryContext } from "@/lib/error-telemetry"
import type { PublishDiagnosticReference } from "../../model/publish-diagnostic"
import type { WbIssue, WbProductConfig } from "@/listing-core/wb-types"
import { wasmCore } from "../../submit/send-test-support"
import { createWbAdapter, wbSendCapability, type WbAdapterIssue } from "./adapter"
import { wbConfigFixture, wbMaterialFixture } from "../../../../../tests/publish-pipeline-fixtures"

const describe = (issue: WbAdapterIssue) => ({ ...issue.key, field: issue.characteristicId === null ? issue.field : `characteristic:${issue.characteristicId}`, message: "fixture issue", remediation: "fixture action" })
async function build(config = wbConfigFixture(), material = wbMaterialFixture()) {
  const core = await wasmCore()
  const handle = core.loadWbMaterial(material)
  return createWbAdapter(core, describe).build({ material: () => handle, groups: [{ key: "g1", config }] })
}
async function codes(config = wbConfigFixture(), material = wbMaterialFixture()) {
  return (await build(config, material)).blocked.flatMap((item) => item.issues.map((issue) => issue.code))
}
const variant = (patch: Partial<WbProductConfig["variants"][number]>) => ({ ...wbConfigFixture(), variants: [{ ...wbConfigFixture().variants[0]!, ...patch }] })

test("real WB native bytes remain exact in a held contract diagnostic; known native field problems and disabled send capture zero", async () => {
  const core = await wasmCore(), handle = core.loadWbMaterial(wbMaterialFixture())
  const preview = core.wbPreview(handle, wbConfigFixture())
  assert.ok(preview.group && preview.uploadBytes)
  const exact = new TextDecoder().decode(new Uint8Array(preview.uploadBytes))
  const references: PublishDiagnosticReference[] = []
  const original = globalThis.fetch
  let calls = 0
  setErrorTelemetryContext({ sessionKey: "wb-diagnostic-bytes" })
  globalThis.fetch = async () => { calls++; throw new Error("WB cannot send or report implicitly") }
  try {
    // Fault injection omits only the native group; the evidence is the real op14 byte result.
    const invalid = createWbAdapter({ wbPreview: () => ({ ...preview, group: null }) }, describe, (_key, ref) => references.push(ref))
    await assert.rejects(invalid.build({ material: () => handle, groups: [{ key: "g1", config: wbConfigFixture() }] }), /omitted its upload evidence/)
    assert.equal(references.length, 1)
    const copied = getDiagnosticCopyData(references[0]!.diagnosticId!)
    assert.equal(copied.originalJson, exact)
    assert.equal(copied.provenance, "native_freeze")
    assert.equal(copied.detail.event?.payload_sha256, createHash("sha256").update(exact).digest("hex"))
    assert.equal(copied.detail.event?.code, "contract_violation")
    assert.equal(copied.detail.event?.platform, "wb")
    const known = createWbAdapter(core, describe, (_key, ref) => references.push(ref))
    const built = await known.build({ material: () => handle, groups: [{ key: "g2", config: variant({ characteristics: { "300": [" "] } }) }] })
    assert.ok(built.blocked.some((row) => row.issues.some((entry) => entry.code === "blank_text")))
    assert.equal(references.length, 1, "known native field refusal must not capture")
    assert.equal(Object.hasOwn(wbSendCapability, "send"), false)
    assert.equal(calls, 0)
  } finally { setErrorTelemetryContext({ sessionKey: null }); globalThis.fetch = original; core.dropWbMaterial(handle) }
})

test("an injected native RuntimeError is held with no invented source bytes and never becomes a WB send", async () => {
  const failure = new WebAssembly.RuntimeError("RAW_WASM_EXCEPTION_MUST_NOT_ENTER_DETAILS")
  const refs: PublishDiagnosticReference[] = []
  setErrorTelemetryContext({ sessionKey: "wb-execution-trap" })
  try {
    const adapter = createWbAdapter({ wbPreview() { throw failure } }, describe, (_key, ref) => refs.push(ref))
    await assert.rejects(adapter.build({ material: () => ({ platform: "wb", handle: 1 }), groups: [{ key: "g1", config: wbConfigFixture() }] }), (error) => error === failure)
    assert.equal(refs.length, 1)
    const detail = getDiagnosticDetail(refs[0]!.diagnosticId!)
    assert.equal(detail.event?.code, "wasm_exception")
    assert.equal(detail.event?.payload_sha256, null)
    assert.deepEqual(detail.event?.summary, [])
    assert.equal(detail.originalUnavailableReason, "no_exact_payload")
    assert.doesNotMatch(JSON.stringify(detail), /RAW_WASM_EXCEPTION/)
  } finally { setErrorTelemetryContext({ sessionKey: null }) }
})

test("structured native WB preview issues are classified at the adapter boundary before presentation", async () => {
  const core = await wasmCore(), handle = core.loadWbMaterial(wbMaterialFixture())
  const preview = core.wbPreview(handle, wbConfigFixture())
  const technical: WbIssue = { key: { platform: "wb", stage: "preview", code: "encoding_failed" },
    field: "payload", characteristicId: null, variantIndex: null, scope: "group" }
  const references: PublishDiagnosticReference[] = []
  const original = globalThis.fetch
  let calls = 0
  globalThis.fetch = async () => { calls++; throw new Error("local WB diagnostics stay held") }
  setErrorTelemetryContext({ sessionKey: "wb-structured-preview-issue" })
  try {
    // Inject one structured refusal into real compiled output; keep the native positive above intact.
    const adapter = createWbAdapter({ wbPreview: () => ({ ...preview, group: null, uploadBytes: null, issues: [technical] }) },
      describe, (_key, ref) => references.push(ref))
    const built = await adapter.build({ material: () => handle, groups: [{ key: "g1", config: wbConfigFixture() }] })
    assert.deepEqual(built.frozen, [])
    assert.equal(built.blocked[0]!.issues[0]!.code, "encoding_failed")
    assert.equal(references.length, 1)
    const detail = getDiagnosticDetail(references[0]!.diagnosticId!)
    assert.equal(detail.event?.code, "contract_violation")
    assert.equal(detail.event?.platform, "wb")
    assert.equal(detail.event?.stage, "preview")
    assert.equal(detail.event?.payload_sha256, null)
    assert.deepEqual(detail.event?.summary, [])
    assert.equal(calls, 0)
  } finally { setErrorTelemetryContext({ sessionKey: null }); globalThis.fetch = original; core.dropWbMaterial(handle) }
})

test("a complete variant builds the native CardGroup with defaults and manual values without inventing provenance", async () => {
  const built = await build()
  assert.deepEqual(built.blocked, [])
  const frozen = built.frozen[0]!
  assert.deepEqual(frozen.body.group, { subjectID: 105, variants: [{ vendorCode: "ART-7", title: "  Постер  ", brand: " ", characteristics: [
    { id: 100, value: ["red"] }, { id: 200, value: 5 }, { id: 300, value: ["хлопок"] },
  ] }] }, "native named fields preserve input whitespace; no filename fallback")
  assert.deepEqual(JSON.parse(new TextDecoder().decode(new Uint8Array(frozen.body.uploadBytes))), [frozen.body.group])
  assert.deepEqual(frozen.provenance, [], "op14 does not emit provenance; do not manufacture it")
  assert.ok(Object.isFrozen(frozen.body.group.variants[0]))
  assert.equal((await build()).frozen[0]!.digest, frozen.digest)
  assert.match(frozen.digest, /^sha256:[0-9a-f]{64}$/)
})

test("partial defaults do not satisfy a create-required characteristic", async () => {
  assert.deepEqual(await codes(variant({ characteristics: {} })), ["required"])
})

test("an explicit clear suppresses default and manual; clearing a required one is refused", async () => {
  const built = await build(variant({ cleared: [200], characteristics: { "200": 7, "300": ["a"] } }))
  assert.deepEqual(built.frozen[0]!.body.group.variants[0]!.characteristics!.map((entry) => entry.id), [100, 300])
  assert.deepEqual(await codes(variant({ cleared: [100] })), ["required"], "Rust clear wins; old clear_conflict is retired")
})

test("characteristic values are checked by native types, ids, blank text and maxCount", async () => {
  const cases: Array<[WbProductConfig["variants"][number]["characteristics"], string]> = [
    [{ "300": ["хлопок", "  "] }, "blank_text"],
    [{ "300": ["a"], "100": ["a", "b", "c"] }, "max_count"],
    [{ "300": ["a"], "999": ["x"] }, "unknown_characteristic"],
    [{ "300": ["a"], "400": ["x"] }, "value_type"],
    [{ "300": ["a"], "200": ["5"] }, "value_type"],
    [{ "300": ["a"], "0": ["x"] }, "unknown_characteristic"],
  ]
  for (const [fields, code] of cases) assert.deepEqual(await codes(variant({ characteristics: structuredClone(fields) })), [code])
  await assert.rejects(build(variant({ characteristics: { "300": "scalar" } as never })), /CORE|decode|untagged|variant/i, "scalar text cannot decode to native FieldValue")
  const issue = (await build(variant({ characteristics: { "300": ["a"], "200": ["5"] } }))).blocked[0]!.issues[0]!
  assert.deepEqual([issue.platform, issue.stage, issue.field], ["wb", "validate", "characteristic:200"])
})

test("nonfinite numbers and unsafe ids fail before JSON can lose their meaning", async () => {
  for (const value of [NaN, Infinity, -Infinity, 2 ** 53]) {
    await assert.rejects(build(variant({ characteristics: { "300": ["a"], "200": value } })), /without loss/)
  }
  await assert.rejects(build(variant({ characteristics: { "300": ["a"], "9007199254740993": ["x"] } })), /precision/)
})

test("a default with a bad value keeps the native material scope and characteristic identity", async () => {
  const core = await wasmCore(), material = wbMaterialFixture()
  material.defaults!.values["200"] = []
  const issues = core.wbMetadataIssues(core.loadWbMaterial(material))
  assert.deepEqual(issues.map((issue) => [issue.key.stage, issue.key.code, issue.scope, issue.characteristicId]), [["validate", "value_type", "material", 200]])
})

test("catalog coordinate and Cloud usability replace the retired browser 72 h clock rule", async () => {
  const material = wbMaterialFixture()
  material.catalog!.usable = false
  assert.deepEqual(await codes(wbConfigFixture(), material), ["catalog_stale"])
  assert.deepEqual(await codes(wbConfigFixture(), { ...material, catalog: null }), ["catalog_unavailable"])
  assert.deepEqual(await codes({ ...wbConfigFixture(), language: "en" }), ["coordinate_mismatch"])
  assert.deepEqual(await codes({ ...wbConfigFixture(), subjectId: 106 }), ["coordinate_mismatch"])
  await assert.rejects(build({ ...wbConfigFixture(), subjectId: 2 ** 53 }), /without loss/)
})

test("defaults are usable only against the exact catalog digest they were validated with", async () => {
  const material = wbMaterialFixture()
  material.defaults!.validatedCatalogDigest = "old"
  assert.deepEqual(await codes(wbConfigFixture(), material), ["defaults_stale"])
  assert.equal((await build(variant({ characteristics: { "100": ["blue"], "300": ["a"] } }), { ...material, defaults: null })).frozen.length, 1)
})

test("vendorCode and title limits count Unicode scalars, like Rust chars()", async () => {
  assert.equal((await build(variant({ vendorCode: "😀".repeat(72), title: "😀".repeat(60) }))).frozen.length, 1)
  assert.deepEqual(await codes(variant({ vendorCode: "😀".repeat(73) })), ["vendor_code_too_long"])
  assert.deepEqual(await codes(variant({ title: "x".repeat(61) })), ["title_too_long"])
  assert.deepEqual(await codes(variant({ vendorCode: "" })), ["vendor_code_required"])
  await assert.rejects(build(variant({ vendorCode: "A\uD800" })), /surrogate/)
})

test("dimensions stay native cm/kg and sizes refuse unsafe prices instead of rounding", async () => {
  const dimensions = { length: 30, width: 20, height: 2, weightBrutto: 0.45 }
  const sizes = [{ techSize: " 0 ", price: 1990, skus: [" 2000000000001 "] }]
  const built = await build(variant({ dimensions, sizes }))
  assert.deepEqual(built.frozen[0]!.body.group.variants[0]!.dimensions, dimensions)
  assert.deepEqual(built.frozen[0]!.body.group.variants[0]!.sizes, sizes, "no TS whitespace rewrite")
  assert.deepEqual(await codes(variant({ dimensions: { weightBrutto: -1 } })), ["invalid_dimensions"])
  await assert.rejects(build(variant({ dimensions: { width: 1.5 } })), /invalid type|u32/i)
  await assert.rejects(build(variant({ sizes: [{ price: 2 ** 53 }] })), /without loss/)
  assert.equal((await build(variant({ dimensions: { length: 0, weightBrutto: 0 } }))).frozen.length, 1, "native accepts zero; browser must not add a positive-only rule")
})

test("one native group holds 1..30 variants and its exact UTF-8 upload is at most 10 MiB", async () => {
  assert.deepEqual(await codes({ ...wbConfigFixture(), variants: [] }), ["variant_count"])
  const variants = Array.from({ length: 31 }, (_, i) => ({ ...wbConfigFixture().variants[0]!, vendorCode: `V${i}` }))
  assert.deepEqual(await codes({ ...wbConfigFixture(), variants }), ["variant_count"])
  assert.equal((await build({ ...wbConfigFixture(), variants: variants.slice(0, 30) })).frozen.length, 1)
  assert.deepEqual(await codes(variant({ description: "ж".repeat(5 * 1024 * 1024 + 1) })), ["upload_too_large"])
})

test("independent preview records are not a fake 100-group upload or cross-group vendor-code rule", async () => {
  const core = await wasmCore(), handle = core.loadWbMaterial(wbMaterialFixture())
  const adapter = createWbAdapter(core, describe)
  const groups = Array.from({ length: 101 }, (_, i) => ({ key: `g${i}`, config: wbConfigFixture() }))
  const result = await adapter.build({ material: () => handle, groups })
  assert.equal(result.frozen.length, 101, "each preview has exactly one native group; no real WB upload exists")
  assert.deepEqual(result.blocked, [])
  assert.deepEqual(await adapter.build({ material: () => handle, groups: [] }), { frozen: [], blocked: [] })
})

test("operator changes to one named field do not replace native validation or sibling defaults", async () => {
  const result = await build(variant({ vendorCode: "ART-7".toLowerCase() }))
  assert.equal(result.frozen[0]!.body.group.variants[0]!.vendorCode, "art-7")
  assert.deepEqual(result.frozen[0]!.body.group.variants[0]!.characteristics!.map((item) => item.id), [100, 200, 300])
  assert.deepEqual(await codes(variant({ characteristics: { "300": ["a"], "400": ["x"] } })), ["value_type"])
})

test("build and disabled WB capability make no network call", async () => {
  const core = await wasmCore(), handle = core.loadWbMaterial(wbMaterialFixture())
  const original = globalThis.fetch
  let calls = 0
  globalThis.fetch = async () => { calls++; throw new Error("network forbidden") }
  try {
    assert.equal((await createWbAdapter(core, describe).build({ material: () => handle, groups: [{ key: "g1", config: wbConfigFixture() }] })).frozen.length, 1)
    assert.deepEqual(wbSendCapability, { enabled: false, platform: "wb", stage: "send", code: "not_enabled" })
    assert.equal(calls, 0)
  } finally { globalThis.fetch = original }
})

test("unusable catalog digest or metadata is refused, never treated as fresh", async () => {
  const material = wbMaterialFixture()
  material.catalog!.contentDigest = ""
  assert.ok((await codes(wbConfigFixture(), material)).includes("catalog_invalid"))
  material.catalog!.fields.push(material.catalog!.fields[0]!)
  assert.ok((await codes(wbConfigFixture(), material)).includes("catalog_invalid"))
  material.catalog!.fields[0]!.maxCount = -1
  await assert.rejects(build(wbConfigFixture(), material), /invalid value|u32/i)
  const nonfinite = wbMaterialFixture()
  nonfinite.catalog!.fields[0]!.valueKind = NaN
  await assert.rejects(build(wbConfigFixture(), nonfinite), /without loss/)
  const opaqueDigest = wbMaterialFixture()
  opaqueDigest.catalog!.contentDigest = "sha256:not-hex"
  opaqueDigest.defaults!.validatedCatalogDigest = "sha256:not-hex"
  assert.deepEqual(await codes(wbConfigFixture(), opaqueDigest), [], "native treats nonempty matching digests as opaque; no TS digest-format rule")
})

test("defaults need a saved revision (>= 1), checked by native metadata", async () => {
  for (const revision of [0, -1]) {
    const material = wbMaterialFixture(); material.defaults!.revision = revision
    assert.deepEqual(await codes(wbConfigFixture(), material), ["defaults_stale"])
  }
  const material = wbMaterialFixture(); material.defaults!.revision = 1.5
  await assert.rejects(build(wbConfigFixture(), material), /invalid type|i64/i)
  material.defaults!.revision = NaN
  await assert.rejects(build(wbConfigFixture(), material), /without loss/)
})

test("clearing a characteristic outside the catalog preserves native issue coordinates", async () => {
  const core = await wasmCore(), handle = core.loadWbMaterial(wbMaterialFixture())
  const result = core.wbPreview(handle, variant({ cleared: [999] }))
  assert.deepEqual(result.issues.map((issue) => [issue.key.stage, issue.characteristicId, issue.variantIndex, issue.key.code]), [["validate", 999, 0, "unknown_characteristic"]])
  assert.equal(result.group, null); assert.equal(result.uploadBytes, null)
  assert.equal((await build(variant({ cleared: [200] }))).frozen.length, 1)
})

test("every group sharing a key is refused once while independent valid preview records still build", async () => {
  const core = await wasmCore(), handle = core.loadWbMaterial(wbMaterialFixture())
  const built = await createWbAdapter(core, describe).build({ material: () => handle,
    groups: ["g1", "g2", "g1", " g3"].map((key) => ({ key, config: wbConfigFixture() })) })
  assert.deepEqual(built.frozen.map((item) => item.key), ["g2"])
  assert.deepEqual(built.blocked.map((item) => [item.key, item.issues[0]!.code]), [["g1", "group_key_invalid"], [" g3", "group_key_invalid"]])
  const blank = await createWbAdapter(core, describe).build({ material: () => handle, groups: [{ key: "", config: wbConfigFixture() }] })
  assert.equal(blank.frozen.length, 0)
  assert.equal(blank.blocked[0]!.issues[0]!.code, "group_key_invalid")
})

test("lone surrogates never reach native String fields of sizes", async () => {
  for (const size of [{ techSize: "S\uD800" }, { wbSize: "\uDC00" }, { skus: ["200\uD800"] }]) {
    await assert.rejects(build(variant({ sizes: [size] })), /surrogate/)
  }
})

test("one characteristic can be edited without changing its same-type sibling; native checks every edit", async () => {
  const result = await build(variant({ characteristics: { "100": ["RED"], "300": ["хлопок"] } }))
  assert.deepEqual(result.frozen[0]!.body.group.variants[0]!.characteristics, [{ id: 100, value: ["RED"] }, { id: 200, value: 5 }, { id: 300, value: ["хлопок"] }])
  assert.deepEqual(await codes(variant({ characteristics: { "300": 42 } })), ["value_type"])
  assert.deepEqual(await codes(variant({ characteristics: { "300": ["a"], "999": ["x"] } })), ["unknown_characteristic"])
})

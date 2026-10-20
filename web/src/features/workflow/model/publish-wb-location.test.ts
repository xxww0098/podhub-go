import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"
import { createListingCore } from "@/listing-core/wasm"
import type { WbIssue, WbMaterial, WbPreview, WbProductConfig } from "@/listing-core/wb-types"
import { openCardRows } from "../rows/card-rows"
import { memoryRowRepo } from "../rows/row-repo"
import { wbPublishProblem } from "../platforms/wb/publish-problem"
import { wbCoordinateConfigFixture, wbMaterialFixture } from "../../../../tests/publish-pipeline-fixtures"
import { resolvePublishRemediation } from "./publish-remediation"
import type { PublishProblem } from "./publish-problem"
import { contractSolution } from "./publish-solutions-controls"

type InputCase = { id: string; material: WbMaterial; config: WbProductConfig }
type ExpectedCase = { id: string; metadataIssues: WbIssue[]; preview: WbPreview }
const fixtures = new URL("../../../../../rust/crates/listing-core-wasm/tests/fixtures/ambient/", import.meta.url)
const inputs = JSON.parse(readFileSync(new URL("wb-preview-input.json", fixtures), "utf8")) as InputCase[]
const goldens = JSON.parse(readFileSync(new URL("wb-preview-golden.json", fixtures), "utf8")) as ExpectedCase[]
async function nativeCore() {
  const bytes = readFileSync(new URL("../../../../../wasm/dist/browser/listing-state.wasm", import.meta.url))
  let memory: WebAssembly.Memory | undefined
  const { instance } = await WebAssembly.instantiate(bytes, {
    env: { fill_random: (ptr: number, len: number) => crypto.getRandomValues(new Uint8Array(memory!.buffer, ptr, len)) },
  })
  memory = instance.exports.memory as WebAssembly.Memory
  return createListingCore(instance.exports)
}
const view = (issue: WbIssue, config: WbProductConfig, recordId = "group-27") =>
  resolvePublishRemediation(wbPublishProblem(issue, { recordId, variantCount: config.variants.length }))!

test("WB independent native golden locations survive canonical normalization unchanged", async () => {
  const core = await nativeCore()
  assert.equal(inputs.length, 8)
  assert.deepEqual(goldens.map((entry) => entry.id), inputs.map((entry) => entry.id))
  for (const [index, input] of inputs.entries()) {
    const handle = core.loadWbMaterial(input.material)
    try {
      assert.deepEqual(core.wbMetadataIssues(handle), goldens[index]!.metadataIssues)
      const preview = core.wbPreview(handle, input.config)
      assert.deepEqual(preview, goldens[index]!.preview, "keep the independent full native/compiled-WASM golden")
      for (const issue of preview.issues) {
        const problem = wbPublishProblem(issue, { recordId: "group-27", variantCount: input.config.variants.length })
        assert.deepEqual(problem.location, { platform: "wb", recordId: "group-27", variantCount: input.config.variants.length,
          field: issue.field, scope: issue.scope, characteristicId: issue.characteristicId, variantIndex: issue.variantIndex })
        const remediation = resolvePublishRemediation(problem)!
        assert.equal(remediation.cause, "structured_issue")
        assert.match(remediation.scope, /商品组 group-27/)
        assert.doesNotMatch(remediation.scope, /仅此商品行/)
        if (issue.variantIndex !== null) assert.ok(remediation.scope.includes(`第 ${issue.variantIndex + 1} 个变体`))
        else assert.doesNotMatch(remediation.scope, /第 \d+ 个变体/)
        if (issue.characteristicId !== null) assert.ok(remediation.scope.includes(`characteristic ${issue.characteristicId}`))
        assert.equal(remediation.action, undefined)
      }
    } finally { core.dropWbMaterial(handle) }
  }
})

test("WB second-only native refusal survives CardRows persistence and reload without blaming variant one", async () => {
  const input = inputs.find((entry) => entry.id === "blank-text-variant-coordinate")!
  const core = await nativeCore(), handle = core.loadWbMaterial(input.material)
  const repo = memoryRowRepo(), scope = { workspaceUuid: "wb-coordinates", cardId: "card" }
  const writer = async () => ({ writable: true, onChange: () => () => {}, release() {} })
  const rows = await openCardRows(repo, scope, writer)
  try {
    rows.wb.create("original-group", input.config)
    const captured = rows.wb.get("original-group")!
    const preview = core.wbPreview(handle, captured.config)
    assert.deepEqual(preview, goldens.find((entry) => entry.id === input.id)!.preview)
    assert.equal(rows.wb.settle(captured.id, captured.rev, preview), true)
    await rows.flush(); await rows.close()
    const reloaded = await openCardRows(repo, scope, writer)
    try {
      const record = reloaded.wb.get(captured.id)!
      assert.deepEqual(record.preview, preview)
      const remediation = view(record.preview!.issues[0]!, record.config, record.id)
      assert.match(remediation.scope, /商品组 original-group.*第 2 个变体.*characteristic 7/)
      assert.match(remediation.steps[0]!, /第 2 个变体.*characteristic 7/)
      assert.doesNotMatch(remediation.scope, /第 1 个变体|仅此商品行/)
      assert.equal(remediation.reportable, false)
      assert.equal(remediation.diagnosticCode, null)
      assert.equal(remediation.action, undefined)
    } finally { await reloaded.close() }
  } finally { await rows.close(); core.dropWbMaterial(handle) }
})

test("WB both failing variants retain separate original indices for the same characteristic", async () => {
  const core = await nativeCore(), handle = core.loadWbMaterial(wbMaterialFixture())
  try {
    const config = wbCoordinateConfigFixture("both"), preview = core.wbPreview(handle, config)
    assert.deepEqual(preview.issues.map((issue) => [issue.scope, issue.variantIndex, issue.characteristicId]),
      [["variant", 0, 100], ["variant", 1, 100]])
    const views = preview.issues.map((issue) => view(issue, config))
    assert.match(views[0]!.scope, /第 1 个变体.*原生序号 0.*characteristic 100/)
    assert.match(views[1]!.scope, /第 2 个变体.*原生序号 1.*characteristic 100/)
    assert.notEqual(views[0]!.steps[0], views[1]!.steps[0])
  } finally { core.dropWbMaterial(handle) }
})

test("WB native material defaults, whole-group and named-variant issues have distinct scopes", async () => {
  const core = await nativeCore(), material = wbMaterialFixture()
  material.defaults!.values["100"] = [" "]
  const handle = core.loadWbMaterial(material), config = wbCoordinateConfigFixture("valid")
  try {
    const issue = core.wbPreview(handle, config).issues[0]!
    assert.deepEqual([issue.key.stage, issue.key.code, issue.scope, issue.variantIndex, issue.characteristicId],
      ["validate", "blank_text", "material", null, 100])
    const remediation = view(issue, config)
    assert.match(remediation.scope, /所用 WB 类目材料.*共用该材料.*characteristic 100/)
    assert.doesNotMatch(remediation.scope, /第 \d+ 个变体|仅此商品行/)
    assert.match(remediation.steps[0]!, /类目或方案默认字段入口/)
  } finally { core.dropWbMaterial(handle) }
  const valid = core.loadWbMaterial(wbMaterialFixture())
  try {
    for (const sample of ["group", "variant"] as const) {
      const input = wbCoordinateConfigFixture(sample), issue = core.wbPreview(valid, input).issues[0]!
      const remediation = view(issue, input)
      if (sample === "group") {
        assert.equal(issue.scope, "group"); assert.equal(issue.variantIndex, null)
        assert.match(remediation.scope, /商品组 group-27 整组.*subject/)
        assert.doesNotMatch(remediation.scope, /第 \d+ 个变体/)
      } else {
        assert.equal(issue.scope, "variant"); assert.equal(issue.variantIndex, 1)
        assert.match(remediation.scope, /第 2 个变体.*货号 vendorCode/)
      }
    }
  } finally { core.dropWbMaterial(valid) }
})

test("WB invalid external coordinates and unknown keys are actionless contract errors without false row targets", async () => {
  const core = await nativeCore(), handle = core.loadWbMaterial(wbMaterialFixture())
  try {
    const config = wbCoordinateConfigFixture("second-only")
    const problem = wbPublishProblem(core.wbPreview(handle, config).issues[0]!, { recordId: "safe-group", variantCount: 2 })
    const invalid: unknown[] = [null, "raw-coordinate", { ...problem.location, scope: "row" },
      ...[null, -1, 2, 0.5, Infinity, Number.MAX_SAFE_INTEGER, "1"].map((variantIndex) => ({ ...problem.location, variantIndex })),
      ...[0, -1, NaN, "2"].map((variantCount) => ({ ...problem.location, variantCount })),
      ...[null, Infinity, 1.5, Number.MAX_SAFE_INTEGER + 1, "100"].map((characteristicId) => ({ ...problem.location, characteristicId })),
      { ...problem.location, scope: "material", variantIndex: 0 }, { ...problem.location, scope: "group", variantIndex: 1 },
      { ...problem.location, field: "credential=raw-secret" }, { ...problem.location, recordId: "credential=raw-secret" },
      { ...problem.location, recordId: "x".repeat(129) }, { ...problem.location, platform: "ozon" },
    ]
    for (const location of invalid) {
      const result = resolvePublishRemediation({ ...problem, location } as PublishProblem)!
      assert.equal(result.cause, "contract_invalid")
      assert.equal(result.reason, contractSolution.reason)
      assert.equal(result.action, undefined)
      assert.match(result.scope, /尚未定位到商品组、变体或特征/)
      assert.doesNotMatch(result.scope + result.steps.join(""), /safe-group|第 \d+ 个变体|仅此商品行|raw-secret/)
    }
    for (const key of [{ code: "future_rule" }, { stage: "submit" }, { platform: "other" }, { family: "control", code: "not_enabled" }]) {
      const result = resolvePublishRemediation({ ...problem, ...key } as PublishProblem)!
      assert.equal(result.cause, "contract_invalid")
      assert.doesNotMatch(result.scope, /safe-group|第 \d+ 个变体|仅此商品行/)
      assert.equal(result.action, undefined)
    }
  } finally { core.dropWbMaterial(handle) }
})

test("WB native unknown signed characteristic IDs are preserved without inventing field rules", async () => {
  const core = await nativeCore(), handle = core.loadWbMaterial(wbMaterialFixture())
  try {
    const config = wbCoordinateConfigFixture("valid")
    config.variants[1]!.characteristics!["-7"] = ["Fixture"]
    const issue = core.wbPreview(handle, config).issues[0]!
    assert.equal(issue.key.code, "unknown_characteristic")
    assert.equal(issue.characteristicId, -7)
    assert.match(view(issue, config).scope, /第 2 个变体.*characteristic -7/)
  } finally { core.dropWbMaterial(handle) }
})

test("WB record identity issues never interpolate invalid identifiers or fabricate a variant", () => {
  const problem = wbPublishProblem({ key: { platform: "wb", stage: "identity", code: "group_key_invalid" },
    field: "record_id", characteristicId: null, variantIndex: null, scope: "record" },
  { recordId: "credential=raw-secret", variantCount: 2 })
  const result = resolvePublishRemediation(problem)!
  assert.equal(result.cause, "structured_issue")
  assert.match(result.scope, /商品组无法唯一定位/)
  assert.doesNotMatch(result.scope + result.steps.join(""), /raw-secret|第 \d+ 个变体|仅此商品行/)
  assert.equal(result.action, undefined)
})

test("Ozon and WB control presentations keep their existing scopes and manual actions", () => {
  const ozon = resolvePublishRemediation({ platform: "ozon", stage: "validate", code: "required", field: "attribute_123" })!
  assert.equal(ozon.scope, "Ozon · 字段校验；仅此商品行；字段 attribute_123")
  const disabled = resolvePublishRemediation({ platform: "wb", stage: "submit", family: "control", code: "not_enabled" })!
  assert.equal(disabled.scope, "WB · 发送；仅此商品行")
  assert.equal(disabled.action, undefined)
  assert.equal(disabled.reportable, false)
  assert.match(disabled.steps.join(""), /不会转发到其它平台或自动重试/)
})

test("WB missing native location and unknown bare keys never fabricate a row or first variant", () => {
  const known = resolvePublishRemediation({ platform: "wb", stage: "validate", code: "blank_text", field: "characteristic" })!
  assert.equal(known.cause, "structured_issue")
  assert.match(known.scope, /未提供完整商品组位置/)
  assert.match(known.steps[0]!, /重新载入原 WB 预览记录并明确校验/)
  assert.doesNotMatch(known.scope, /仅此商品行|第 \d+ 个变体/)
  const unknown = resolvePublishRemediation({ platform: "wb", stage: "validate", code: "future-rule=raw-secret", field: "unsafe-target", traceId: "same-trace" })!
  assert.equal(unknown.cause, "contract_invalid")
  assert.equal(unknown.traceId, "same-trace")
  assert.doesNotMatch(unknown.scope + unknown.steps.join(""), /raw-secret|unsafe-target|仅此商品行|第 \d+ 个变体/)
  assert.equal(unknown.action, undefined)
})

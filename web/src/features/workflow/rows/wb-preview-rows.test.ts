import assert from "node:assert/strict"
import test from "node:test"
import { openCardRows } from "./card-rows"
import { memoryRowRepo } from "./row-repo"
import { wbConfigFixture, wbMaterialFixture } from "../../../../tests/publish-pipeline-fixtures"
import { wasmCore } from "../submit/send-test-support"

const scope = { workspaceUuid: "w", cardId: "c" }
const writer = async () => ({ writable: true, onChange: () => () => {}, release() {} })

test("WB records persist through the CardRows writer with revision CAS and no Store/Intent fields", async () => {
  const repo = memoryRowRepo(), rows = await openCardRows(repo, scope, writer)
  const core = await wasmCore(), handle = core.loadWbMaterial(wbMaterialFixture())
  rows.wb.create("g1", wbConfigFixture())
  const captured = rows.wb.get("g1")!
  const preview = core.wbPreview(handle, captured.config)
  assert.equal(rows.wb.edit("g1", captured.rev, { ...captured.config, variants: [{ ...captured.config.variants[0]!, vendorCode: "NEW" }] }), true)
  assert.equal(rows.wb.settle("g1", captured.rev, preview), false, "late native result loses CAS")
  const current = rows.wb.get("g1")!
  assert.equal(rows.wb.settle("g1", current.rev, core.wbPreview(handle, current.config)), true)
  await rows.flush()
  const stored = await repo.wbPreviewsOfCard("w", "c")
  assert.equal(stored[0]!.preview!.group!.variants[0]!.vendorCode, "NEW")
  assert.equal("submission" in stored[0]!, false); assert.equal("storeId" in stored[0]!, false)
  assert.deepEqual(await repo.rowsOfCard("w", "c"), [])
  const detached = rows.wb.get("g1")!; detached.config.variants[0]!.vendorCode = "MUTATED"
  assert.equal(rows.wb.get("g1")!.config.variants[0]!.vendorCode, "NEW")
  await rows.close()
  assert.throws(() => rows.wb.edit("g1", current.rev, wbConfigFixture()), /closing or closed/)
  const reopened = await openCardRows(repo, scope, writer)
  assert.deepEqual(reopened.wb.all(), stored)
  reopened.wb.remove("g1")
  assert.equal(reopened.wb.settle("g1", stored[0]!.rev, preview), false)
  await reopened.close()
  assert.deepEqual(await repo.wbPreviewsOfCard("w", "c"), [])
})

test("WB records reuse the same lock, workspace/card isolation and failed-flush retry", async () => {
  const repo = memoryRowRepo()
  const rows = await openCardRows(repo, scope, writer)
  rows.wb.create("g1", wbConfigFixture())
  const put = repo.putWbPreviews
  repo.putWbPreviews = async () => { throw new Error("quota") }
  await assert.rejects(rows.flush(), /quota/)
  assert.ok(rows.error)
  repo.putWbPreviews = put
  await rows.flush()
  assert.equal(rows.error, undefined)
  assert.deepEqual(await repo.wbPreviewsOfCard("other", "c"), [])
  assert.deepEqual(await repo.wbPreviewsOfCard("w", "other"), [])
  const reader = await openCardRows(repo, scope, async () => ({ writable: false, onChange: () => () => {}, release() {} }))
  assert.equal(reader.wb.all().length, 1)
  assert.throws(() => reader.wb.create("g2", wbConfigFixture()), /read-only/)
  assert.throws(() => reader.wb.remove("g1"), /read-only/)
  await reader.close(); await rows.close()
})

test("WB record recreation and account-generation changes fence captured previews", async () => {
  let current = true
  const rows = await openCardRows(memoryRowRepo(), scope, writer, () => current)
  const core = await wasmCore(), handle = core.loadWbMaterial(wbMaterialFixture())
  rows.wb.create("g1", wbConfigFixture())
  const captured = rows.wb.get("g1")!
  const preview = core.wbPreview(handle, captured.config)
  rows.wb.remove("g1")
  rows.wb.create("g1", wbConfigFixture())
  assert.equal(rows.wb.settle("g1", captured.rev, preview), false)
  const next = rows.wb.get("g1")!
  current = false
  assert.equal(rows.writable, false)
  assert.equal(rows.wb.get("g1"), undefined)
  assert.throws(() => rows.wb.settle("g1", next.rev, preview), /read-only/)
  await rows.close()
})

import assert from "node:assert/strict"
import test from "node:test"
import { createMozaAutomation, type MozaAutomationContext } from "./moza-automation"

const marker = { nonce: "a".repeat(64), cardId: "card-1" }
const command = { ...marker, rowId: "draft-1", storeId: "store-1", sha256: "b".repeat(64), fileName: "item.png", action: "prepare" as const }

function fixture() {
  const calls: string[][] = []
  const targets: Array<{ rowId: string; storeId: string; sha256: string; fileName: string }> = []
  const row = { id: "view-1", draftId: "draft-1", source: { handle: `${command.sha256}/${command.fileName}` }, candidates: [],
    readiness: { can_start_publish_attempt: true, allowed_actions: ["publish"] }, log: "" }
  const product = { parent_card_id: marker.cardId, target_store_id: "store-1", lifecycle: { stage: "ready_to_publish", ai_candidates: [] } }
  const workbench = { cardId: marker.cardId, rows: [row], productDrafts: { "draft-1": product } } as unknown as ReturnType<MozaAutomationContext["workbench"]>
  const context: MozaAutomationContext = { active: true, cardId: marker.cardId, busy: false, templateReady: true,
    storeConfigured: true, workbench: () => workbench,
    prepare: async (ids) => { calls.push(["prepare", ...ids]) }, send: async (ids, target) => { calls.push(["send", ...ids]); targets.push(target) } }
  return { row, product, workbench, context, calls, targets, run: createMozaAutomation(marker, () => context) }
}

test("automation acts on exactly the named product and its bound store", async () => {
  const f = fixture()
  const status = await f.run({ ...command, action: "status" }) as { rowId: string; sourceAvailable: boolean }
  assert.deepEqual([status.rowId, status.sourceAvailable], ["draft-1", true])
  await f.run(command)
  await f.run({ ...command, action: "send" })
  assert.deepEqual(f.calls, [["prepare", "view-1"], ["send", "view-1"]])
  assert.deepEqual(f.targets, [{ rowId: command.rowId, storeId: command.storeId, sha256: command.sha256, fileName: command.fileName }])
})

test("automation refuses changed identity, card, store, template and uncertain products", async () => {
  const f = fixture()
  await assert.rejects(f.run({ ...command, nonce: "wrong" }), /身份无效/)
  await assert.rejects(f.run({ ...command, cardId: "other" }), /身份无效/)
  await assert.rejects(f.run({ ...command, rowId: "other" }), /不属于/)
  await assert.rejects(f.run({ ...command, storeId: "other" }), /店铺已变化/)
  f.context.templateReady = false
  await assert.rejects(f.run(command), /缺少 PSD/)
  f.context.templateReady = true
  f.product.lifecycle.stage = "outcome_unknown"
  await assert.rejects(f.run(command), /已有发送记录/)
  await assert.rejects(f.run({ ...command, action: "send" }), /尚未满足/)
  f.product.lifecycle.stage = "ready_to_publish"
  ;(f.product.lifecycle.ai_candidates as Array<{ state: string }>).push({ state: "proposed" })
  await assert.rejects(f.run({ ...command, action: "send" }), /尚未满足/)
  assert.deepEqual(f.calls, [])
})

test("automation serializes operations and allows status reads during preparation", async () => {
  const f = fixture()
  let finish!: () => void
  f.context.prepare = async () => await new Promise<void>((resolve) => { finish = resolve })
  const first = f.run(command)
  await assert.rejects(f.run({ ...command, action: "send" }), /正在执行/)
  assert.equal((await f.run({ ...command, action: "status" }) as { rowId: string }).rowId, "draft-1")
  finish()
  await first
})

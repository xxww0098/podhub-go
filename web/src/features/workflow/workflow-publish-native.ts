import { ListingCoreClient } from "@/listing-core/client"
import { commandErrorCode } from "@/lib/error-message"
import { cachedMaterial } from "@/bindings/listing-material-cache"
import type { ListingCardView, ListingRowView } from "@/bindings/listing-projection"
import { cardPayload } from "@/bindings/listing-projection"
import { refuse } from "@/bindings/refusal"
import { nativeRow } from "./submit/send-local"
import { clearBrandSearchTags } from "./brand-repair"
import { captureWorkbenchPublishProblem } from "./workbench/publish-diagnostic-producer"

/** One explicit action owns its schema handle. No metadata fetch and no trap retry. */
export function createWorkflowPublishNative(makeCore = () => new ListingCoreClient(new URL("../../../../wasm/dist/browser/listing-state.wasm", import.meta.url).href)) {
  let resident: ListingCoreClient | undefined
  let retired = false
  async function run(row: ListingRowView, card: ListingCardView, current: () => boolean, repair: boolean) {
    const parsed = nativeRow(row)
    if ("refusal" in parsed) throw parsed.refusal.error
    const input = parsed.row
    const recipe = cardPayload(card)
    const material = cachedMaterial({ descriptionCategoryId: input.descriptionCategoryId, typeId: input.typeId, language: input.language })
    if (!material || material.input.snapshot.schema_revision !== input.schemaRevision) {
      throw refuse("workflow_repair_schema_missing", "本行原生类目材料缺失或已过期；请从类目入口明确刷新，再重新修复")
    }
    const check = () => {
      if (!current() || cachedMaterial({ descriptionCategoryId: input.descriptionCategoryId, typeId: input.typeId, language: input.language }) !== material) {
        throw refuse("workflow_repair_stale", "商品、权限或类目版本已变化，本次修复已停止；请重新核对")
      }
    }
    check()
    const core = resident ??= makeCore()
    let handle: number | undefined
    let poisoned = false
    try {
      if (retired) {
        // Only this new explicit action reinstantiates the cached module.
        // restart never invokes an export on the trapped instance or refetches bytes.
        await core.restart()
        retired = false
        check()
      }
      handle = await core.loadSchema(material.input)
      check()
      const args = { row: input, card: recipe, nowMs: Date.now() }
      const result = repair
        ? await clearBrandSearchTags({
          editRow: async (schema, input) => { check(); const result = await core.editRow(schema, input); check(); return result },
          revalidate: async (schema, input) => { check(); const result = await core.revalidate(schema, input); check(); return result },
        }, handle, material.input.snapshot, args)
        : await core.revalidate(handle, args)
      check()
      if (result.fact !== "Passed") throw refuse("workflow_repair_validation_blocked", "修复后的商品仍未通过原生字段校验；请检查本行字段并保存，不会自动发送")
      return result
    } catch (reason) {
      poisoned = reason instanceof WebAssembly.RuntimeError || commandErrorCode(reason) === "CORE_OOM"
      if (poisoned) retired = true
      if (poisoned && current()) await captureWorkbenchPublishProblem(row.id, row.revision,
        { platform: "ozon", stage: repair ? "repair" : "validate", family: "control", code: "wasm_failed" }, current)
      throw reason
    } finally {
      // A poisoned instance is retired; even schema_drop must not call it again.
      if (handle !== undefined && !poisoned) await core.dropSchema(handle)
    }
  }
  return {
    clearSearchTags: (row: ListingRowView, card: ListingCardView, current: () => boolean) => run(row, card, current, true),
    revalidate: (row: ListingRowView, card: ListingCardView, current: () => boolean) => run(row, card, current, false),
  }
}
export type WorkflowPublishNative = ReturnType<typeof createWorkflowPublishNative>

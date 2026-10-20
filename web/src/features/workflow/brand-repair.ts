import type { CategorySchemaSnapshot, EditRowInput, EditRowOutput, EditedOutput, RevalidateInput } from "@/listing-core/types"
import { SEARCH_TAGS_ATTRIBUTE_ID } from "./workflow-shared"
import type { WorkflowProductLifecycle } from "@/bindings/commands"
import type { ListingRow } from "./model/listing-row"
import { rowPreparing, type PreparationActivity } from "./prepare/preparation-tracks"

/** Clearing optional search tags is the only supported provider repair. */
export function brandRepairEligible(
  row: ListingRow,
  lifecycle: WorkflowProductLifecycle | undefined,
  readiness: { blockers?: ReadonlyArray<string> } | undefined,
  activity: PreparationActivity,
): boolean {
  if (row.publishUnconfirmed) return false
  if (lifecycle?.last_error_code !== "BR_hashtag_brand") return false
  if (lifecycle.stage !== "publish_rejected") return false
  // `publish_rejected` folds conflict and a plain rejection into one stage;
  // the blocker is what still tells them apart, and repair is conflict-only.
  if (!readiness?.blockers?.includes("publish_conflict")) return false
  if (lifecycle.ai !== "ready" || lifecycle.media !== "ready") return false
  if (row.status === "running") return false
  return !rowPreparing(activity, row.id)
}

/** Current Cloud allowance is separate from the legacy brand-conflict policy. */
export function brandRepairIssueCurrent(lifecycle: WorkflowProductLifecycle | undefined, rowId: string, storeId: string | undefined): boolean {
  const issue = lifecycle?.submission_issue
  return !!issue && !!storeId && issue.row_id === rowId && issue.store_id === storeId && !!issue.intent_id
    && issue.input_revision === lifecycle?.revision && issue.resolved_at_ms == null
    && issue.code === "OZON_ROW_REJECTED" && issue.phase === "submit"
    && issue.dispatch_evidence === "rejected" && issue.allowed_actions.includes("edit_row")
}

export type BrandRepairCore = {
  editRow: (handle: number, input: EditRowInput) => EditRowOutput | Promise<EditRowOutput>
  revalidate: (handle: number, input: RevalidateInput) => EditedOutput | Promise<EditedOutput>
}

/** Optional local repair port: field addressing comes from the resident schema,
 * and editRow records Manual provenance. No Cloud write or send happens here. */
export async function clearBrandSearchTags(
  core: BrandRepairCore,
  handle: number,
  schema: CategorySchemaSnapshot,
  input: RevalidateInput,
): Promise<EditedOutput> {
  const fields = schema.fields.filter((field) => String(field.attribute_id) === String(SEARCH_TAGS_ATTRIBUTE_ID))
  if (fields.length !== 1 || typeof fields[0]!.key !== "string") {
    throw new Error("当前类目没有唯一搜索标签地址；请在搜索标签列手动修正后保存")
  }
  const field = fields[0]!
  if (field.read_only === true) throw new Error("当前搜索标签字段只读；请按类目方案核对可编辑入口")
  const key = String(field.key)
  const draft = structuredClone(input.row.draft)
  if (field.complex_id == null) {
    if (!Object.hasOwn(draft.values, key)) throw new Error("搜索标签来自方案默认值；请先在默认字段删除品牌词并保存")
    delete draft.values[key]
    draft.cleared = [...new Set([...(draft.cleared ?? []), key])]
  } else {
    const group = draft.complex_values.find((group) => String(group.complex_id) === String(field.complex_id))
    if (!group || !group.items.some((item) => Object.hasOwn(item.values, key))) throw new Error("当前商品没有对应的搜索标签组；请重新载入字段后手动修正")
    for (const item of group.items) delete item.values[key]
  }
  const edited = await core.editRow(handle, { ...input, edit: { kind: "draft", draft } })
  return core.revalidate(handle, { ...input, row: edited.row })
}

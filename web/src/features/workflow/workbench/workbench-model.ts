import type {
  CategoryFieldView,
  CategorySchemaView,
  WorkflowCategoryDraft,
  WorkflowDraftView,
} from "@/bindings/commands"
import type { ListingRow } from "../model/listing-row"
import { lifecycleSealed } from "../model/listing-row-lifecycle"
import { readWorkflowValue, valueAsText } from "../workflow-draft"
import {
  MODEL_NAME_ATTRIBUTE_ID,
  fieldByAttributeId,
  fieldLocation,
} from "../workflow-shared"

/**
 * 型号 —— Ozon 属性 9048，与 货号 分开的一列。
 *
 * 货号 is the definite per-instance identity (`offer_id`); 型号 is what the
 * variants of one design share, and two rows with different 货号 may still
 * carry the same 型号. A row that was never given one still sends one:
 * `inject_source_identity` fills a blank 9048 from the source file stem before
 * every build. That fallback is why 恢复独立型号 writes the stem back as a
 * fixed value instead of clearing the field — a cleared value is exactly what
 * the next build refills.
 *
 * Rust owns the protection of a written 型号: 9048 is in
 * `product_instance_owned_keys`, so `overlay_current_card_defaults` strips the
 * card default for it, the Seller-SKU import excludes it, AI never writes it,
 * and the file-name injector only fills a blank. Everything below is the
 * per-row cell and the batch verbs over that same single-row write path.
 */

/** The 型号 column's schema field, or undefined when this category has no 9048. */
export function modelField(
  schema: CategorySchemaView | undefined,
): CategoryFieldView | undefined {
  return fieldByAttributeId(schema, MODEL_NAME_ATTRIBUTE_ID)
}

/**
 * The row's own 型号 — its draft value at the field's real location. Empty means
 * the pipeline still owes the file-name fallback, not that the row sends none.
 */
export function modelText(
  draft: WorkflowCategoryDraft | undefined,
  field: CategoryFieldView | undefined,
): string {
  if (!draft || !field) return ""
  return valueAsText(readWorkflowValue(draft, field.key, fieldLocation(field)))
}

/** File name without its extension — what the injector writes into a blank 型号. */
export function sourceFileStem(fileName: string): string {
  const trimmed = fileName.trim()
  const dot = trimmed.lastIndexOf(".")
  return (dot > 0 ? trimmed.slice(0, dot) : trimmed).trim()
}

/**
 * The row's own model when nobody ever set one: its source-file stem (the 货号
 * of a normal import), falling back to the 货号 the row actually carries. A
 * source file that is gone still leaves an identity that is this row's alone.
 */
export function independentModel(
  row: Pick<ListingRow, "imageName">,
  draft?: WorkflowCategoryDraft,
): string {
  return sourceFileStem(row.imageName) || valueAsText(draft?.values.offer_id).trim()
}

/**
 * The model this row sends right now: its own value, or the file-name stem the
 * build injects. The cell paints the fallback as a muted placeholder, so the
 * two are never confused for one another.
 */
export function effectiveModel(
  row: Pick<ListingRow, "imageName">,
  draft: WorkflowCategoryDraft | undefined,
  field: CategoryFieldView | undefined,
): string {
  return modelText(draft, field) || independentModel(row, draft)
}

/**
 * 同源多规格导入：this Product Instance carries the server-stamped 货号
 * PH-<rowId> (and its 9024 Seller code) and a derived common 型号.
 *
 * Read off the identity the server wrote at creation rather than from a new
 * row column: `stamp_association_identity` is the only writer of that exact
 * value, a replay re-derives it from the same row id, and the row wire view
 * does not need a display-only association field. Cloud remains the authority:
 * every associated send passes the listing association guard there.
 */
export function associatedImportedRow(
  draft: WorkflowCategoryDraft | undefined,
  rowId: string,
): boolean {
  const offerId = valueAsText(draft?.values.offer_id).trim()
  return offerId !== "" && offerId.toLowerCase() === `ph-${rowId}`.toLowerCase()
}

/** One model in use on this card, with how many rows carry it. */
export type KnownModel = { value: string; count: number }

/**
 * The models already known on this card, in row order — the 「加入已知型号」
 * candidates. An untouched row counts with its file-name stem: that stem is the
 * model it will be sent with.
 */
export function knownModels(
  rows: readonly ListingRow[],
  productDrafts: Readonly<Record<string, WorkflowDraftView | undefined>>,
  field: CategoryFieldView | undefined,
): KnownModel[] {
  const counts = new Map<string, number>()
  for (const row of rows) {
    const value = effectiveModel(row, productDrafts[row.draftId]?.draft, field)
    if (!value) continue
    counts.set(value, (counts.get(value) ?? 0) + 1)
  }
  return [...counts].map(([value, count]) => ({ value, count }))
}

export type ModelBatchMode = "common" | "join" | "independent"

export const MODEL_BATCH_LABEL: Record<ModelBatchMode, string> = {
  common: "设置共同型号",
  join: "加入已知型号",
  independent: "恢复独立型号",
}

/** Why one selected row did not take the batch write. */
export type ModelRefusalKind = "sealed" | "missing" | "empty"

export const MODEL_REFUSAL_LABEL: Record<ModelRefusalKind, string> = {
  sealed: "已上架",
  missing: "无草稿",
  // 恢复独立型号 时该行连文件名和货号都没有；设置共同型号时是输入还空着。
  empty: "无可用型号",
}

export type ModelBatchWrite = {
  rowId: string
  draftId: string
  imageName: string
  value: string
}

export type ModelBatchRefusal = {
  rowId: string
  draftId: string
  imageName: string
  reason: ModelRefusalKind
}

export type ModelBatchPlan = {
  mode: ModelBatchMode
  writes: ModelBatchWrite[]
  refusals: ModelBatchRefusal[]
}

/**
 * What one batch verb would write, decided here for both the dialog's preview
 * and the write itself — a second copy of this filter is how a count ends up
 * naming rows the verb then skips.
 *
 * The gate mirrors `editRowCell`'s own refusal for this column (a known
 * Product Instance and an unsealed lifecycle); a row this plan skips is a row
 * the single-row path would refuse, so the batch reports it once instead of
 * letting each skipped row raise its own toast.
 */
export function planModelBatch(input: {
  rows: readonly ListingRow[]
  productDrafts: Readonly<Record<string, WorkflowDraftView | undefined>>
  /** The current card's selected rows. Nothing else takes a batch model. */
  selectedRowIds: ReadonlySet<string>
  field: CategoryFieldView
  mode: ModelBatchMode
  /** The typed / picked model; 恢复独立型号 derives each row's own instead. */
  value?: string
}): ModelBatchPlan {
  const fixed = input.mode === "independent" ? undefined : (input.value ?? "").trim()
  const writes: ModelBatchWrite[] = []
  const refusals: ModelBatchRefusal[] = []
  for (const row of input.rows) {
    if (!input.selectedRowIds.has(row.id)) continue
    const identity = {
      rowId: row.id,
      draftId: row.draftId,
      imageName: row.imageName,
    }
    const product = input.productDrafts[row.draftId]
    if (!product) {
      refusals.push({ ...identity, reason: "missing" })
      continue
    }
    if (lifecycleSealed(product.lifecycle)) {
      refusals.push({ ...identity, reason: "sealed" })
      continue
    }
    const value = fixed ?? independentModel(row, product.draft)
    if (!value) {
      refusals.push({ ...identity, reason: "empty" })
      continue
    }
    writes.push({ ...identity, value })
  }
  return { mode: input.mode, writes, refusals }
}

/** How many refused rows the one toast names before it counts the rest. */
const REFUSAL_NAME_LIMIT = 3

/** One sentence for the per-item failures of a batch: rows named, successes untouched. */
export function modelBatchRefusalCopy(
  refusals: readonly ModelBatchRefusal[],
): string {
  if (!refusals.length) return ""
  const named = refusals
    .slice(0, REFUSAL_NAME_LIMIT)
    .map((row) => `${row.imageName}（${MODEL_REFUSAL_LABEL[row.reason]}）`)
    .join("、")
  return `${refusals.length} 行未写入：${named}${
    refusals.length > REFUSAL_NAME_LIMIT ? ` 等 ${refusals.length} 行` : ""
  }`
}

/** The dialog's pre-write explanation, the same shape as `proseSkipCopy`. */
export function modelBatchSkipCopy(
  refusals: readonly ModelBatchRefusal[],
): string {
  const counts = new Map<ModelRefusalKind, number>()
  for (const row of refusals) {
    counts.set(row.reason, (counts.get(row.reason) ?? 0) + 1)
  }
  const parts = (["sealed", "missing", "empty"] as const)
    .filter((kind) => (counts.get(kind) ?? 0) > 0)
    .map((kind) => `${counts.get(kind)} 行${MODEL_REFUSAL_LABEL[kind]}`)
  return parts.length ? `${parts.join("、")}，未写入` : ""
}

/**
 * Run one batch plan through the existing single-row write.
 *
 * Every write is the same `editRowCell → DurableAutosave → PATCH
 * /api/listing/rows/{id}` a typed cell uses: one draft writer, one revision
 * CAS, no batch endpoint. Pending edits on the target rows are flushed first so
 * the model lands on top of what the operator already typed. Refused rows are
 * reported in one toast and never roll back the rows that succeeded; a durable
 * PATCH failure is the row autosave's own report.
 */
export async function runModelBatch({
  plan,
  edit,
  flush,
  report,
}: {
  plan: ModelBatchPlan
  edit: (draftId: string, value: string) => void
  flush: (draftIds: readonly string[]) => Promise<boolean>
  report: (message: string) => void
}): Promise<ModelBatchPlan> {
  const { writes, refusals } = plan
  if (writes.length) {
    const draftIds = writes.map((write) => write.draftId)
    await flush(draftIds)
    for (const write of writes) edit(write.draftId, write.value)
    await flush(draftIds)
  }
  if (refusals.length) report(modelBatchRefusalCopy(refusals))
  return plan
}

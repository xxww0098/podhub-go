import type { WorkflowCategoryDraft, WorkflowDraftView, WorkflowProductSaveResult } from "@/bindings/commands"

type ProductFields = Pick<WorkflowDraftView, "draft" | "target_store_id">
export type ProductEditFields = ReadonlySet<`values.${string}` | "complex_values" | "storeId">

function equal(left: unknown, right: unknown): boolean {
  if (left === right) return true
  const encode = (value: unknown) => JSON.stringify(value, (_key, item) =>
    item && typeof item === "object" && !Array.isArray(item)
      ? Object.fromEntries(Object.keys(item).sort().map((key) => [key, item[key]]))
      : item,
  )
  return encode(left) === encode(right)
}

/** A reversal is still an edit while an earlier write may have committed. */
export function changedProductFields(base: ProductFields, edited: ProductFields, previous?: ProductEditFields): ProductEditFields {
  const fields = new Set(previous)
  for (const key of new Set([...Object.keys(base.draft.values), ...Object.keys(edited.draft.values)])) {
    if (!equal(base.draft.values[key], edited.draft.values[key])) fields.add(`values.${key}`)
  }
  if (!equal(base.draft.complex_values, edited.draft.complex_values)) fields.add("complex_values")
  if (!equal(base.target_store_id, edited.target_store_id)) fields.add("storeId")
  return fields
}

export type ProductEditConflict = Error & { code: "listing_edit_conflict"; current?: WorkflowProductSaveResult }

export function isProductEditConflict(reason: unknown): reason is ProductEditConflict {
  return reason instanceof Error && "code" in reason && reason.code === "listing_edit_conflict"
}

function editConflict(field: string, latest: unknown): Error {
  const value = latest && typeof latest === "object" && "value" in latest ? latest.value : latest
  const detail = (typeof value === "string" ? value : JSON.stringify(value))?.slice(0, 120) ?? "空值"
  return Object.assign(new Error(`字段 ${field} 存在编辑冲突，当前已保存内容：${detail}。你的输入已保留，请点击该行重试并核对。`), {
    code: "listing_edit_conflict",
    remediation: "点击该行重试，核对后明确选择保留自己的修改",
  })
}

/** Rebase only the operator's changed fields; the row CAS fences the resulting write. */
export function mergeProductEdit(
  base: ProductFields,
  edited: ProductFields,
  current: ProductFields,
  rejectConflicts = true,
  fields = changedProductFields(base, edited),
): ProductFields {
  const pick = <T>(before: T, wanted: T, latest: T, field: string, changed: boolean): T => {
    if (!changed) return latest
    if (rejectConflicts && !equal(before, latest) && !equal(wanted, latest)) {
      throw editConflict(field, latest)
    }
    return wanted
  }
  const values = (
    before: WorkflowCategoryDraft["values"],
    wanted: WorkflowCategoryDraft["values"],
    latest: WorkflowCategoryDraft["values"],
  ) => {
    const result = { ...latest }
    for (const field of fields) {
      if (!field.startsWith("values.")) continue
      const key = field.slice(7)
      const value = pick(before[key], wanted[key], latest[key], key, true)
      if (value === undefined) delete result[key]
      else result[key] = value
    }
    return result
  }
  // Items have no stable identity: equal array lengths cannot prove the same item order.
  const complex = pick(base.draft.complex_values, edited.draft.complex_values, current.draft.complex_values, "complex_values", fields.has("complex_values"))
  return {
    // Rebuild on top of the latest server draft: the literal `{ values,
    // complex_values }` would drop `cleared` and every future server-side
    // section on every save.
    draft: {
      ...current.draft,
      values: values(base.draft.values, edited.draft.values, current.draft.values),
      complex_values: complex,
    },
    target_store_id: pick(base.target_store_id, edited.target_store_id, current.target_store_id, "storeId", fields.has("storeId")),
  }
}

/** Keep the origin of dirty fields; refresh clean ones. An ack advances only its own changed fields. */
export function productEditBaseline(
  base: ProductFields,
  edited: ProductFields,
  current: ProductFields,
  acknowledged: ProductFields = base,
  fields = changedProductFields(base, edited),
): ProductFields {
  const values = { ...current.draft.values }
  for (const field of fields) {
    if (!field.startsWith("values.")) continue
    const key = field.slice(7)
    const value = acknowledged.draft.values[key]
    if (value === undefined) delete values[key]
    else values[key] = value
  }
  return {
    draft: {
      values,
      complex_values: fields.has("complex_values") ? acknowledged.draft.complex_values : current.draft.complex_values,
    },
    target_store_id: fields.has("storeId") ? acknowledged.target_store_id : current.target_store_id,
  }
}

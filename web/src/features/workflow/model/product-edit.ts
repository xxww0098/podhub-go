import type { WorkflowCategoryDraft, WorkflowDraftView, WorkflowProductSaveResult } from "@/bindings/commands"

type ProductFields = Pick<WorkflowDraftView, "draft" | "target_store_id">
export type ProductEditFields = ReadonlySet<`values.${string}` | "complex_values" | "storeId">

function fieldState(draft: WorkflowCategoryDraft, key: string) {
  return [draft.values[key], draft.cleared?.includes(key) ?? false] as const
}

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
  for (const key of new Set([
    ...Object.keys(base.draft.values), ...Object.keys(edited.draft.values),
    ...(base.draft.cleared ?? []), ...(edited.draft.cleared ?? []),
  ])) {
    if (!equal(fieldState(base.draft, key), fieldState(edited.draft, key))) fields.add(`values.${key}`)
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
  const pick = <T>(before: T, wanted: T, latest: T, field: string, changed: boolean, detail: unknown = latest): T => {
    if (!changed) return latest
    if (rejectConflicts && !equal(before, latest) && !equal(wanted, latest)) {
      throw editConflict(field, detail)
    }
    return wanted
  }
  const values = { ...current.draft.values }
  const cleared = new Set(current.draft.cleared)
  for (const field of fields) {
    if (!field.startsWith("values.")) continue
    const key = field.slice(7)
    // A clear marker and its value are one field; merging them separately can resurrect an inherited default.
    const [value, isCleared] = pick(
      fieldState(base.draft, key), fieldState(edited.draft, key), fieldState(current.draft, key), key, true,
      current.draft.cleared?.includes(key) ? "已清空" : current.draft.values[key],
    )
    if (value === undefined) delete values[key]
    else values[key] = value
    if (isCleared) cleared.add(key)
    else cleared.delete(key)
  }
  // Items have no stable identity: equal array lengths cannot prove the same item order.
  const complex = pick(base.draft.complex_values, edited.draft.complex_values, current.draft.complex_values, "complex_values", fields.has("complex_values"))
  const draft = { ...current.draft, values, complex_values: complex }
  if (cleared.size) draft.cleared = [...cleared]
  else if (current.draft.cleared?.length) delete draft.cleared
  return {
    draft,
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
  const cleared = new Set(current.draft.cleared)
  for (const field of fields) {
    if (!field.startsWith("values.")) continue
    const key = field.slice(7)
    const value = acknowledged.draft.values[key]
    if (value === undefined) delete values[key]
    else values[key] = value
    if (acknowledged.draft.cleared?.includes(key)) cleared.add(key)
    else cleared.delete(key)
  }
  const draft = {
    ...current.draft, values,
    complex_values: fields.has("complex_values") ? acknowledged.draft.complex_values : current.draft.complex_values,
  }
  if (cleared.size) draft.cleared = [...cleared]
  else if (current.draft.cleared?.length) delete draft.cleared
  return {
    draft,
    target_store_id: fields.has("storeId") ? acknowledged.target_store_id : current.target_store_id,
  }
}

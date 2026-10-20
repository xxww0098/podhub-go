import type {
  CategoryFieldOption,
  CategoryFieldView,
  CategorySchemaView,
  SkuImportCandidate,
  WorkflowCategoryDraft,
  WorkflowDraftValue,
  WorkflowValidationIssue,
} from "@/bindings/commands"

export const BRAND_ATTRIBUTE_ID = 85
export const NO_BRAND_DICTIONARY_VALUE_ID = 126745801
export const NO_BRAND_DISPLAY_VALUE = "无品牌"
export const NO_BRAND_OPTION: CategoryFieldOption = {
  id: NO_BRAND_DICTIONARY_VALUE_ID,
  value: "Нет бренда",
  info: "",
  picture: "",
}

export function isBrandField(field: CategoryFieldView) {
  return field.attribute_id === BRAND_ATTRIBUTE_ID
}

export function fieldOptionDisplayValue(
  field: CategoryFieldView,
  option: Pick<CategoryFieldOption, "id" | "value">,
) {
  if (isBrandField(field) && option.id === NO_BRAND_DICTIONARY_VALUE_ID) {
    return NO_BRAND_DISPLAY_VALUE
  }
  return option.value
}

export type WorkflowValueLocation = {
  complexId?: number
  itemIndex?: number
}

/**
 * 数字油画（Ozon type 94897）。主题字典按 option id 排序时第一项是
 * 「汽车和摩托车」(31208)。空白方案改填「抽象化」(31229)，与
 * `rust/crates/listing-core/src/paint_by_numbers_theme.rs` 同一对 id。
 */
const PAINT_BY_NUMBERS_TYPE_ID = 94897
const PAINTING_THEME_ATTRIBUTE_ID = 7109
const PAINTING_THEME_DICTIONARY_VALUE_ID = 31229
const PAINTING_THEME_LABEL = "抽象化"

function blankWorkflowDraft(schema: CategorySchemaView): WorkflowCategoryDraft {
  const values: WorkflowCategoryDraft["values"] = {
    description_category_id: {
      kind: "integer",
      value: schema.description_category_id,
    },
    type_id: { kind: "integer", value: schema.type_id },
  }
  const fixedDefaults = {
    dimension_unit: "mm",
    weight_unit: "g",
    vat: "0",
  } as const
  for (const [key, value] of Object.entries(fixedDefaults)) {
    if (schema.fields.some((field) => field.source === "fixed" && field.key === key)) {
      values[key] = { kind: "text", value }
    }
  }

  return {
    values,
    complex_values: schema.complex_groups.map((group) => ({
      complex_id: group.complex_id,
      items: [{ values: {} }],
    })),
  }
}

function fillPaintByNumbersTheme(
  schema: CategorySchemaView,
  values: WorkflowCategoryDraft["values"],
) {
  if (schema.type_id !== PAINT_BY_NUMBERS_TYPE_ID) return
  const field = schema.fields.find(
    (candidate) =>
      candidate.attribute_id === PAINTING_THEME_ATTRIBUTE_ID &&
      candidate.complex_id == null,
  )
  if (!field || values[field.key] !== undefined) return
  values[field.key] = {
    kind: "multi_select",
    value: [
      {
        dictionary_value_id: PAINTING_THEME_DICTIONARY_VALUE_ID,
        value: PAINTING_THEME_LABEL,
      },
    ],
  }
}

export function createWorkflowDraft(schema: CategorySchemaView): WorkflowCategoryDraft {
  const draft = blankWorkflowDraft(schema)
  fillPaintByNumbersTheme(schema, draft.values)
  return draft
}

/** 货源配置起稿只带坐标和固定单位。数字油画的主题默认写在上架方案上。 */
export function createSupplierConfigDraft(
  schema: CategorySchemaView,
): WorkflowCategoryDraft {
  return blankWorkflowDraft(schema)
}

function mintItemId() {
  return `ci_${crypto.randomUUID().replaceAll("-", "")}`
}

export function readWorkflowValue(
  draft: WorkflowCategoryDraft,
  fieldKey: string,
  location: WorkflowValueLocation = {},
) {
  if (location.complexId === undefined) return draft.values[fieldKey]
  return draft.complex_values
    .find((group) => group.complex_id === location.complexId)
    ?.items[location.itemIndex ?? 0]?.values[fieldKey]
}

export type FieldOccupancy = "unset" | "value" | "cleared"

/** Occupancy is unset / value / cleared. `0` and `false` are values. */
export function fieldOccupancy(
  draft: WorkflowCategoryDraft,
  fieldKey: string,
): FieldOccupancy {
  if (draft.values[fieldKey] !== undefined) return "value"
  if ((draft.cleared ?? []).includes(fieldKey)) return "cleared"
  return "unset"
}

export function occupiesField(draft: WorkflowCategoryDraft, fieldKey: string) {
  return fieldOccupancy(draft, fieldKey) !== "unset"
}

export function occupancyLabel(occupancy: FieldOccupancy) {
  if (occupancy === "value") return "已填"
  if (occupancy === "cleared") return "已清空"
  return "未填"
}

export function writeWorkflowValue(
  draft: WorkflowCategoryDraft,
  fieldKey: string,
  value: WorkflowDraftValue | undefined,
  location: WorkflowValueLocation = {},
): WorkflowCategoryDraft {
  if (location.complexId === undefined) {
    const values = { ...draft.values }
    const cleared = new Set(draft.cleared ?? [])
    if (value === undefined) {
      delete values[fieldKey]
      cleared.add(fieldKey)
    } else {
      values[fieldKey] = value
      cleared.delete(fieldKey)
    }
    const nextCleared = [...cleared]
    return nextCleared.length
      ? { ...draft, values, cleared: nextCleared }
      : { ...draft, values, cleared: undefined }
  }

  draft = ensureComplexItem(draft, location.complexId, location.itemIndex ?? 0)
  const complexValues = draft.complex_values.map((group) => {
    if (group.complex_id !== location.complexId) return group
    return {
      ...group,
      items: group.items.map((item, index) => {
        if (index !== (location.itemIndex ?? 0)) return item
        const values = { ...item.values }
        if (value === undefined) delete values[fieldKey]
        else values[fieldKey] = value
        const item_id = Object.keys(values).length === 0 ? undefined : item.item_id || mintItemId()
        return { ...item, item_id, values }
      }),
    }
  })
  return { ...draft, complex_values: complexValues }
}

export function addComplexItem(
  draft: WorkflowCategoryDraft,
  complexId: number,
): WorkflowCategoryDraft {
  const group = draft.complex_values.find((group) => group.complex_id === complexId)
  // The form already shows one blank item for a missing or empty group.
  return ensureComplexItem(draft, complexId, Math.max(1, group?.items.length ?? 0))
}

export function removeComplexItem(
  draft: WorkflowCategoryDraft,
  complexId: number,
  itemIndex: number,
): WorkflowCategoryDraft {
  return {
    ...draft,
    complex_values: draft.complex_values.map((group) =>
      group.complex_id === complexId
        ? { ...group, items: group.items.filter((_, index) => index !== itemIndex) }
        : group,
    ),
  }
}

export function fixedTextValue(raw: string): WorkflowDraftValue | undefined {
  return raw ? { kind: "text", value: raw } : undefined
}

export function textValue(field: CategoryFieldView, raw: string): WorkflowDraftValue {
  const lines = splitLines(raw)
  if (field.editor === "url_list") return { kind: "url_list", value: lines }
  if (field.constraints.collection) return { kind: "text_list", value: lines }
  if (field.editor === "url") return { kind: "url", value: raw }
  return { kind: "text", value: raw }
}

export function valueAsText(value: WorkflowDraftValue | undefined) {
  if (!value) return ""
  switch (value.kind) {
    case "text":
    case "url":
      return value.value
    case "integer":
    case "decimal":
      return String(value.value)
    case "text_list":
    case "url_list":
    case "integer_list":
    case "decimal_list":
    case "boolean_list":
      return value.value.join("\n")
    case "boolean":
      return value.value ? "true" : "false"
    case "single_select":
      return value.value.value
    case "multi_select":
      return value.value.map((selection) => selection.value).join("\n")
  }
}

/** Render a backend draft value using the current seller-facing schema label. */
export function fieldDisplayValueAsText(
  field: CategoryFieldView,
  value: WorkflowDraftValue | undefined,
) {
  if (value?.kind === "single_select") {
    return selectionDisplayValue(field, value.value)
  }
  if (value?.kind === "multi_select") {
    return value.value.map((selection) => selectionDisplayValue(field, selection)).join("\n")
  }
  return valueAsText(value)
}

export function selectionDisplayValue(
  field: CategoryFieldView,
  selection: { dictionary_value_id: number; value: string },
) {
  const option = field.options.find(
    (option) => option.id === selection.dictionary_value_id,
  ) ?? { id: selection.dictionary_value_id, value: selection.value }
  return fieldOptionDisplayValue(field, option)
}

export function issuesForField(
  issues: WorkflowValidationIssue[],
  fieldKey: string,
  location: WorkflowValueLocation = {},
) {
  return issues.filter(
    (issue) =>
      issue.field_key === fieldKey &&
      (issue.complex_id ?? undefined) === location.complexId &&
      (issue.item_index ?? undefined) === location.itemIndex,
  )
}

export function requiredProgress(
  schema: CategorySchemaView,
  draft: WorkflowCategoryDraft,
  includeField: (field: CategoryFieldView) => boolean = () => true,
) {
  let total = 0
  let complete = 0
  for (const field of schema.fields.filter(
    (field) => field.constraints.required && !field.read_only && includeField(field),
  )) {
    if (field.complex_id == null) {
      total += 1
      if (hasValue(draft.values[field.key])) complete += 1
      continue
    }
    const group = draft.complex_values.find(
      (candidate) => candidate.complex_id === field.complex_id,
    )
    const items = group?.items.length ? group.items : [{ values: {} }]
    total += items.length
    complete += items.filter((item) => hasValue(item.values[field.key])).length
  }
  return { total, complete }
}

export function humanValidationMessage(issue: WorkflowValidationIssue) {
  switch (issue.code) {
    case "required":
      return "这是必填字段。"
    case "type":
      return "填写格式与 Ozon 字段要求不一致。"
    case "cardinality":
      return "填写的值数量超过该字段限制。"
    case "unknown_option":
      return "所选值不属于当前类目的可用选项。"
    case "dictionary_id":
      return "所选字典值已经失效，请重新搜索。"
    case "unknown_field":
      return "当前类目中不存在这个字段。"
    case "range":
      return "数值超出 Ozon 接受的范围。"
    case "coordinate":
      return "草稿与当前类目或商品类型不一致。"
    case "complex_placement":
      return "复杂属性没有放在正确的属性组中。"
  }
}

function splitLines(raw: string) {
  return raw
    .split(/\r?\n/)
    .map((value) => value.trim())
    .filter(Boolean)
}

function hasValue(value: WorkflowDraftValue | undefined) {
  if (!value) return false
  if (Array.isArray(value.value)) return value.value.length > 0
  if (typeof value.value === "string") return value.value.trim().length > 0
  return true
}

export function isCategoryDraftBlank(
  schema: CategorySchemaView,
  draft: WorkflowCategoryDraft,
) {
  const editable = new Set(
    schema.fields.filter((field) => !field.read_only).map((field) => field.key),
  )
  const simpleBlank = Object.entries(draft.values).every(
    ([key, value]) => !editable.has(key) || isBlankFieldValue(key, value),
  )
  const complexBlank = draft.complex_values.every((group) =>
    group.items.every((item) =>
      Object.entries(item.values).every(
        ([key, value]) => !editable.has(key) || isBlankFieldValue(key, value),
      ),
    ),
  )
  return simpleBlank && complexBlank
}

export function applySkuImportCandidates(
  draft: WorkflowCategoryDraft,
  candidates: SkuImportCandidate[],
) {
  let next = draft
  for (const candidate of candidates) {
    if (candidate.location.kind === "complex") {
      next = ensureComplexItem(
        next,
        candidate.location.complex_id,
        candidate.location.item_index,
      )
      next = writeWorkflowValue(
        next,
        candidate.field_key,
        candidate.value,
        {
          complexId: candidate.location.complex_id,
          itemIndex: candidate.location.item_index,
        },
      )
    } else {
      next = writeWorkflowValue(
        next,
        candidate.field_key,
        candidate.value,
      )
    }
  }
  return next
}

function ensureComplexItem(
  draft: WorkflowCategoryDraft,
  complexId: number,
  itemIndex: number,
) {
  const complexValues = [...draft.complex_values]
  let groupIndex = complexValues.findIndex((group) => group.complex_id === complexId)
  if (groupIndex < 0) {
    complexValues.push({ complex_id: complexId, items: [] })
    groupIndex = complexValues.length - 1
  }
  const group = complexValues[groupIndex]
  const items = [...group.items]
  while (items.length <= itemIndex) items.push({ values: {} })
  complexValues[groupIndex] = { ...group, items }
  return { ...draft, complex_values: complexValues }
}

function isBlankFieldValue(key: string, value: WorkflowDraftValue) {
  if (key === "dimension_unit" && value.kind === "text" && value.value === "mm") {
    return true
  }
  if (key === "weight_unit" && value.kind === "text" && value.value === "g") {
    return true
  }
  if (key === "vat" && value.kind === "text" && value.value === "0") {
    return true
  }
  if (Array.isArray(value.value)) return value.value.length === 0
  if (typeof value.value === "string") return value.value.trim().length === 0
  return false
}

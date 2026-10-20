/**
 * `supplier_ozon_configs` 的行级读写 —— 「默认字段」分区的事实来源
 * （行上的默认字段 jsonb 槽位已退场，行 PUT 不再携带默认字段）。
 *
 * Wire 形状（`SupplierOzonConfigData.values` / `PutSupplierOzonConfigRequest.values`）：
 * 键是 `fixed:{field}` 或 `attribute:{attribute_id}:{complex_id}`，值是带
 * kind 的 `SupplierOzonConfigValue[]`（decimal 走字符串、选项带 optionId）。
 * 草稿 ↔ wire 的转换逐条镜像 `src/listing/kernel/supplier_projection.rs` 的
 * `supplier_defaults` 与 `workflow_value`：读侧由首值类型驱动，`complex_id = 0` 落普通字段；写侧
 * 按 schema 反查 `complex_id`，`fixed:` 只收 9 个单品字段，坐标键与行内
 * 生成的字段永远不写进 values。
 *
 * GET 404 = 还没有配置，首个 PUT 用 `expectedRevision: 0` 创建；PUT 是整配
 * 置写回，promptText / fixedTags / aiOutput / language 一律原样回带。
 * 服务端校验是软口径（问题挂在配置 issues 上不拒写），前端只做编码不做裁决。
 */
import { api } from "@/api/client"
import type { CloudRefusal } from "@/api/client"
import { route } from "@/api/routes"
import type { components } from "@/api/schema"
import type {
  CategorySchemaView,
  WorkflowCategoryDraft,
  WorkflowDraftValue,
} from "@/bindings/commands"
import {
  createSupplierConfigDraft,
  valueAsText,
} from "@/features/workflow/workflow-draft"
import { fieldByAttributeId } from "@/features/workflow/workflow-shared"
import { reportError } from "@/lib/diag-log"

import { LISTING_DEFAULT_COORDINATE_KEYS } from "./supplier-listing-defaults"
import { numericAttributeValue } from "./supplier-ozon-config-numeric"

type Schema = components["schemas"]

export type SupplierOzonConfigValue = Schema["SupplierOzonConfigValue"]
export type SupplierOzonConfigData = Schema["SupplierOzonConfigData"]
export type PutSupplierOzonConfigBody = Schema["PutSupplierOzonConfigRequest"]

const configPath = (sourceId: string, productId: string) =>
  route("adminSupplierDbsBySourceIdRowsByProductIdOzonConfig", {
    source_id: sourceId,
    product_id: productId,
  })

/** 分区与配置端点之间的唯一 HTTP 边界；测试注入同名形状替身。 */
export type SupplierOzonConfigIO = {
  get: (
    sourceId: string,
    productId: string,
  ) => Promise<SupplierOzonConfigData | undefined>
  put: (
    sourceId: string,
    productId: string,
    body: PutSupplierOzonConfigBody,
  ) => Promise<SupplierOzonConfigData>
}

/**
 * `CloudRefusal` 的 status 是可选字段 —— 只对对象形状做窄化，
 * null / 裸值 / 其他 Error 都不算 404。
 */
function httpStatus(reason: unknown): number | undefined {
  if (typeof reason !== "object" || reason === null) return undefined
  const status = (reason as CloudRefusal).status
  return typeof status === "number" ? status : undefined
}

export const supplierOzonConfigIO: SupplierOzonConfigIO = {
  async get(sourceId, productId) {
    try {
      const data = await api.get<{ config: SupplierOzonConfigData }>(
        configPath(sourceId, productId),
      )
      return data.config
    } catch (reason) {
      // 还没有配置不是失败——首个 PUT 用 expectedRevision 0 创建它。
      if (httpStatus(reason) === 404) return undefined
      throw reason
    }
  },
  async put(sourceId, productId, body) {
    const data = await api.put<{ config: SupplierOzonConfigData }>(
      configPath(sourceId, productId),
      body,
    )
    return data.config
  },
}

/**
 * 复制行带上「默认字段」：把源行配置的 values / aiOutput / language 写到
 * 新行（提示词与标签已随行建写入，取新行配置里的那份），签新行配置的
 * revision。源行无配置或坐标不同则不写，返回 false。
 */
export async function copySupplierOzonConfig(
  io: SupplierOzonConfigIO,
  sourceId: string,
  fromProductId: string,
  toProductId: string,
  coordinate: { description_category_id: number; type_id: number },
): Promise<boolean> {
  const [from, to] = await Promise.all([
    io.get(sourceId, fromProductId),
    io.get(sourceId, toProductId),
  ])
  if (
    !from ||
    from.description_category_id !== coordinate.description_category_id ||
    from.type_id !== coordinate.type_id
  ) {
    return false
  }
  await io.put(sourceId, toProductId, {
    ...coordinate,
    language: from.language,
    values: from.values,
    ai_output: from.ai_output,
    prompt_text: to?.prompt_text ?? from.prompt_text,
    fixed_tags: to?.fixed_tags ?? from.fixed_tags,
    expected_revision: to?.revision ?? 0,
  })
  return true
}

// ---------- wire key grammar ----------

/** 与 ozon_config.rs::FixedField::ALL / fixed_field_kind 同序同口径。 */
const FIXED_FIELD_KINDS = {
  barcode: "text",
  width: "integer",
  height: "integer",
  depth: "integer",
  dimension_unit: "text",
  weight: "integer",
  weight_unit: "text",
  vat: "decimal",
  currency_code: "text",
} as const
type FixedFieldKey = keyof typeof FIXED_FIELD_KINDS

type SchemaField = CategorySchemaView["fields"][number]

const ATTRIBUTE_KEY = /^attribute_(\d+)$/

const fieldByKey = (schema: CategorySchemaView, key: string) =>
  schema.fields.find((field) => field.key === key)

/**
 * 草稿字段键 → wire 键。坐标键、行内生成字段（name/offer_id/price…）与其他
 * 非 `fixed:`/非 `attribute_{id}` 的键返回 undefined —— 它们在配置模型里
 * 没有槽位，写侧丢弃；fixed 键只认 FixedField::ALL 九名成员。
 */
function configKeyFor(
  schema: CategorySchemaView,
  key: string,
  complexId: number,
): string | undefined {
  if (LISTING_DEFAULT_COORDINATE_KEYS.has(key)) return undefined
  if (key in FIXED_FIELD_KINDS) return `fixed:${key}`
  const attributeId = ATTRIBUTE_KEY.exec(key)?.[1]
  if (attributeId === undefined) return undefined
  // complex 组里的值用其组 id；普通值按 schema 反查（老草稿可能少记）。
  const resolved =
    complexId > 0
      ? complexId
      : (fieldByAttributeId(schema, Number(attributeId))?.complex_id ?? 0)
  return `attribute:${attributeId}:${resolved}`
}

// ---------- wire → draft（镜像 supplier_projection.rs::workflow_value） ----------

const displayText = (entry: SupplierOzonConfigValue): string => {
  switch (entry.kind) {
    case "text":
    case "decimal":
      return entry.value
    case "integer":
      return String(entry.value)
    case "flag":
      return String(entry.value)
    case "options":
      return entry.options.map((option) => option.value).join(", ")
  }
}

/**
 * 一条 wire 值数组 → 草稿值。`editor` 即 OzonFieldKind 词汇（fixed 键没有
 * 字段定义，编辑器恒按文本口径）；混合/废值返回 undefined，读侧跳过。
 */
function toDraftValue(
  entries: SupplierOzonConfigValue[],
  field: SchemaField | undefined,
): WorkflowDraftValue | undefined {
  const first = entries[0]
  if (!first) return undefined
  const collection = field?.constraints.collection ?? false
  const editor = field?.editor
  switch (first.kind) {
    case "text": {
      const texts = entries.map(displayText)
      if (editor === "url" && !collection && texts.length === 1) {
        return { kind: "url", value: texts[0]! }
      }
      if (editor === "url_list") return { kind: "url_list", value: texts }
      if (collection || texts.length > 1) {
        return { kind: "text_list", value: texts }
      }
      return { kind: "text", value: texts[0]! }
    }
    case "integer": {
      const numbers: number[] = []
      for (const entry of entries) {
        if (entry.kind !== "integer") return undefined
        numbers.push(entry.value)
      }
      return collection || numbers.length > 1
        ? { kind: "integer_list", value: numbers }
        : { kind: "integer", value: numbers[0]! }
    }
    case "decimal": {
      const numbers: number[] = []
      for (const entry of entries) {
        if (entry.kind !== "decimal") return undefined
        const parsed = Number(entry.value)
        if (!Number.isFinite(parsed)) return undefined
        numbers.push(parsed)
      }
      return collection || numbers.length > 1
        ? { kind: "decimal_list", value: numbers }
        : { kind: "decimal", value: numbers[0]! }
    }
    case "flag": {
      const flags: boolean[] = []
      for (const entry of entries) {
        if (entry.kind !== "flag") return undefined
        flags.push(entry.value)
      }
      return collection || flags.length > 1
        ? { kind: "boolean_list", value: flags }
        : { kind: "boolean", value: flags[0]! }
    }
    case "options": {
      const selections = entries.flatMap((entry) =>
        entry.kind === "options"
          ? entry.options.map((option) => ({
              dictionary_value_id: option.option_id,
              value: option.value,
            }))
          : [],
      )
      return editor === "single_select" && selections.length === 1
        ? { kind: "single_select", value: selections[0]! }
        : { kind: "multi_select", value: selections }
    }
  }
}

/**
 * 线上 values → 草稿。类目已没有的属性键与不可解析的键跳过并上报 —— 一份
 * 过期配置不该拖死整个编辑面（服务端 issues 已记录同一事实）。
 */
export function draftFromOzonConfigValues(
  values: SupplierOzonConfigData["values"],
  schema: CategorySchemaView,
): WorkflowCategoryDraft {
  const plain: Record<string, WorkflowDraftValue> = {}
  const complex = new Map<number, Record<string, WorkflowDraftValue>>()
  for (const [rawKey, entries] of Object.entries(values)) {
    const splitAt = rawKey.indexOf(":")
    const namespace = rawKey.slice(0, splitAt)
    const rest = rawKey.slice(splitAt + 1)
    if (namespace === "fixed" && rest in FIXED_FIELD_KINDS) {
      const value = toDraftValue(entries, fieldByKey(schema, rest))
      if (value) plain[rest] = value
      continue
    }
    if (namespace === "attribute") {
      const [attributeId, complexId] = rest.split(":").map(Number)
      const field = fieldByAttributeId(schema, attributeId)
      if (!field || !Number.isInteger(complexId)) {
        reportError(
          "[supplier-ozon-config] 跳过已不在当前类目的配置键",
          { key: rawKey },
        )
        continue
      }
      const value = toDraftValue(entries, field)
      if (!value) continue
      const fieldKey = `attribute_${attributeId}`
      if (complexId === 0) {
        plain[fieldKey] = value
      } else {
        const group = complex.get(complexId) ?? {}
        group[fieldKey] = value
        complex.set(complexId, group)
      }
      continue
    }
    reportError("[supplier-ozon-config] 跳过非法配置键", { key: rawKey })
  }
  return {
    values: plain,
    complex_values: [...complex.entries()]
      .sort(([a], [b]) => a - b)
      .map(([complex_id, groupValues]) => ({
        complex_id,
        items: [{ values: groupValues }],
      })),
  }
}

// ---------- draft → wire ----------

/**
 * 单品字段的值必须落在 FixedFieldKind 上（ozon_config.rs::fixed_value_matches）：
 * 三边/重量是 integer、vat 是 decimal、其余 text。收编只在无损时发生 ——
 * `Math.trunc` 会把 1.5 悄悄写成 1，所以 integer 槽位只收已是整数的文本，
 * 其余原样写 text，由服务端挂 FixedFieldKindMismatch 而不是前端丢精度。
 */
function encodeFixedValue(
  expected: (typeof FIXED_FIELD_KINDS)[FixedFieldKey],
  value: WorkflowDraftValue,
): SupplierOzonConfigValue[] {
  const text = valueAsText(value).trim()
  if (!text) return []
  const numeric = Number(text)
  if (expected === "integer" && Number.isSafeInteger(numeric)) {
    return [{ kind: "integer", value: numeric }]
  }
  if (expected === "decimal" && Number.isFinite(numeric)) {
    return [{ kind: "decimal", value: text }]
  }
  return [{ kind: "text", value: text }]
}

/** 类目特征按当前 schema 编码；写不下的空值返回 []（配置模型里空即删键）。 */
function encodeAttributeValue(
  value: WorkflowDraftValue,
  field: SchemaField | undefined,
): SupplierOzonConfigValue[] {
  const numericEditor = field?.editor
  if (numericEditor === "integer" || numericEditor === "decimal") {
    const raw =
      value.kind === "text" || value.kind === "integer" || value.kind === "decimal"
        ? [String(value.value)]
        : value.kind === "text_list" || value.kind === "integer_list" || value.kind === "decimal_list"
          ? value.value.map(String)
          : undefined
    if (raw) {
      const nonempty = raw.filter((item) => item.trim())
      const encoded = nonempty.map((item) => numericAttributeValue(item, numericEditor))
      // Keep an invalid collection homogeneous so it remains visible on reopen.
      return encoded.every((entry) => entry.kind !== "text")
        ? encoded
        : nonempty.map((item) => ({ kind: "text", value: item }))
    }
  }
  switch (value.kind) {
    case "text":
    case "url":
      return value.value.trim() ? [{ kind: "text", value: value.value }] : []
    case "text_list":
    case "url_list":
      return value.value
        .filter((item) => item.trim())
        .map((item) => ({ kind: "text" as const, value: item }))
    case "integer":
      return Number.isSafeInteger(value.value)
        ? [{ kind: "integer", value: value.value }]
        : [{ kind: "text", value: String(value.value) }]
    case "integer_list":
      return value.value.every(Number.isSafeInteger)
        ? value.value.map((item) => ({ kind: "integer" as const, value: item }))
        : value.value.map((item) => ({ kind: "text" as const, value: String(item) }))
    case "decimal":
      return [{ kind: "decimal", value: String(value.value) }]
    case "decimal_list":
      return value.value.map((item) => ({
        kind: "decimal" as const,
        value: String(item),
      }))
    case "boolean":
      return [{ kind: "flag", value: value.value }]
    case "boolean_list":
      return value.value.map((item) => ({
        kind: "flag" as const,
        value: item,
      }))
    case "single_select":
      return [
        {
          kind: "options",
          options: [
            {
              option_id: value.value.dictionary_value_id,
              value: value.value.value,
            },
          ],
        },
      ]
    case "multi_select":
      return value.value.length
        ? [
            {
              kind: "options",
              options: value.value.map((option) => ({
                option_id: option.dictionary_value_id,
                value: option.value,
              })),
            },
          ]
        : []
  }
}

/**
 * 草稿 → wire values。坐标键与不可映射的键不写；cleared 与空值自然缺键。
 * `attribute:{id}:{complex_id}` 只存一份值，表达不了同组多条目 —— 表单
 * 入口已限制每组一条，这里对越界的草稿直接报错而不是末项覆盖。
 */
export function draftToOzonConfigValues(
  draft: WorkflowCategoryDraft,
  schema: CategorySchemaView,
): SupplierOzonConfigData["values"] {
  const out: SupplierOzonConfigData["values"] = {}
  const write = (key: string, value: WorkflowDraftValue, complexId: number) => {
    const wireKey = configKeyFor(schema, key, complexId)
    if (!wireKey) {
      // 坐标键是 PUT 顶层字段，天然不进 values，不算丢失。
      if (!LISTING_DEFAULT_COORDINATE_KEYS.has(key)) {
        reportError("[supplier-ozon-config] 草稿键无配置槽位，未写入", {
          key,
        })
      }
      return
    }
    const entries = wireKey.startsWith("fixed:")
      ? encodeFixedValue(
          FIXED_FIELD_KINDS[wireKey.slice(6) as FixedFieldKey],
          value,
        )
      : encodeAttributeValue(value, fieldByKey(schema, key))
    if (entries.length) out[wireKey] = entries
  }
  for (const [key, value] of Object.entries(draft.values)) {
    write(key, value, fieldByKey(schema, key)?.complex_id ?? 0)
  }
  for (const group of draft.complex_values) {
    if (group.items.length > 1) {
      throw new Error(
        `Ozon 配置存不下复杂组 ${group.complex_id} 的多条目草稿`,
      )
    }
    for (const [key, value] of Object.entries(group.items[0]?.values ?? {})) {
      write(key, value, group.complex_id)
    }
  }
  return out
}

/**
 * 「默认字段」编辑初值：已有配置的 values 投成草稿沿用（坐标键一律重盖到
 * 当前坐标），无配置或空 values 按 schema 起空白稿（含 mm / g / vat=0 固定默认）。
 * 不带数字油画的主题默认：主题写在上架方案上，不写进货源配置。
 */
export function seedSupplierRowDefaults(
  schema: CategorySchemaView,
  stored: SupplierOzonConfigData["values"] | undefined,
  coordinate: { description_category_id: number; type_id: number },
): WorkflowCategoryDraft {
  const draft =
    stored && Object.keys(stored).length
      ? draftFromOzonConfigValues(stored, schema)
      : createSupplierConfigDraft(schema)
  return {
    ...draft,
    values: {
      ...draft.values,
      description_category_id: {
        kind: "integer",
        value: coordinate.description_category_id,
      },
      type_id: { kind: "integer", value: coordinate.type_id },
    },
  }
}

/**
 * Shared fixtures for the workflow integration tests: the card bind props, the
 * category schema a card edits, the workbench schema with its prose columns,
 * the Product Instances a workbench row reads, and the inert workbench handlers.
 */
import type { ComponentProps } from "react"
import type {
  CategoryFieldView,
  CategorySchemaView,
  WorkflowDraftView,
  WorkflowProductLifecycle,
} from "../../src/bindings/commands"
import type { ListingRow } from "../../src/features/workflow/model/listing-row"
import {
  NO_GUIDED_PREPARATION,
  NO_PREPARATION_ACTIVITY,
  NO_PREPARATION_PROGRESS,
} from "../../src/features/workflow/prepare/preparation-tracks"
import type { FieldWorkbench } from "../../src/features/workflow/workbench/field-workbench"

export const cardBindProps = {
  idPrefix: "test-bind",
  name: "测试卡片",
  tree: [],
  selection: {
    l1Id: 1,
    l2Id: 2,
    descriptionCategoryId: 3,
    typeId: 4,
  },
  stores: [],
  storeId: "store-1",
  psdFileName: "template.psd",
  prompts: [],
  promptId: "",
  onNameChange: () => undefined,
  onStoreChange: () => undefined,
  onSelectL1: () => undefined,
  onSelectL2: () => undefined,
  onSelectType: () => undefined,
  onRefreshTree: () => undefined,
  onPickPsd: () => undefined,
  onPromptChange: () => undefined,
  onRefreshPrompts: () => undefined,
}

const baseField: CategoryFieldView = {
  key: "name",
  name: "商品名称",
  description: "展示给买家的名称",
  group_name: "Fixed",
  source: "fixed",
  editor: "text",
  complex_group_collection: false,
  read_only: false,
  constraints: { required: true, collection: false },
  options: [],
  options_truncated: false,
  aspect: null,
}

export function field(overrides: Partial<CategoryFieldView>): CategoryFieldView {
  return { ...baseField, ...overrides, constraints: { ...baseField.constraints, ...overrides.constraints } }
}

export const schema: CategorySchemaView = {
  description_category_id: 17027906,
  type_id: 91976,
  language: "zh_hans",
  fields: [
    field({ key: "description_category_id", name: "类目 ID", editor: "integer", read_only: true }),
    field({ key: "type_id", name: "商品类型 ID", editor: "integer", read_only: true }),
    baseField,
    field({ key: "price", name: "价格", editor: "decimal" }),
    field({ key: "dimension_unit", name: "Dimension unit" }),
    field({ key: "weight_unit", name: "Weight unit" }),
    field({ key: "currency_code", name: "Currency", constraints: { required: false, collection: false } }),
    field({ key: "vat", name: "VAT", editor: "decimal" }),
    field({ key: "available", name: "是否可用", editor: "boolean", constraints: { required: false, collection: false } }),
    field({
      key: "attr_10",
      name: "颜色",
      group_name: "外观",
      source: "attribute",
      editor: "single_select",
      raw_type: "String",
      attribute_id: 10,
      constraints: { required: true, collection: false, dictionary_id: 1 },
      options: [{ id: 1, value: "蓝色", info: "", picture: "" }],
    }),
    field({
      key: "attr_11",
      name: "风格",
      group_name: "外观",
      source: "attribute",
      editor: "multi_select",
      raw_type: "String",
      attribute_id: 11,
      constraints: { required: false, collection: true, dictionary_id: 2 },
      options: [{ id: 2, value: "现代", info: "", picture: "" }],
    }),
    field({
      key: "attr_12",
      name: "品牌",
      group_name: "外观",
      source: "attribute",
      editor: "dictionary_search",
      raw_type: "String",
      attribute_id: 12,
      constraints: { required: false, collection: false, dictionary_id: 3 },
      options_truncated: true,
    }),
    field({ key: "primary_image", name: "主图", editor: "url", constraints: { required: false, collection: false } }),
    field({ key: "images", name: "图片", editor: "url_list", constraints: { required: true, collection: true, max_value_count: 15 } }),
    field({
      key: "attr_20",
      name: "包装长度",
      group_name: "包装",
      source: "attribute",
      editor: "integer",
      raw_type: "Integer",
      attribute_id: 20,
      complex_id: 99,
      complex_group_collection: true,
    }),
  ],
  complex_groups: [
    { complex_id: 99, name: "包装", collection: true, field_keys: ["attr_20"] },
  ],
}

/**
 * The workbench resolves 简介 and 型号名称 by Ozon attribute id, never by key,
 * so the fixture gives them the prose keys a local category fixture would use —
 * a column that matched on `attribute_4191` would pass against a live schema and
 * silently show nothing here.
 */
export const workbenchSchema: CategorySchemaView = {
  ...schema,
  fields: [
    ...schema.fields,
    field({
      key: "price",
      name: "销售价",
      source: "fixed",
      editor: "decimal",
      constraints: { required: false, collection: false },
    }),
    field({
      key: "old_price",
      name: "划线价",
      source: "fixed",
      editor: "decimal",
      constraints: { required: false, collection: false },
    }),
    field({
      key: "description",
      name: "简介",
      group_name: "商品属性",
      source: "attribute",
      attribute_id: 4191,
      constraints: { required: false, collection: false },
    }),
    field({
      key: "model_name",
      name: "型号名称",
      group_name: "商品属性",
      source: "attribute",
      attribute_id: 9048,
      constraints: { required: false, collection: false },
    }),
    field({
      key: "attribute_11254",
      name: "JSON富内容",
      group_name: "商品属性",
      source: "attribute",
      attribute_id: 11254,
      constraints: { required: false, collection: false },
    }),
    field({
      key: "attribute_7109",
      name: "主题",
      group_name: "商品属性",
      source: "attribute",
      attribute_id: 7109,
      constraints: { required: false, collection: true },
    }),
  ],
}

/**
 * Row-level Draft state the workbench reads its cells from. Tests build the
 * Product Instances the screen would otherwise have persisted.
 */
export function workbenchDrafts(
  rows: ListingRow[],
  lifecycle?: WorkflowProductLifecycle,
): Record<string, WorkflowDraftView> {
  const base: WorkflowProductLifecycle = lifecycle ?? {
    revision: 0,
    view_revision: 0,
    image_total: 0, image_completed: 0,
    stage: "awaiting_content",
    ai: "pending",
    media: "pending",
    fields: "dirty",
    images: [],
    failure_log: [],
    ai_candidates: [],
    product_videos: [],
  }
  return Object.fromEntries(
    rows.map((row) => [
      row.draftId,
      {
        draft_id: row.draftId,
        kind: "instance",
        display_name: row.imageName,
        schema: workbenchSchema,
        draft: {
          values: {
            name: { kind: "text", value: `画 ${row.imageName}` },
            offer_id: { kind: "text", value: row.imageName.replace(/\.[^.]+$/, "") },
            description: { kind: "text", value: `简介 ${row.imageName}` },
            model_name: { kind: "text", value: row.imageName.replace(/\.[^.]+$/, "") },
          },
          complex_values: [],
        },
        validation_state: "draft",
        issues: [],
        ai_prompt_id: "prompt-1",
        ai_prompt: "",
        ai_prompt_file_name: "",
        psd_template_asset_id: "",
        psd_template_file_name: "",
        target_store_id: "store-1",
        ai_field_policy: { allowed_field_keys: [], protected_field_keys: [] },
        lifecycle: base,
        updated_at_ms: 0,
      } satisfies WorkflowDraftView,
    ]),
  )
}

export const workbenchHandlers = {
  rowSaveStates: {},
  cardDraft: { values: {}, complex_values: [] },
  cardIssues: [],
  cardFieldOrigins: [],
  targetStoreId: "store-1",
  busy: false,
  activity: NO_PREPARATION_ACTIVITY,
  preparationProgress: NO_PREPARATION_PROGRESS,
  guidedPreparation: NO_GUIDED_PREPARATION,
  queueStopRequested: false,
  storeConfigured: true,
  storeLabel: "测试店铺",
  dragging: false,
  onSelectionChange: () => undefined,
  onImportImages: () => undefined,
  onClearRows: () => undefined,
  onRemoveRows: () => undefined,
  onEditCell: () => undefined,
  onEditField: () => undefined,
  onRetryRowSave: () => undefined,
  onFlushRows: async () => true,
  onRunAiRows: () => undefined,
  onRunRenderRows: () => undefined,
  onRunDeliverRows: () => undefined,
  onPrepareRows: () => undefined,
  onStopPreparation: () => undefined,
  onSendRows: () => undefined,
  onPauseQueue: () => undefined,
  onUpdateCardDefault: () => undefined,
  onCancelQueue: () => undefined,
  onResumeQueue: () => undefined,
  onCancelRowIntent: () => undefined,
} satisfies Partial<ComponentProps<typeof FieldWorkbench>>

/**
 * What「读起来是禁用的」means in the action ribbon. The ribbon soft-disables its
 * batch verbs — `aria-disabled` instead of the native attribute — so a verb
 * sitting at 0 still takes hover and focus and its tooltip can say why.
 */
export const READS_DISABLED = /data-disabled|aria-disabled="true"/

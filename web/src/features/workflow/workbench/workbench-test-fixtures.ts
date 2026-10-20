/**
 * Shared data fixtures for the workbench tests: one category schema whose
 * attribute ids match a live Ozon schema, the idle lifecycle and the row /
 * Product Instance factories every workbench test builds from.
 */
import type {
  CategoryFieldView,
  CategorySchemaView,
  WorkflowDraftView,
  WorkflowImageLifecycle,
  WorkflowProductLifecycle,
  WorkflowProductStatusView,
  WorkflowReadinessReport,
} from "@/bindings/commands"
import type { ListingRow } from "../model/listing-row"

const baseField: CategoryFieldView = {
  key: "name",
  name: "商品名称",
  description: "",
  group_name: "商品基础信息",
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
  return {
    ...baseField,
    ...overrides,
    constraints: { ...baseField.constraints, ...overrides.constraints },
  }
}

/**
 * The attribute ids are the point: a live schema names 简介 `attribute_4191`
 * while the local category fixture calls it `description`, so the workbench
 * resolves both columns by number and never by key.
 */
export const schema: CategorySchemaView = {
  description_category_id: 17027906,
  type_id: 91976,
  language: "zh_hans",
  fields: [
    field({ key: "description_category_id", name: "类目 ID", editor: "integer", read_only: true }),
    field({ key: "type_id", name: "商品类型 ID", editor: "integer", read_only: true }),
    baseField,
    field({ key: "offer_id", name: "商家货号", constraints: { required: true, collection: false } }),
    field({ key: "price", name: "销售价", editor: "decimal" }),
    field({ key: "old_price", name: "划线价", editor: "decimal" }),
    field({ key: "vat", name: "增值税率", editor: "decimal", constraints: { required: false, collection: false } }),
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
      editor: "multi_select",
      constraints: { required: false, collection: true, max_value_count: 5 },
      options: [
        { id: 970742650, value: "花卉和植物", info: "", picture: "" },
        { id: 970742668, value: "猫", info: "", picture: "" },
      ],
    }),
    field({ key: "images", name: "商品图片", editor: "url_list", constraints: { required: true, collection: true } }),
    field({ key: "images360", name: "360° 图片", editor: "url_list", constraints: { required: false, collection: true } }),
    field({ key: "primary_image", name: "主图", editor: "url", constraints: { required: false, collection: false } }),
    field({ key: "color_image", name: "颜色样本", editor: "url", constraints: { required: false, collection: false } }),
  ],
  complex_groups: [],
}

export const idleLifecycle: WorkflowProductLifecycle = {
  revision: 1,
  view_revision: 1,
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

export const needsPreparation: WorkflowReadinessReport = {
  ready_to_publish: false, can_start_publish_attempt: false,
  blockers: ["ai_pending", "media_pending", "fields_dirty"],
  allowed_actions: ["prepare", "edit_fields"],
}

export const readyToPublish: WorkflowReadinessReport = {
  ready_to_publish: true, can_start_publish_attempt: true,
  blockers: [],
  allowed_actions: ["publish", "edit_fields"],
}

export function slice(
  index: number,
  overrides: Partial<WorkflowImageLifecycle> = {},
): WorkflowImageLifecycle {
  return {
    index,
    file_name: `${String(index + 1).padStart(2, "0")}-slice.jpg`,
    content_hash: `sha256:slice-${index}`,
    group_name: "主体",
    width: 900,
    height: 1200,
    phase: "rendered",
    ...overrides,
  }
}

export function row(index: number, overrides: Partial<ListingRow> = {}): ListingRow {
  const imageName = `SZ-000${index}.png`
  return {
    id: `row-${index}`,
    draftId: `workflow_instance_${index}`,
    imageName,
    source: { handle: `handle-${index}`, file_name: imageName },
    status: "pending",
    ai: "idle",
    render: "idle",
    upload: "idle",
    log: "已导入，等待确认后开始准备",
    readiness: needsPreparation,
    ...overrides,
  }
}

export function instance(
  target: ListingRow,
  lifecycle: WorkflowProductLifecycle = idleLifecycle,
): WorkflowDraftView {
  return {
    draft_id: target.draftId,
    kind: "instance",
    parent_card_id: "workflow_template_1",
    display_name: target.imageName,
    schema,
    draft: {
      values: {
        offer_id: { kind: "text", value: target.imageName.replace(/\.[^.]+$/, "") },
      },
      complex_values: [],
    },
    validation_state: "draft",
    issues: [],
    ai_prompt_id: "prompt-1",
    ai_prompt: "",
    ai_prompt_file_name: "",
    psd_template_asset_id: "psd-1",
    psd_template_file_name: "template.psd",
    target_store_id: "store-1",
    // The Rust default policy allows every non-protected, non-read-only
    // field — title and description included. A card whose operator trimmed the
    // policy keeps AI off those fields entirely.
    ai_field_policy: {
      allowed_field_keys: ["name", "description", "model_name"],
      protected_field_keys: [
        "price",
        "offer_id",
        "vat",
        "images",
        "images360",
        "primary_image",
        "color_image",
        "description_category_id",
        "type_id",
      ],
    },
    lifecycle,
    updated_at_ms: 0,
  }
}

/** A streamed row projection: the row as Cloud handed it back after one leg. */
export function projection(
  target: ListingRow,
  lifecycle: WorkflowProductLifecycle,
  values: WorkflowDraftView["draft"]["values"] = {},
  readiness: WorkflowReadinessReport = needsPreparation,
): WorkflowProductStatusView {
  const base = instance(target)
  return {
    lifecycle,
    readiness,
    target_store_id: base.target_store_id,
    draft: { ...base.draft, values: { ...base.draft.values, ...values } },
    validation_state: "draft",
    issues: [],
  }
}

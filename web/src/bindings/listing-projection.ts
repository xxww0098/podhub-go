/**
 * Cloud listing views ⇄ the workbench's own vocabulary.
 *
 * Each side owns its view of the same wire. Cloud's `ListingRowView`
 * / `ListingCardView` / `CatalogSchemaData` are the wire; the screens are
 * written against `WorkflowDraftView`, `CategorySchemaView` and friends. This
 * module is the only translation between them — nothing here decides anything,
 * and no new DTO is invented for either side.
 *
 * The generated section types are `unknown` (utoipa cannot name an
 * `op_workflow` type it does not derive `ToSchema` for), so the narrowed
 * aliases below restate them from `listing_core::envelope::RowPayload` — the
 * one shape those keys are written in.
 */
import type { components } from "@/api/schema"
import type {
  CategoryComplexGroup,
  CategoryFieldOption,
  CategoryFieldView,
  CategorySchemaView,
  CategoryTreeNodeView,
  WorkflowAiFieldPolicy,
  WorkflowCategoryDraft,
  WorkflowDraftValue,
  WorkflowVideoMetadata,
  QueueHaltReason,
  WorkflowLanguage,
  WorkflowValidationIssue,
} from "./commands"

type RawRowView = components["schemas"]["ListingRowView"]

/** `listing_rows` as the SPA reads it: the four states plus the six sections. */
export type ListingRowView = Omit<
  RawRowView,
  "draft" | "validation_issues" | "media" | "render_evidence" | "ai" | "source"
> & {
  draft: WorkflowCategoryDraft
  validation_issues: WorkflowValidationIssue[]
  media: unknown
  render_evidence?: unknown
  ai: unknown
  source: { assetId?: string; sha256?: string; fileName?: string }
}

export type ListingCardView = components["schemas"]["ListingCardView"]

/**
 * `listing_cards.payload` (`listing_core::envelope::CardPayload`).
 *
 * `aiPrompt` / `aiPromptFileName` / `targetStoreId` / `supplierUnavailable` /
 * `size` / `queue.haltReason` are the SPA's own annotations: `CardPayload` has
 * no field for them, so Cloud lists them in `card_annotations::ANNOTATION_KEYS`
 * and carries them untouched. Any other top-level key is refused: create,
 * copy and `PATCH` decode the document the way every read does and answer 400,
 * so a new SPA-owned key must be added to that list first.
 */
export interface CardPayload {
  supplierProductId?: string
  supplierUnavailable?: boolean
  categoryKey: string
  descriptionCategoryId: number
  typeId: number
  language: WorkflowLanguage
  defaults: WorkflowCategoryDraft
  aiPromptId: string
  aiPromptSha256: string
  /** Saved display copy; recognition executes the Cloud Job snapshot. */
  aiPrompt: string
  aiPromptFileName: string
  /** Live supplier spec; projected onto the list, not a stored card field. */
  size?: string
  psdTemplateAssetId: string
  psdTemplateSha256: string
  psdTemplateFileName: string
  /**
   * Every Store this card may publish to, comma-separated. The `store_id`
   * column holds one uuid, and a card is bound to as many Stores as its rows
   * are spread across (`store-quota.ts::parseStoreIds`).
   */
  targetStoreId: string
  aiFieldPolicy: WorkflowAiFieldPolicy
  /** Reusable videos copied into each new Product Instance. */
  videos: WorkflowVideoMetadata[]
  videoCover?: WorkflowVideoMetadata
  queue: CardQueue
}

/** The publish lane's cursor, owned by the card and fenced by its revision. */
export interface CardQueue {
  paused: boolean
  stopAfterCurrent: boolean
  nextPosition: number
  frozenRowIds: string[]
  /** Why the lane halted. SPA-owned: pause and stop are the only writers. */
  haltReason?: QueueHaltReason
}

export const EMPTY_DRAFT: WorkflowCategoryDraft = { values: {}, complex_values: [] }

/** Display text for a card default price field (`price` / `old_price`), if set. */
export function draftPriceText(
  draft: WorkflowCategoryDraft,
  fieldKey = "price",
): string | undefined {
  const value = draft.values[fieldKey]
  if (!value) return undefined
  switch (value.kind) {
    case "decimal":
    case "integer":
      return String(value.value)
    case "text": {
      const text = value.value.trim()
      return text || undefined
    }
    default:
      return undefined
  }
}

/**
 * Write or clear one card default field. `undefined` removes the value and
 * marks it cleared (the same shape `writeWorkflowValue` gives a Product
 * Instance row).
 */
export function withDefaultFieldValue(
  defaults: WorkflowCategoryDraft,
  fieldKey: string,
  value: WorkflowDraftValue | undefined,
): WorkflowCategoryDraft {
  const values = { ...defaults.values }
  const cleared = new Set(defaults.cleared ?? [])
  if (value === undefined) {
    delete values[fieldKey]
    cleared.add(fieldKey)
  } else {
    values[fieldKey] = value
    cleared.delete(fieldKey)
  }
  const nextCleared = [...cleared]
  return nextCleared.length
    ? { ...defaults, values, cleared: nextCleared }
    : { ...defaults, values, cleared: undefined }
}

/**
 * Best-effort card-default read when no Category Schema is at hand (the card
 * list only carries the coordinate). Live catalog schemas key an attribute
 * `attribute_{id}`; local fixtures use the prose alias. Writes always resolve
 * the key through the Card's Schema first, so this is display-only.
 */
export function draftAttributeValue(
  draft: WorkflowCategoryDraft | undefined,
  attributeId: number,
  alias: string,
): WorkflowDraftValue | undefined {
  if (!draft) return undefined
  return draft.values[`attribute_${attributeId}`] ?? draft.values[alias]
}

/** `payload.handEditedKeys` — the field keys the operator typed on this row. */
export function rowHandEditedKeys(row: ListingRowView): string[] {
  const keys = (row.payload as { handEditedKeys?: unknown } | undefined)
    ?.handEditedKeys
  return Array.isArray(keys)
    ? keys.filter((key): key is string => typeof key === "string")
    : []
}

export function cardPayload(card: ListingCardView): CardPayload {
  const payload = (card.payload ?? {}) as Partial<CardPayload> & Record<string, unknown>
  return {
    ...payload,
    categoryKey: payload.categoryKey ?? "",
    descriptionCategoryId: payload.descriptionCategoryId ?? 0,
    typeId: payload.typeId ?? 0,
    language: payload.language ?? "default",
    defaults: payload.defaults ?? EMPTY_DRAFT,
    aiPromptId: payload.aiPromptId ?? "",
    aiPromptSha256: payload.aiPromptSha256 ?? "",
    aiPrompt: payload.aiPrompt ?? "",
    aiPromptFileName: payload.aiPromptFileName ?? "",
    size: typeof payload.size === "string" && payload.size.trim() ? payload.size.trim() : undefined,
    psdTemplateAssetId: payload.psdTemplateAssetId ?? "",
    psdTemplateSha256: payload.psdTemplateSha256 ?? "",
    psdTemplateFileName: payload.psdTemplateFileName ?? "",
    // The column is the fallback: a card written before the list existed is
    // bound to the one Store Cloud filed it under.
    targetStoreId: payload.targetStoreId ?? card.store_id ?? "",
    aiFieldPolicy: payload.aiFieldPolicy ?? { allowed_field_keys: [], protected_field_keys: [] },
    videos: payload.videos ?? [],
    videoCover: payload.videoCover,
    queue: {
      paused: payload.queue?.paused ?? false,
      stopAfterCurrent: payload.queue?.stopAfterCurrent ?? false,
      nextPosition: payload.queue?.nextPosition ?? 0,
      frozenRowIds: payload.queue?.frozenRowIds ?? [],
      haltReason: payload.queue?.haltReason,
    },
  }
}

/** `payload.queuePosition` — the operator's row order, an SPA-owned key. */
export function rowQueuePosition(row: ListingRowView): number | undefined {
  const value = (row.payload as { queuePosition?: unknown } | undefined)?.queuePosition
  return typeof value === "number" ? value : undefined
}

/** `payload.categoryKey`, the generated column `listing_rows.category_key`. */
export function categoryKey(
  descriptionCategoryId: number,
  typeId: number,
  language: WorkflowLanguage = "default",
): string {
  return `${descriptionCategoryId}:${typeId}:${language}`
}

// --- catalog ---------------------------------------------------------------

type CatalogSchemaData = components["schemas"]["CatalogSchemaData"]
type CatalogSchemaField = components["schemas"]["CatalogSchemaField"]
type CatalogTreeNode = components["schemas"]["CatalogTreeNode"]

function optionalNumber(value: string | null | undefined): number | undefined {
  if (value === null || value === undefined || value === "") return undefined
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : undefined
}

function catalogFieldView(field: CatalogSchemaField): CategoryFieldView {
  return {
    key: field.key,
    name: field.label,
    description: field.description ?? "",
    group_name: field.group,
    // The Cloud cache stores the Seller attribute id; a field without one is a
    // fixed Listing field. Same rule as `listing_core::projections`.
    source: field.attribute_id ? "attribute" : "fixed",
    editor: field.editor,
    raw_type: field.raw_type ?? undefined,
    attribute_id: optionalNumber(field.attribute_id),
    complex_id: optionalNumber(field.complex_id),
    complex_group_collection: field.complex_group_collection ?? false,
    read_only: field.read_only ?? false,
    // An absent key on the wire is the same fact as an explicit `null`: the
    // payload predates `is_aspect`. Collapsing it to `false` here would let
    // the browser conclude "no variant dimensions" from material that only
    // says "not asked".
    aspect: field.aspect ?? null,
    constraints: {
      required: field.required,
      collection: field.collection,
      max_value_count: field.max_value_count ?? undefined,
      dictionary_id: optionalNumber(field.dictionary_id),
    },
    options: (field.options ?? []).map(
      (option): CategoryFieldOption => ({
        id: Number(option.id) || 0,
        value: option.value,
        info: option.info ?? "",
        picture: option.picture ?? "",
      }),
    ),
    options_truncated: field.options_truncated ?? false,
  }
}

/** Complex groups are derived from the fields that name one, ascending by id. */
function complexGroups(fields: readonly CategoryFieldView[]): CategoryComplexGroup[] {
  const grouped = new Map<number, CategoryComplexGroup>()
  for (const field of fields) {
    if (field.complex_id === undefined) continue
    const group = grouped.get(field.complex_id) ?? {
      complex_id: field.complex_id,
      name: field.group_name,
      collection: false,
      field_keys: [],
    }
    group.collection ||= field.complex_group_collection
    group.field_keys.push(field.key)
    grouped.set(field.complex_id, group)
  }
  return [...grouped.entries()].sort(([a], [b]) => a - b).map(([, group]) => group)
}

export function catalogSchemaView(data: CatalogSchemaData): CategorySchemaView {
  const fields = data.fields.map(catalogFieldView)
  return {
    description_category_id: data.description_category_id,
    type_id: data.type_id,
    language: data.language,
    fields,
    complex_groups: complexGroups(fields),
  }
}

export function catalogTreeNodes(nodes: readonly CatalogTreeNode[]): CategoryTreeNodeView[] {
  // The tree ships flat: every node carries its parent's type_id and roots carry null.
  const views = new Map<number, CategoryTreeNodeView>()
  const childrenOf = new Map<number, CategoryTreeNodeView[]>()
  const roots: CategoryTreeNodeView[] = []
  for (const node of nodes) {
    const view: CategoryTreeNodeView = {
      description_category_id: node.description_category_id,
      category_name: node.category_name,
      type_id: node.type_id,
      type_name: node.type_name,
      disabled: node.disabled,
      children: [],
    }
    views.set(node.type_id, view)
    if (node.parent_id == null) roots.push(view)
    else {
      const siblings = childrenOf.get(node.parent_id) ?? []
      siblings.push(view)
      childrenOf.set(node.parent_id, siblings)
    }
  }
  for (const [parentTypeId, siblings] of childrenOf) {
    const parent = views.get(parentTypeId)
    if (parent) parent.children = siblings
    else roots.push(...siblings)
  }
  return roots
}

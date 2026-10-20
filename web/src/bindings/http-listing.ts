/**
 * Listing HTTP wire: cards, rows, catalog, prompts, videos, operations, queue.
 *
 * Screens import `listingHttp` directly. This file is the binding — no
 * browser orchestration, and (architecture gate) no importing a `features/*`
 * module. Card *writes* are the one operation this file cannot own end to
 * end: they must route through the Card's session (single owner
 * `features/workflow/card/card-session.ts`, specs/browser-owned-listing
 * slices/04-card-session.md) for "GET once, PATCH many" — so those functions
 * (`patchListingCard`, `saveCardDefaultField`, `writeQueueState`,
 * `listingCardSaveCategoryDraft`/`SaveDefaultField`/`SaveDefaultPrice`/
 * `SaveStore`/`SavePsd`, `workflowSaveQueueState`/`PublishPause`/`PublishStop`)
 * live in `features/workflow/card/card-writes.ts` instead, built on the wire-only pieces this file
 * exports for them (`cardSummaryView`, `primaryStoreId`, `cardQueueRunning`,
 * `queueStateView`, `cardDraftView`, `createListingCardBody`). Workflow
 * actions live in `web/src/features/workflow/workflow-actions.ts`.
 */
import { api, request } from "@/api/client"
import { sharedListingCore } from "@/listing-core/client"
import type { ListingFieldEditor } from "@/listing-core/types"
import { retryWhenBusy } from "@/api/busy-retry"
import { route } from "@/api/routes"
import type { components } from "@/api/schema"
import {
  forgetCardRows,
  forgetListingRows,
  readListingRowFresh,
  rememberListingRows,
  rowCacheScope,
} from "./listing-row-cache"
import {
  CATALOG_FILL_RETRY,
  readCategorySchema,
  rememberDictionaryHits,
  residentCategorySchema,
  type CategoryCoordinate,
} from "./listing-material-cache"
import {
  cardPayload,
  catalogTreeNodes,
  draftPriceText,
  type CardPayload,
  type ListingCardView as CloudListingCardView,
  type ListingRowView,
} from "./listing-projection"
import { refuse } from "./refusal"
import type {
  CancelPrepareRequest,
  CategoryDictionarySearchRequest,
  CategorySchemaRequest,
  CategorySchemaView,
  CategoryTreeRequest,
  FieldValueOrigin,
  ListingCardSkuImportPreviewRequest,
  ListingCardSummary,
  OperationStatus,
  SaveCategoryPromptRequest,
  SaveCategoryVideoRequest,
  SaveWorkflowDraftRequest,
  SkuImportPreview,
  SubmitDraftResponse,
  WorkflowCategoryPrompt,
  WorkflowCategoryVideo,
  WorkflowDraftValue,
  WorkflowDraftView,
  WorkflowProductLifecycle,
  WorkflowQueueState,
} from "./commands"

/** Append the filter pairs a catalog query actually set; blanks stay off the URL. */
function filterQuery(filters: Record<string, string | undefined>): string {
  const search = new URLSearchParams()
  for (const [key, value] of Object.entries(filters)) {
    const text = value?.trim()
    if (text) search.append(key, text)
  }
  const query = search.toString()
  return query ? `&${query}` : ""
}

// --- listing workbench ------------------------------------------------------

const LISTING_ROWS = route("listingRows")

function rowPath(rowId: string, suffix = ""): string {
  return `${LISTING_ROWS}/${encodeURIComponent(rowId)}${suffix}`
}

/** Always a fresh GET; the reply also refreshes the tab's raw row cache. */
export function readListingRow(rowId: string): Promise<ListingRowView> {
  return readListingRowFresh(rowId)
}

/** A cache miss committed no mutation; refresh once and repeat the same request. */
async function retrySchemaSync<T>(run: () => Promise<T>, sync: () => Promise<unknown>): Promise<T> {
  try {
    return await run()
  } catch (reason) {
    if ((reason as { code?: string }).code !== "cloud_schema_sync_required") throw reason
    await sync()
    return run()
  }
}

/**
 * 会话级 Schema revision 缓存。行载荷自带内容寻址的
 * `schemaRevision`，同一 revision 的字段材料不可变：命中即不再 GET
 * `/api/catalog/schema`。只在对应关系可证时写入——一次 schema 同步 GET 之后
 * 重放成功的请求，其返回行的 revision 就是从刚同步到的材料重算出来的。
 * 这里属于 wire 层的 HTTP 缓存语义。
 */
const schemasByRevision = new Map<string, CategorySchemaView>()

/** 命中返回该 revision 的类目 Schema；未命中或无 revision 返回 undefined。 */
export function cachedCategorySchema(
  revision: string | undefined,
): CategorySchemaView | undefined {
  if (!revision) return undefined
  return schemasByRevision.get(revision)
}

function rememberCategorySchema(revision: string | undefined, schema: CategorySchemaView): void {
  if (!revision) return
  schemasByRevision.set(revision, schema)
}

/** 测试隔离：清空会话缓存。 */
export function resetCategorySchemaCache(): void {
  schemasByRevision.clear()
}

/** 保存/创建返回行携带的 schemaRevision——缓存键的事实源。 */
function rowSchemaRevision(result: unknown): string | undefined {
  const revision = (result as { payload?: { schemaRevision?: unknown } } | undefined)?.payload
    ?.schemaRevision
  return typeof revision === "string" && revision !== "" ? revision : undefined
}

/** Reuse loaded rows and sync each category once, including mixed-category batches. */
export function withListingSchemaSync<T>(rows: readonly ListingRowView[] | string | (() => Promise<readonly ListingRowView[]>), run: () => Promise<T>): Promise<T> {
  const loadAll = async (): Promise<Map<string, CategorySchemaView>> => {
    const sources = typeof rows === "function" ? await rows() : typeof rows === "string" ? [await readListingRow(rows)] : rows
    const schemas = new Map<string, { request: CategorySchemaRequest, revision?: string }>()
    for (const row of sources) {
      const payload = row.payload as Pick<CardPayload, "descriptionCategoryId" | "typeId" | "language"> & { schemaRevision?: string }
      const key = `${payload.descriptionCategoryId}:${payload.typeId}:${payload.language}`
      if (schemas.get(key)?.request.target_store_id) continue
      schemas.set(key, {
        request: {
          description_category_id: payload.descriptionCategoryId,
          type_id: payload.typeId,
          language: payload.language,
          target_store_id: row.store_id ?? undefined,
        },
        revision: payload.schemaRevision,
      })
    }
    const loaded = new Map<string, CategorySchemaView>()
    for (const [key, { request, revision }] of schemas) {
      const cached = cachedCategorySchema(revision)
      loaded.set(key, cached ?? await loadCategorySchema(request))
    }
    return loaded
  }
  // Inlined retry (not retrySchemaSync): the replay's result is what proves
  // which revision the just-served schema material belongs to.
  return (async () => {
    try {
      return await run()
    } catch (reason) {
      if ((reason as { code?: string }).code !== "cloud_schema_sync_required") throw reason
      const loaded = await loadAll()
      const result = await run()
      const revision = rowSchemaRevision(result)
      if (revision) {
        // Only the schema whose category key matches the replayed row belongs
        // to this revision — remembering every loaded schema under one key
        // binds category B's schema to category A's revision for the session.
        const payload = (result as { payload?: Record<string, unknown> } | undefined)?.payload
        const match = payload
          ? `${payload.descriptionCategoryId}:${payload.typeId}:${payload.language}`
          : undefined
        const schema = match ? loaded.get(match) : undefined
        if (schema) rememberCategorySchema(revision, schema)
      }
      return result
    }
  })()
}

/**
 * Read-modify-write one payload section under the row's own revision CAS.
 *
 * `changes` is a top-level merge (`payload || patch`), so a section handed in
 * whole replaces that section and leaves every other one alone. The read is
 * what supplies `baseRevision`: a 409 here means someone else wrote the row
 * between the two calls, which is the answer the caller wants.
 */
export async function mergeListingRow(
  rowId: string,
  build: (row: ListingRowView) => Record<string, unknown>,
): Promise<ListingRowView> {
  const row = await readListingRow(rowId)
  return patchListingRow(rowId, { baseRevision: row.revision, changes: build(row) }, row)
}

/**
 * One `PATCH /api/listing/rows/{id}`.
 *
 * `PatchListingRowResponse` *is* the `{data, plan, issues}` envelope, and
 * `api.patch` already returns what is under `data` — reading `.data` off that
 * again is one unwrap too many and yields `undefined` against the real service.
 */
export function patchListingRow(
  rowId: string,
  body: Record<string, unknown>,
  row?: ListingRowView | (() => Promise<ListingRowView>),
): Promise<ListingRowView> {
  // A row the caller already read rides along for a schema-sync retry; a
  // resolver is read once only if that retry actually fires.
  const context =
    row === undefined ? rowId : typeof row === "function" ? async () => [await row()] : [row]
  const scope = rowCacheScope()
  return withListingSchemaSync(context, async () => {
    const saved = await api.patch<ListingRowView>(rowPath(rowId), body)
    rememberListingRows([saved], scope)
    return saved
  })
}

/**
 * The editor vocabulary the card-default sync used to send to
 * `POST /api/listing/field-equality`. `dictionary` is `multi_select`:
 * that route mapped it the same way before the comparison moved into WASM.
 */
export type FieldEqualityEditor =
  | "decimal"
  | "integer"
  | "dictionary"
  | "boolean"
  | "url"
  | "text"

export function listingEditorForFieldEquality(editor: FieldEqualityEditor): ListingFieldEditor {
  switch (editor) {
    case "decimal":
      return "decimal"
    case "integer":
      return "integer"
    case "dictionary":
      return "multi_select"
    case "boolean":
      return "boolean"
    case "url":
      return "url"
    case "text":
      return "text"
  }
}

/** `listing_core::ops::values_equal` in WASM. This function does not compare. */
export function fieldValuesEqual(
  editor: FieldEqualityEditor,
  left: WorkflowDraftValue | undefined,
  right: WorkflowDraftValue | undefined,
): Promise<boolean> {
  return sharedListingCore().valuesEqual({
    editor: listingEditorForFieldEquality(editor),
    left: left ?? null,
    right: right ?? null,
  })
}

/**
 * The operator vouches that these rows' unanswered sends never reached Ozon.
 * Cloud retires their `unknown` Intents so the rows become sendable again and
 * answers with the rows it actually released (a row still held by a running
 * dispatch stays unknown).
 */
export async function releaseUnknownListingRows(rowIds: string[]): Promise<string[]> {
  const data = await api.post<components["schemas"]["ReleaseUnknownListingRowsData"]>(
    route("listingRowsReleaseUnknown"),
    { rowIds },
  )
  return data.released_row_ids
}

/** Clear the server-owned brand hashtag conflict and enqueue this row atomically. */
export async function repairAndSubmitListingRow(
  rowId: string,
  expectedRevision: number,
): Promise<components["schemas"]["SubmitListingBatchItemData"]> {
  const data = await api.post<components["schemas"]["SubmitListingBatchData"]>(
    `${rowPath(rowId)}/repair-and-submit`,
    { expectedRevision },
  )
  const item = data.items[0]
  if (!item) throw new Error("修复发送未返回商品状态")
  return item
}

// --- listing cards ----------------------------------------------------------

const LISTING_CARDS = route("listingCards")

function cardPath(cardId: string, suffix = ""): string {
  return `${LISTING_CARDS}/${encodeURIComponent(cardId)}${suffix}`
}

export function readListingCard(cardId: string): Promise<CloudListingCardView> {
  return api.get<CloudListingCardView>(cardPath(cardId))
}

/** Create the listing plan already bound to one supplier specification. */
export function createListingCardFromSupplier(supplierProductId: string): Promise<Pick<CloudListingCardView, "id">> {
  const productId = supplierProductId.trim()
  if (!productId) throw new Error("缺少供应商商品规格")
  return api.post<Pick<CloudListingCardView, "id">>(LISTING_CARDS, {
    createMode: "fromSupplier",
    supplierProductId: productId,
  })
}

/** Schedule this Card's unknown/accepted intents for read-only probes. */
export function reconcileListingCard(cardId: string): Promise<{ scheduledCount: number }> {
  return api.post<{ scheduledCount: number }>(cardPath(cardId, "/reconcile"))
}

/** Fail closed: an unknown state is never silently painted as queued. */
function operationStatus(raw: string): OperationStatus {
  switch (raw) {
    case "queued":
    case "recorded":
      return "queued"
    case "dispatching":
    case "succeeded":
    case "failed":
    case "result_unknown":
    case "reconciled":
    case "conflict":
    case "operator_attested":
      return raw
    default:
      return "unknown"
  }
}

/** Explicit operator recovery for one Result Unknown intent. */
export async function recoverListingIntent(intentId: string): Promise<SubmitDraftResponse> {
  const data = await api.post<components["schemas"]["SubmitListingBatchData"]>(
    route("listingIntentsByIdRecover", { id: intentId }),
  )
  const item = data.items[0]
  if (!item?.created || !item.intent) throw new Error(item?.detail || "该商品当前不能恢复发送")
  return {
    operation: {
      run_id: item.intent.id,
      draft_id: item.row_id,
      offer_id: "",
      status: operationStatus(item.intent.state),
      idempotency_key: item.intent.client_operation_id,
      intent_id: item.intent.id,
      created_at_ms: item.intent.updated_at_ms,
      updated_at_ms: item.intent.updated_at_ms,
    },
    replayed: false,
  }
}

/** The first bound Store: what `listing_cards.store_id` can hold. */
export function primaryStoreId(targetStoreId: string): string | undefined {
  return targetStoreId.split(",")[0]?.trim() || undefined
}

/** POST `/api/listing/cards` body. */
export function createListingCardBody(
  request: Pick<SaveWorkflowDraftRequest, "createMode">,
  title: string,
  targetStoreId: string,
  payload: CardPayload,
) {
  const createMode = request.createMode ?? "blank"
  return {
    title,
    storeId: primaryStoreId(targetStoreId),
    payload,
    createMode,
  }
}

/** The card's coordinate, without the fields — those cost a catalog read. */
export function coordinateSchema(payload: CardPayload): CategorySchemaView {
  return {
    description_category_id: payload.descriptionCategoryId,
    type_id: payload.typeId,
    language: payload.language,
    fields: [],
    complex_groups: [],
  }
}

/**
 * One Cloud card as the workbench's card template Draft.
 *
 * `schema` is the caller's: the coordinate alone comes off the card, and the
 * fields are a `GET /api/catalog/schema` the reader already had to make. A card
 * has no lifecycle of its own — every rail below belongs to a row — so the
 * template gets the empty one `savedFormTitle` and the tile expect.
 */
export function cardDraftView(
  card: CloudListingCardView,
  schema: CategorySchemaView,
): WorkflowDraftView {
  const payload = cardPayload(card)
  return {
    draft_id: card.id,
    kind: "template",
    display_name: card.title,
    schema,
    draft: payload.defaults,
    validation_state: "draft",
    issues: [],
    supplier_product_id: payload.supplierProductId,
    ai_prompt_id: payload.aiPromptId,
    ai_prompt: payload.aiPrompt,
    ai_prompt_file_name: payload.aiPromptFileName,
    size: payload.size?.trim() || undefined,
    // The digest is the template identity (`psdTemplateSha256`).
    psd_template_asset_id: payload.psdTemplateSha256 || payload.psdTemplateAssetId,
    psd_template_file_name: payload.psdTemplateFileName,
    target_store_id: payload.targetStoreId,
    ai_field_policy: payload.aiFieldPolicy,
    lifecycle: cardLifecycle(card, payload),
    updated_at_ms: card.updated_at_ms,
  }
}

/**
 * A card has no Product Instance rails, but its reusable videos are real Card
 * fields and are copied into every new row by Cloud.
 */
const EMPTY_CARD_LIFECYCLE: WorkflowProductLifecycle = {
  revision: 0,
  view_revision: 0,
  stage: "awaiting_content",
  ai: "pending",
  media: "pending",
  image_total: 0,
  image_completed: 0,
  fields: "dirty",
  images: [],
  failure_log: [],
  ai_candidates: [],
  product_videos: [],
}

export function cardLifecycle(
  card: CloudListingCardView,
  payload = cardPayload(card),
): WorkflowProductLifecycle {
  return {
    ...EMPTY_CARD_LIFECYCLE,
    revision: card.revision,
    product_videos: payload.videos,
    video_cover: payload.videoCover,
  }
}

export function cardSummaryView(card: CloudListingCardView): ListingCardSummary {
  const payload = cardPayload(card)
  return {
    supplier_product_id: payload.supplierProductId,
    supplier_unavailable: payload.supplierUnavailable,
    draft_id: card.id,
    display_name: card.title,
    description_category_id: payload.descriptionCategoryId,
    type_id: payload.typeId,
    language: payload.language || "zh_hans",
    size: payload.size?.trim() || undefined,
    price: draftPriceText(payload.defaults),
    old_price: draftPriceText(payload.defaults, "old_price"),
    defaults: payload.defaults,
    ai_prompt_file_name: payload.aiPromptFileName,
    psd_template_file_name: payload.psdTemplateFileName,
    target_store_id: payload.targetStoreId,
    video_count: payload.videos.length,
    updated_at_ms: card.updated_at_ms,
  }
}

/**
 * The queue as the workbench reads it. `paused`, `stopAfterCurrent`,
 * `nextPosition` and `frozenRowIds` are the card's document; `running` is
 * derived; and the lane claim, the lease owner and the pid have no browser
 * meaning — the card `revision` is the whole fence, so there is no second
 * token to hand out.
 */
export function queueStateView(card: CloudListingCardView, running: boolean): WorkflowQueueState {
  const payload = cardPayload(card)
  return {
    parent_card_id: card.id,
    target_store_id: payload.targetStoreId,
    paused: payload.queue.paused,
    running,
    stop_after_current: payload.queue.stopAfterCurrent,
    next_position: payload.queue.nextPosition,
    frozen_row_ids: payload.queue.frozenRowIds,
    updated_at_ms: card.updated_at_ms,
    claim_token: "",
    revision: card.revision,
    owner_runtime_id: "",
    owner_pid: 0,
    halt_reason: payload.queue.haltReason,
  }
}

/**
 * Is Cloud still publishing this card's frozen cohort? `submission_state` is
 * the fact; nothing is stored that says "running", because a stored flag would be
 * a second state machine to keep in sync. A queue that never froze a cohort is not
 * running and costs no read.
 *
 * ponytail: reads the cohort. A `cardId` filter on `GET /api/listing/intents`
 * would make it one page regardless of card size.
 */
export async function cardQueueRunning(cardId: string, frozen: readonly string[]): Promise<boolean> {
  if (!frozen.length) return false
  return (await cardRows(cardId)).some(
    (row) => row.submission_state === "queued" || row.submission_state === "submitting",
  )
}

export async function readQueueState(cardId: string): Promise<WorkflowQueueState> {
  const card = await readListingCard(cardId)
  return queueStateView(card, await cardQueueRunning(cardId, cardPayload(card).queue.frozenRowIds))
}

/**
 * The opt-in same-design association one create request claims.
 *
 * The client sends the *inputs* — which supplier row the design came from and
 * that row's non-empty variant group — never the derived batch key or 型号:
 * the server derives both from Workspace + supplier database + variant group +
 * source image digest, and re-checks them against the Card's own supplier
 * binding. An empty variant group is refused (400): 空款号不自动关联.
 */
export type ListingRowAssociation = { supplierSourceId: string, variantGroup: string }

/**
 * One Product Instance's create request.
 *
 * `createKey` + `requestFingerprint` are the operation identity of one
 * (Card + selected source image): a retry reuses them verbatim and the server
 * answers with the row the key already named, so a lost response never mints a
 * second row. Both travel together or not at all.
 */
export type CreateListingRowBody = {
  cardId: string
  storeId?: string
  source: { sha256: string, fileName: string }
  createKey?: string
  requestFingerprint?: string
  association?: ListingRowAssociation
}

/**
 * What a create did: the row, and whether this request created it.
 *
 * `created: false` is an idempotent replay — a retry after a timeout, or a
 * concurrent duplicate — and `row` is the row the key named the first time.
 * A replay is success; the caller must never treat it as a failure or mint a
 * new key to get around it.
 */
export type ListingRowCreateOutcome = { row: ListingRowView, created: boolean }

/**
 * One Product Instance under a card.
 *
 * Cloud uses the card's coordinate and current category fields. The browser
 * sends the card, Store and digest of its OPFS source — never a row payload.
 * A cold Category Schema cache answers 409 `schema_sync_required`, which the
 * SPA handles by syncing through the card's Store and retrying once. A
 * repeated miss is reported instead of looping.
 */
export async function createListingRowOnce(
  card: CardPayload,
  body: CreateListingRowBody,
): Promise<ListingRowCreateOutcome> {
  let synced: CategorySchemaView | undefined
  const scope = rowCacheScope()
  // The create answers with `created` beside the row, so this call reads the
  // envelope whole: unwrapping `data` here would hide whether the row was
  // created or replayed, which is the whole point of the create key.
  const envelope = await retrySchemaSync(
    () => request<{ data: ListingRowView, created: boolean }>(
      "POST", LISTING_ROWS, body, {}, undefined, undefined, { responseBody: "json" },
    ),
    async () => {
      synced = await cardCategorySchema(card)
    },
  )
  const row = envelope.data
  // The created row pinned the revision derived from the material this sync
  // just served — an exact (revision → Schema) binding.
  if (synced) rememberCategorySchema(rowSchemaRevision(row), synced)
  rememberListingRows([row], scope)
  return { row, created: envelope.created !== false }
}

export async function createListingRow(
  card: CardPayload,
  body: CreateListingRowBody,
): Promise<ListingRowView> {
  return (await createListingRowOnce(card, body)).row
}

export function cardCategorySchema(payload: CardPayload): Promise<CategorySchemaView> {
  return loadCategorySchema({
    description_category_id: payload.descriptionCategoryId,
    type_id: payload.typeId,
    language: payload.language,
    target_store_id: primaryStoreId(payload.targetStoreId),
  })
}

/**
 * A card's whole cohort, in the queue order Cloud sorts it into. `MAX_SOURCE_BATCH`
 * is 1000 rows and the page clamps at 100, so the cursor is followed to the end:
 * a card read that stopped at the first page would hide rows, not just delay them.
 */
export async function cardRows(cardId: string, isCurrent?: () => boolean): Promise<ListingRowView[]> {
  const rows: ListingRowView[] = []
  const scope = rowCacheScope()
  let cursor: string | undefined
  do {
    if (isCurrent && !isCurrent()) throw new Error("Card observation is no longer active")
    const page = await api.get<{ items: ListingRowView[], nextCursor?: string }>(
      `${LISTING_ROWS}?cardId=${encodeURIComponent(cardId)}&limit=100` +
        (cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""),
    )
    rows.push(...page.items)
    rememberListingRows(page.items, scope)
    cursor = page.nextCursor
  } while (cursor)
  return rows
}

// --- prompts, videos, operations --------------------------------------------

function categoryPrompt(data: components["schemas"]["CategoryPromptData"]): WorkflowCategoryPrompt {
  return {
    prompt_id: data.prompt_id,
    name: data.name,
    file_name: data.file_name,
    content: data.content ?? "",
    fixed_tags: Array.isArray(data.fixed_tags)
      ? data.fixed_tags.filter((tag): tag is string => typeof tag === "string")
      : [],
    description_category_id: data.description_category_id,
    type_id: data.type_id,
  }
}

function categoryVideo(data: components["schemas"]["CategoryVideoData"]): WorkflowCategoryVideo {
  return {
    video_id: data.video_id,
    name: data.name,
    video_url: data.video_url,
    duration_ms: data.duration_ms,
    description_category_id: data.description_category_id,
    type_id: data.type_id,
  }
}

function schemaCoordinate(request: Pick<CategorySchemaRequest, "description_category_id" | "type_id" | "language">): CategoryCoordinate {
  return { descriptionCategoryId: request.description_category_id, typeId: request.type_id, language: request.language }
}

// A cold coordinate or tree is filled by one request at a time; the others get
// 503 + Retry-After until the cache is written, so wait instead of failing.
// Each read also publishes the coordinate's native material (`listing-material-cache.ts`).
async function loadCategorySchema(request: CategorySchemaRequest): Promise<CategorySchemaView> {
  return (await readCategorySchema(schemaCoordinate(request))).view
}

export const listingHttp = {
  listingCardCreateFromSupplier: createListingCardFromSupplier,
  listingRowFieldOrigins: async (rowId: string) => {
    const row = await readListingRow(rowId).catch(() => undefined)
    return ((row?.payload ?? {}) as { fieldOrigins?: Array<FieldValueOrigin> }).fieldOrigins ?? []
  },
  operationsCancelPrepare: async (cancel: CancelPrepareRequest) => {
    const draftIds = cancel.draft_ids
      .map((id) => id.trim())
      .filter((id) => id.length > 0 && id.length <= 128)
    if (draftIds.length === 0) return { attempted: 0, cancelled: 0 }
    if (draftIds.length > 500) {
      throw refuse("operations_cancel_prepare_invalid", "Too many draft identifiers")
    }
    let cancelled = 0
    for (const draftId of draftIds) {
      const data = await api.post<components["schemas"]["CancelPrepareListingRowData"]>(
        route("listingRowsByIdPrepareCancel", { id: draftId }),
      )
      cancelled += data.jobs.length
    }
    return { attempted: draftIds.length, cancelled }
  },
  listingCardLoadCategorySchema: loadCategorySchema,
  listingCardLoadCategoryTree: async (request: CategoryTreeRequest) => {
    const data = await retryWhenBusy(() => api.get<components["schemas"]["CatalogTreeResponse"]>(
      `${route("catalogTree")}?language=${request.language ?? "default"}` +
        filterQuery({ store_id: request.target_store_id }),
    ), CATALOG_FILL_RETRY)
    return catalogTreeNodes(data?.items ?? [])
  },
  // Dictionary search uses the same platform credentials as category schema.
  listingCardSearchCategoryDictionary: async (request: CategoryDictionarySearchRequest) => {
    if (request.query.trim().length < 2) {
      throw refuse("workflow_dictionary_query_short", "搜索词至少两个字符")
    }
    const coordinate = schemaCoordinate(request)
    const resident = await residentCategorySchema(coordinate)
    const field = resident.view.fields.find((candidate) => candidate.key === request.field_key)
    if (field?.attribute_id === undefined || field.constraints.dictionary_id === undefined) {
      throw refuse("workflow_field_has_no_dictionary", "该字段没有字典可搜索")
    }
    const response = await api.post<components["schemas"]["CatalogSchemaOption"][]>(
      route("catalogSchemaDictionarySearch"),
      {
        attribute_id: field.attribute_id,
        description_category_id: request.description_category_id,
        type_id: request.type_id,
        language: request.language ?? "default",
        limit: Math.min(Math.max(request.limit, 1), 100),
        value: request.query.trim(),
      },
    )
    // Cloud persisted exactly these hits for truncated dictionaries; mirror them.
    if (field.options_truncated) {
      await rememberDictionaryHits(coordinate, resident, field.attribute_id, field.constraints.dictionary_id, response)
    }
    return response.map((option) => ({
      id: Number(option.id),
      value: option.value,
      info: option.info ?? "",
      picture: option.picture ?? "",
    }))
  },
  // The Seller SKU read and the projection onto this card's Schema both happen
  // in Cloud; the browser sends the SKU and gets a preview back. Nothing is
  // written, here or on Ozon.
  listingCardPreviewSkuImport: (request: ListingCardSkuImportPreviewRequest) =>
    api.post<SkuImportPreview>(cardPath(request.draft_id, "/sku-import/preview"), {
      sku: request.sku,
    }),
  listingCardListSavedDrafts: async () =>
    (await api.get<{ items: CloudListingCardView[] }>(`${LISTING_CARDS}?limit=100`)).items.map(
      cardSummaryView,
    ),
  listingCardLoadCard: async (draftId: string) => {
    const card = await readListingCard(draftId)
    return cardDraftView(card, await cardCategorySchema(cardPayload(card)))
  },
  workflowLoadQueueState: (parentCardId: string) => readQueueState(parentCardId),
  /**
   * Copy the recipe, not the cohort: same payload, new id, `revision = 1`, no
   * rows. Product Instances belong to the batch that produced them.
   */
  listingCardCopySavedDraft: async (draftId: string) => {
    const copy = await api.post<CloudListingCardView>(cardPath(draftId, "/copy"))
    return cardDraftView(copy, coordinateSchema(cardPayload(copy)))
  },
  listingCardDeleteSavedDraft: async (draftId: string) => {
    await api.del<{ id: string, deletedRows: number }>(cardPath(draftId))
    forgetCardRows(draftId)
  },
  /** One Product Instance. Always deleted; Intents and Jobs stay. */
  listingRowDelete: async (rowId: string) => {
    await api.del<{ id: string, deletedRows: number }>(rowPath(rowId))
    forgetListingRows([rowId])
  },
  listingCardListCategoryPrompts: async (descriptionCategoryId: number, typeId: number) =>
    (
      await api.get<components["schemas"]["PromptCategoryListData"]>(
        route("promptsCategoryByDescriptionCategoryIdByTypeId", { description_category_id: descriptionCategoryId, type_id: typeId }),
      )
    ).prompts.map(categoryPrompt),
  listingCardListPromptLeaves: async () =>
    (await api.get<components["schemas"]["PromptLeavesData"]>(route("promptsCategories"))).leaves.map(
      (leaf) => ({
        description_category_id: leaf.description_category_id,
        type_id: leaf.type_id,
      }),
    ),
  listingCardSaveCategoryPrompt: async (save: SaveCategoryPromptRequest) => {
    const body = {
      description_category_id: save.description_category_id,
      type_id: save.type_id,
      name: save.name,
      content: save.content,
      file_name: save.file_name,
      fixed_tags: save.fixed_tags ?? [],
    }
    const promptId = save.prompt_id?.trim()
    const data = promptId
      ? await api.put<components["schemas"]["PromptMutationData"]>(
          route("adminPromptsByPromptId", { prompt_id: promptId }),
          body,
        )
      : await api.post<components["schemas"]["PromptMutationData"]>(route("adminPrompts"), body)
    return categoryPrompt(data.prompt)
  },
  listingCardDeleteCategoryPrompt: (promptId: string) =>
    api.del<void>(route("adminPromptsByPromptId", { prompt_id: promptId })),
  listingCardListCategoryVideos: async (descriptionCategoryId: number, typeId: number) =>
    (
      await api.get<components["schemas"]["VideoCategoryListData"]>(
        route("videosCategoryByDescriptionCategoryIdByTypeId", { description_category_id: descriptionCategoryId, type_id: typeId }),
      )
    ).videos.map(categoryVideo),
  listingCardSaveCategoryVideo: async (save: SaveCategoryVideoRequest) => {
    const body = {
      description_category_id: save.description_category_id,
      type_id: save.type_id,
      name: save.name,
      video_url: save.video_url,
      duration_ms: save.duration_ms,
    }
    const videoId = save.video_id?.trim()
    const data = videoId
      ? await api.put<components["schemas"]["VideoMutationData"]>(
          route("adminVideosByVideoId", { video_id: videoId }),
          body,
        )
      : await api.post<components["schemas"]["VideoMutationData"]>(route("adminVideos"), body)
    return categoryVideo(data.video)
  },
  listingCardDeleteCategoryVideo: (videoId: string) =>
    api.del<void>(route("adminVideosByVideoId", { video_id: videoId })),
}

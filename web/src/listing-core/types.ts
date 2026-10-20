/**
 * Per-op input/output shapes for `listing-core-wasm`'s `call(op, h, ptr, len)`
 * (browser-owned-listing slice 03, `rust/crates/listing-core-wasm/src/{dispatch,ops_row}.rs`
 * is the source of truth these mirror — a drift here fails
 * `web/tests/listing-core-wasm.test.ts` loudly, byte for byte, rather than
 * silently).
 *
 * These are deliberately **not** re-exported from `web/src/bindings/commands.ts`
 * (the OpenAPI-generated bindings for Cloud's *current* server-owned card/row
 * API): that surface is a transitional seam this same plan retires in slices
 * 17/18 (README S14, "过渡缝...浏览器里旧的云端行模块与新模块并存到切换"),
 * while `listing-core`'s WASM boundary is the permanent one. Depending on
 * generated types tied to code scheduled for deletion would make this
 * module's compile depend on a surface it is specifically here to replace.
 * The handful of shapes below are the independent, from-Rust-source copy
 * that decision requires.
 *
 * Nested Draft/Row internals not needed to route or validate a call at this
 * boundary (`WorkflowComplexDraftGroup`'s field map, `NormalizedListingSnapshot`,
 * render evidence) stay loosely typed (`JsonRecord`/`unknown`) rather than
 * fully modeled: no consumer needs field-level typing yet (slices 12+ build
 * the local row/card UI this feeds), and guessing their shape now would be
 * exactly the speculative abstraction AGENTS.md asks this repo to avoid.
 * Refine a shape here when a real caller needs one, not before.
 */

import type { components } from "@/api/schema"

export type KnownIssueKey = components["schemas"]["KnownIssueKey"]
export type ProjectSubmitDraftInput = { rowId: string; row: LeanRow }

/** An opaque JSON object this boundary passes through without interpreting. */
export type JsonRecord = Record<string, unknown>

export type WorkflowLanguage = "default" | "ru" | "en" | "tr" | "zh_hans"

export type FieldAddress =
  | { kind: "plain"; field_key: string }
  | { kind: "complex"; group_key: string; item_id: string; field_key: string; value_index?: number }

export type WorkflowDraftSelection = { dictionary_value_id: number; value: string }

export type WorkflowDraftValue =
  | { kind: "text"; value: string }
  | { kind: "text_list"; value: string[] }
  | { kind: "integer"; value: number }
  | { kind: "integer_list"; value: number[] }
  | { kind: "decimal"; value: number }
  | { kind: "decimal_list"; value: number[] }
  | { kind: "boolean"; value: boolean }
  | { kind: "boolean_list"; value: boolean[] }
  | { kind: "single_select"; value: WorkflowDraftSelection }
  | { kind: "multi_select"; value: WorkflowDraftSelection[] }
  | { kind: "url"; value: string }
  | { kind: "url_list"; value: string[] }

export type WorkflowComplexDraftItem = { item_id?: string; values: Record<string, WorkflowDraftValue> }
export type WorkflowComplexDraftGroup = { complex_id: number; items: WorkflowComplexDraftItem[] }

export type WorkflowCategoryDraft = {
  values: Record<string, WorkflowDraftValue>
  complex_values: WorkflowComplexDraftGroup[]
  cleared?: string[]
}

export type WorkflowAiFieldPolicy = { allowed_field_keys: string[]; protected_field_keys: string[] }

export type WorkflowImagePhase = "rendered" | "uploading" | "public_ready" | "failed"

export type WorkflowImageLifecycle = {
  index: number
  file_name: string
  content_hash: string
  group_name: string
  width: number
  height: number
  byte_size?: number
  phase: WorkflowImagePhase
  public_url?: string | null
  object_key?: string | null
  error_code?: string | null
  account_id?: string | null
}

export type WorkflowVideoMetadata = {
  role: "product" | "cover"
  origin: "managed_upload" | "public_url"
  file_name: string
  content_type: string
  size_bytes: number
  duration_ms: number
  public_url?: string
  object_key?: string
  content_hash?: string
}

export type WorkflowFailureLogEntry = JsonRecord

/** `workflow_dto::WorkflowAiCandidateState` (`snake_case`). */
export type WorkflowAiCandidateState = "proposed" | "confirmed" | "rejected" | "unresolved"

export type WorkflowAiCandidate = {
  address: FieldAddress
  value: WorkflowDraftValue
  current_value: WorkflowDraftValue | null
  source: string
  state: WorkflowAiCandidateState
  issue: string | null
}

/** `listing_cards.payload` (`rust/crates/listing-core/src/envelope.rs::CardPayload`). */
export type CardPayload = {
  categoryKey: string
  descriptionCategoryId: number
  typeId: number
  language?: WorkflowLanguage
  defaults?: WorkflowCategoryDraft
  aiPromptId?: string
  aiPromptSha256?: string
  supplierProductId?: string
  psdTemplateAssetId?: string
  psdTemplateSha256?: string
  psdTemplateFileName?: string
  aiFieldPolicy: WorkflowAiFieldPolicy
  videos?: WorkflowVideoMetadata[]
  videoCover?: WorkflowVideoMetadata
  queue?: { paused: boolean; stopAfterCurrent: boolean; nextPosition: number; frozenRowIds: string[] }
}

/** A fresh row's PSD/photo source (`envelope::RowSource`). */
export type RowSource = { assetId: string; sha256: string; fileName: string }

/**
 * `RowPayload` minus `schemaSnapshot` (`rust/crates/listing-core/src/ops/lean_row.rs`
 * — see its module docs for why the schema never travels with the row). This
 * is what every op's `row` field carries, and what `seedRow`/`editRow`/etc.
 * hand back.
 */
export type LeanRow = {
  categoryKey: string
  descriptionCategoryId: number
  typeId: number
  supplierProductId?: string
  language: WorkflowLanguage
  schemaRevision: string
  draft: WorkflowCategoryDraft
  handEditedKeys: string[]
  fieldOrigins: JsonRecord[]
  normalizedSnapshot: JsonRecord | null
  validationIssues: FieldIssue[]
  source: RowSource
  renderEvidence: JsonRecord | null
  media: { images: WorkflowImageLifecycle[]; videos: WorkflowVideoMetadata[]; videoCover?: WorkflowVideoMetadata }
  ai: {
    requestId: string
    candidates: WorkflowAiCandidate[]
    summary?: { tags: string[]; model: string }
    promptSha256: string
    modelVersion: string
  }
  failureLog: WorkflowFailureLogEntry[]
}

export type FieldIssue = {
  field_key: string
  code: string
  parameters: Record<string, JsonRecord>
  /** `validate::IssueSeverity` (`snake_case`). */
  severity: "blocking" | "warning"
  address: FieldAddress
  message: string
  remediation: string | null
}

export type ListingFieldEditor =
  | "text"
  | "integer"
  | "decimal"
  | "boolean"
  | "single_select"
  | "multi_select"
  | "dictionary_search"
  | "url"

export type ListingFieldDefinition = JsonRecord

/** `records::CategorySchemaSnapshot` — the schema `schema_load` resolves to a
 * resident handle. Field names are the crate's own (no `rename_all`). */
export type CategorySchemaSnapshot = {
  category_key: string
  label: string
  description_category_id: number
  type_id: number
  schema_revision: string
  recipe_id: number
  recipe_revision: number
  catalog_schema_version: number
  fields: ListingFieldDefinition[]
}

/** One truncated-dictionary search hit (`schema_io.rs`'s wire shape). */
export type SearchMaterialEntry = {
  descriptionCategoryId: number
  attributeId: number
  dictionaryId: number
  valueId: number
  label: string
}

export type SchemaLoadInput = { snapshot: CategorySchemaSnapshot; searchMaterials?: SearchMaterialEntry[] }

// ---- Op 1: seedRow --------------------------------------------------------

export type SeedRowInput = {
  card: CardPayload
  source: RowSource
  suppliedDraft?: WorkflowCategoryDraft
  nowMs: number
}
export type SeedRowOutput = LeanRow

// ---- Op 2: editRow ---------------------------------------------------------

export type EditInput =
  | { kind: "clearGeneratedContent" }
  | { kind: "draft"; changes?: JsonRecord; draft: WorkflowCategoryDraft; light?: boolean; storeMoved?: boolean }

export type EditRowInput = { card?: CardPayload; nowMs: number; row: LeanRow; edit: EditInput }

export type InvalidationPatch = {
  contentState: string | null
  mediaState: string | null
  submissionState: string | null
}

export type EditRowOutput = {
  row: LeanRow
  fact: ValidationFact
  issues: FieldIssue[]
  invalidation: InvalidationPatch
  stored: JsonRecord
}

// ---- Ops 3/4/6/7: the `Edited`-shaped ops (settleRecognition,
// decideCandidates, recordUpload, revalidate) --------------------------------

export type ValidationFact = "Stale" | "Blocked" | "Passed"

export type BuildEvidence = { digest: string; card_defaults_digest: string; sources: unknown[] }

export type EditedOutput = {
  row: LeanRow
  fact: ValidationFact
  issues: FieldIssue[]
  evidence: BuildEvidence | null
  contentReady: boolean
}

export type SettleRecognitionInput = {
  /** Required: the core refuses a card-less call with `CORE_REFUSED` instead of
   * guessing defaults. Optional on the wire only because the same struct shape
   * also carries the ops that legitimately run without one (`revalidate`). */
  card: CardPayload
  nowMs: number
  row: LeanRow
  ru: string
  description: string
  tags: string[]
  candidates?: WorkflowAiCandidate[]
  model: string
  costMicrofen: number
  requestId: string
  promptSha256: string
}

export type DecideCandidatesInput = {
  /** Required, same as `SettleRecognitionInput`: both ops re-derive the verdict
   * from the card's category, so a missing card is `CORE_REFUSED`, not a
   * defaulted field. */
  card: CardPayload
  nowMs: number
  row: LeanRow
  decisions: { index: number; accept: boolean }[]
}

/** Shared by op 6 (`recordUpload`) and op 7 (`revalidate`) — see
 * `rust/crates/listing-core-wasm/src/dispatch.rs`'s module docs for why they are
 * the same function on the Rust side. */
export type RevalidateInput = { card?: CardPayload; nowMs: number; row: LeanRow }

// ---- Op 5: recordRender -----------------------------------------------------

export type RecordRenderInput = { images: WorkflowImageLifecycle[]; rendererManifest: JsonRecord }
export type RecordRenderOutput = { images: WorkflowImageLifecycle[]; manifest: JsonRecord; manifestDigest: string }

// ---- Op 8: valuesEqual -------------------------------------------------------

export type ValuesEqualInput = {
  editor: ListingFieldEditor
  left?: WorkflowDraftValue | null
  right?: WorkflowDraftValue | null
}

// ---- Op 9: submitDraft ------------------------------------------------------

/** `rust/crates/listing-core/src/ops/submit.rs::SubmitDraft` — the browser's send
 * queue (slice 16) is `from_row`'s real caller; this type is what it builds
 * by projecting a local `LeanRow`. */
export type SubmitDraft = {
  rowId: string
  schemaRevision: string
  language?: WorkflowLanguage
  draft?: WorkflowCategoryDraft
  handEditedKeys?: string[]
  fieldOrigins?: JsonRecord[]
  sourceFileName?: string
  media?: { images: WorkflowImageLifecycle[]; videos: WorkflowVideoMetadata[]; videoCover?: WorkflowVideoMetadata }
  supplierProductId?: string
}
export type SubmitDraftInput = { draft: SubmitDraft; card: CardPayload }
/** No schema/validation fields — `into_row` starts them empty, matching a
 * server that always rebuilds and validates from scratch (README I7). This
 * op is a local preview, never the authoritative accept/reject decision. */
export type SubmitDraftOutput = LeanRow

// ---- Op 11: freezeListing ---------------------------------------------------

/** `ops::freeze_listing`'s input: the row's Card plus the browser-minted row
 * id the `clientOperationId` is keyed on. The schema is the resident handle. */
export type FreezeListingInput = { card: CardPayload; row: LeanRow; rowId: string }

export type FreezeRefusalReason =
  | "row_id_invalid"
  | "schema_stale"
  | "coordinate_mismatch"
  | "candidates_unresolved"
  | "validation_failed"
  | "freeze_failed"

/** A local preview of the exact Ozon `/v3/product/import` body. The server
 * still rechecks auth/tenant/store/revision, rebuilds the body and owns
 * intent idempotency before anything is dispatched (README I7). */
export type FreezeListingOutput =
  | {
      status: "frozen"
      import: JsonRecord
      digest: string
      offerId: string
      clientOperationId: string
      evidence: BuildEvidence
    }
  | { status: "refused"; reason: FreezeRefusalReason; issueStage: "freeze" | "validate"; issues: FieldIssue[]; evidence: BuildEvidence | null }

// ---- Op 17: parseOcrAnswer --------------------------------------------------

/** The shared contract's classification for the one paid retry. */
export type OcrRetryClass = "blind" | "corrective" | "permanent"

/** `listing_core::ocr_contract::parse_completion`, with `desc` renamed. */
export type ParsedOcrAnswer = {
  ru: string
  tags: string[]
  description: string
  candidates: unknown[]
}
// ---- Op 18: validateVariantGroup -------------------------------------------

/** `variants::DimensionValue`: one member's value for one variant dimension.
 * `missing` is a *value* — an unfilled optional dimension participates in the
 * comparison exactly like a filled one — not an absent field. */
export type DimensionValue =
  | { kind: "missing" }
  /** Dictionary choices as confirmed value ids: the same id under two
   * translations is one value, and order is irrelevant. */
  | { kind: "dictionary"; value: string[] }
  /** One or more non-dictionary values, compared as a set. */
  | { kind: "scalars"; value: string[] }

/** `variants::GroupIdentity` — the facts every member of one group shares. */
export type GroupIdentity = {
  description_category_id: number
  type_id: number
  brand: DimensionValue
}

/** `variants::VariantMember`. `values` is keyed by the dimension field key; an
 * absent key reads as `missing`. */
export type VariantMember = {
  member_id: string
  identity: GroupIdentity
  values: Record<string, DimensionValue>
}

/** `variants::GroupWrite`: the **complete** logical group plus the subset this
 * write sends, so a one-row write is never judged as a group of one. */
export type VariantGroupWrite = { members: VariantMember[]; write_member_ids: string[] }

/** `variants::VariantProblem`. `code` is a declared `KnownIssueKey`, so the
 * browser renders it through the same coverage-checked table as every other
 * native issue; `member_id` names the offending row and `field_key` the
 * offending field when the problem is about one. */
export type VariantProblem = {
  code: KnownIssueKey
  member_id?: string
  field_key?: string
}

/** The current category material (`records::ListingFieldDefinition` list —
 * exactly what Cloud's `nativeMaterial.snapshot.fields` carries) plus the group
 * under judgement. No schema handle: the rule is about what the category says
 * today, not about the Card's pinned snapshot. */
export type ValidateVariantGroupInput = {
  fields: JsonRecord[]
  group: VariantGroupWrite
}

// ---- Op 16: planStage -------------------------------------------------------

/** Bytes the browser already holds for one object that might be confirmed. */
export type ConfirmCandidate = {
  index: number
  digest: string
  extension: string
  objectKey: string
  byteLength: number
  storageRevision: number
  uploadTicket: string
  accountId: string
  workspaceUuid: string
  pendingConfirm: boolean
}

export type ConfirmItem =
  | { kind: "skip"; index: number }
  | { kind: "reject"; index: number; code: string; message: string }
  | { kind: "admit"; index: number }

export type ConfirmPlan = { items: ConfirmItem[]; batch: number[] }

export type ConfirmRetryPlan = { after: "keep_batch" | "split_ones" }

export type OcrFacts = {
  hasRecovery: boolean
  hasDisplayText: boolean
  originalStatus: string
  originalUsable?: boolean
  originalRequestId: string
  retryStatus: string
  retryUsable?: boolean
  retryRequestId: string
}

export type OcrStep = "wait" | "settle" | "unusable" | "simple_retry" | "pause" | "purchase_original"

export type OcrPlan = {
  step: OcrStep
  requestId?: string
  display: "show_local" | "server"
}

export type StageRequest =
  | { kind: "confirm"; candidates: ConfirmCandidate[] }
  | { kind: "confirmRetry"; status: number; code?: string; outcomeUnknown?: boolean }
  | { kind: "ocr"; facts: OcrFacts }

// ---- Errors -----------------------------------------------------------------

/** `error.rs`'s three codes, plus `CORE_OOM` — `wasm.ts`'s own code for an
 * `alloc` that returned 0 (the Rust side never emits it). */
export type ListingCoreErrorCode = "CORE_DECODE" | "CORE_SCHEMA_HANDLE" | "CORE_REFUSED" | "CORE_OOM"

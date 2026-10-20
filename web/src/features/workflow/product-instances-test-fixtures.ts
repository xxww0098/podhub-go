import type { WorkflowProductLifecycle } from "@/bindings/commands"
import { listingProjection } from "../../../tests/listing-row-fixture"
import { device } from "./prepare/execution-context"
import { stageFile } from "@/bindings/file-picker"

export const pendingLifecycle: WorkflowProductLifecycle = {
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

type Call = { url: string, method: string, body: any }

/** Every listing read and write is HTTP now; a test stubs the route. */
export function installFetch(reply: (call: Call) => unknown): { calls: Call[], restore: () => void } {
  const previous = globalThis.fetch
  const calls: Call[] = []
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const call: Call = {
      url: String(input),
      method: init?.method ?? "GET",
      body: init?.body === undefined ? undefined : JSON.parse(String(init.body)),
    }
    calls.push(call)
    // A reply may be a `Response` of its own: a refusal is a route the import
    // has to handle, and it belongs in the same recorded transcript.
    const replied = reply(call)
    if (replied instanceof Response) return replied
    return new Response(JSON.stringify({ data: replied }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    })
  }) as typeof globalThis.fetch
  return { calls, restore: () => { globalThis.fetch = previous } }
}

/** One Cloud refusal, in the `{error, code}` body `@/api/client` reads. */
export function refusal(status: number, code: string, error: string): Response {
  return new Response(JSON.stringify({ error, code }), {
    status,
    headers: { "Content-Type": "application/json" },
  })
}

export const CARD = {
  id: "workflow_template_card",
  title: "海报卡片",
  storeId: "store-1",
  revision: 2,
  payload: {
    categoryKey: "17027906:91976:zh_hans",
    descriptionCategoryId: 17027906,
    typeId: 91976,
    language: "zh_hans",
    schemaRevision: "rev-1",
    defaults: { values: {}, complex_values: [] },
    aiPrompt: "识图提示词",
    aiPromptFileName: "prompt.md",
    psdTemplateSha256: "template-sha",
    psdTemplateFileName: "poster.psd",
    targetStoreId: "store-1",
    aiFieldPolicy: { allowed_field_keys: [], protected_field_keys: [] },
    queue: { paused: false, stopAfterCurrent: false, nextPosition: 0, frozenRowIds: [] },
  },
  updatedAtMs: 0,
}

export const SCHEMA = {
  description_category_id: 17027906,
  type_id: 91976,
  language: "zh_hans",
  fetched_at_ms: 0,
  fields: [
    { key: "offer_id", label: "货号", group: "基础", editor: "text", required: true, collection: false },
  ],
}

/** One `ListingRowView`, as `GET|POST /api/listing/rows` answers. */
export function cloudRow(id: string, index: number, overrides: Record<string, unknown> = {}) {
  return {
    id,
    cardId: CARD.id,
    storeId: "store-1",
    revision: index + 1,
  viewRevision: 1,
  projection: listingProjection({ stage: "awaiting_content", ai: "pending", media: "pending", fields: "dirty", readiness: { ready_to_publish: false, can_start_publish_attempt: false, blockers: ["ai_pending", "media_pending", "fields_dirty"], allowed_actions: ["prepare", "edit_fields"] } }),
    contentState: "draft",
    mediaState: "pending",
    validationState: "stale",
    submissionState: "none",
    draft: {
      values: {
        offer_id: { kind: "text", value: `image-${index}` },
        attribute_9048: { kind: "text", value: `image-${index}` },
      },
      complex_values: [],
    },
    validationIssues: [],
    media: { images: [], videos: [] },
    ai: { candidates: [] },
    source: { assetId: "", sha256: `sha-${index}`, fileName: `image-${index}.jpg` },
    payload: { queuePosition: index },
    updatedAtMs: 0,
    build: { state: "stale", sources: [] },
    ...overrides,
  }
}

/** OPFS is browser-only; import writes the picked bytes through this seam. */
export function stubPutSource(): () => void {
  const original = device.putSource
  device.putSource = (async (_bytes: Uint8Array, fileName: string) =>
    `sha-${fileName}`) as typeof device.putSource
  return () => { device.putSource = original }
}

/** The picked files an import batch consumes, staged the way the chooser does. */
export function stagePaths(count: number): string[] {
  return Array.from({ length: count }, (_, index) =>
    stageFile(new File([new Uint8Array([index])], `image-${index}.jpg`, { type: "image/jpeg" })),
  )
}

// Production capability fixtures use real native bytes; only Cloud is mocked.
export async function publishRepairFixture() {
  const { readFileSync } = await import("node:fs")
  const { ListingCoreClient } = await import("@/listing-core/client")
  const { golden, goldenSchema, nativeRowView, resetSendState, serve } = await import("./submit/send-test-support")
  const { rememberAccountOverview } = await import("@/features/account/account-overview-cache")
  const { rememberStoreRoster } = await import("@/features/stores/store-roster-cache")
  const { readCategorySchema } = await import("@/bindings/listing-material-cache")
  const { rememberListingRows, rowCacheScope } = await import("@/bindings/listing-row-cache")
  const { primeCardSession } = await import("./card/card-session")
  const { rowStatusView } = await import("./model/row-state")
  const { product } = await import("./cloud-fanout-tests/fixtures")
  const { patchListingWorkbench } = await import("./workbench/listing-workbench-store")
  resetSendState()
  const account = {
    session: { authenticated: true }, owned_count: 1, owned_limit: 1,
    accounts: [{ active: true, uuid: "test-actor", email: "actor@example.test", name: "Test" }],
    active_workspace: { id: 1, uuid: "test-workspace", is_owned: true, name: "Test", plan: "test", role: "owner" }, workspaces: [],
  }
  rememberAccountOverview(account)
  const store: import("@/bindings/commands").OzonStoreView = {
    id: "store", cloud_store_uuid: "store", active: true, label: "Test", configured: true, cloud_status: "active",
    can_manage: true, can_edit_credential: false, assignee_key_manage: false, client_id: "", advertising_client_id: "",
    advertising_configured: false, needs_reentry: false, ref_id: "", secret_status: "present", updated_at_ms: 1, watermark_name: "",
    permissions: { manage_store: true, manage_key: false, manage_key_grants: false, delete_store: false, edit_name: false, manage_tags: false, test_key: false },
  }
  rememberStoreRoster({ stores: [store] }, 1)
  const schema = { ...goldenSchema, fields: [...goldenSchema.fields, {
    ...goldenSchema.fields.find((field) => field.key === "name")!, key: "native_search_tags", attribute_id: "23171", complex_id: null, required: false,
  }] }
  const warm = serve(() => ({ description_category_id: schema.description_category_id, type_id: schema.type_id,
    language: "default", fetched_at_ms: 1, fields: [], nativeMaterial: { snapshot: schema, searchMaterials: [] } }))
  try { await readCategorySchema({ descriptionCategoryId: schema.description_category_id, typeId: schema.type_id, language: "default" }) }
  finally { warm.restore() }
  const payload = structuredClone(golden.row)
  payload.draft.values.native_search_tags = { kind: "text", value: "Brand" }
  const issue: import("@/api/schema").components["schemas"]["ListingIssue"] = {
    code: "OZON_ROW_REJECTED", phase: "submit", allowed_actions: ["edit_row"], input_revision: 1,
    dispatch_evidence: "rejected", row_id: "row", store_id: "store", intent_id: "exact", trace_id: "test-trace",
    created_at_ms: 1, credential_revision: 1, endpoint: "import", request_hash: "test-hash", safe_message: "",
    remediation: "删除品牌词", summary: "搜索标签含品牌词", scope: "row", retry_after_fallback: false,
  }
  const raw = nativeRowView("row", { revision: 1, viewRevision: 1, cardId: "card", storeId: "store", payload })
  raw.projection = listingProjection({ stage: "publish_rejected", error_code: "BR_hashtag_brand", submission_issue: issue,
    current_issue_status: "present", readiness: { ready_to_publish: false, can_start_publish_attempt: true,
      blockers: ["publish_conflict"], allowed_actions: ["publish", "edit_fields"] } })
  const card: import("@/bindings/listing-projection").ListingCardView = {
    id: "card", revision: 1, title: "Test", store_id: "store", payload: golden.card, updated_at_ms: 1,
  }
  primeCardSession(card)
  rememberListingRows([raw], rowCacheScope())
  const view = { ...product("row"), ...rowStatusView(raw) }
  const row: import("./model/listing-row").ListingRow = {
    id: "row", draftId: "row", imageName: "row.png", status: "failed", stage: "publish_rejected",
    ai: "done", render: "done", upload: "done", log: "", readiness: raw.projection.readiness,
  }
  patchListingWorkbench({ cardId: "card", rows: [row], productDrafts: { row: view }, queueFrozenIds: ["row"] })
  const calls: string[] = []
  let afterEdit = () => {}
  let lastEdit: import("@/listing-core/types").EditRowOutput | undefined
  const core = new ListingCoreClient(readFileSync(new URL("../../../../wasm/dist/browser/listing-state.wasm", import.meta.url)))
  const edit = core.editRow.bind(core), revalidate = core.revalidate.bind(core), drop = core.dropSchema.bind(core)
  core.editRow = async (...args) => { calls.push("op2"); lastEdit = await edit(...args); afterEdit(); return lastEdit }
  core.revalidate = async (...args) => { calls.push("op7"); return revalidate(...args) }
  core.dropSchema = async (...args) => { calls.push("schema-drop"); return drop(...args) }
  const context: import("./workflow-publish-capabilities").WorkflowPublishContext = {
    workspaceId: 1, cardId: "card", generation: 1, controlVersion: 0, active: true, blocked: false,
  }
  return { account, store, schema, raw, card, row, context, core, calls, lastEdit: () => lastEdit,
    afterEdit: (callback: () => void) => { afterEdit = callback }, restore: resetSendState }
}

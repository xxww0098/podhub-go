/** External Cloud fixtures follow the existing compiled-native capability goldens. No field rules. */
import type { components } from "@/api/schema"
import type { AccountOverview, OzonStoreView, WorkflowDraftView } from "@/bindings/commands"
import type { ListingCardView, ListingRowView } from "@/bindings/listing-projection"
import type { CategorySchemaSnapshot, LeanRow } from "@/listing-core/types"
import type { ListingIntent } from "@/bindings/http-listing-intents"
import { rememberAccountOverview } from "@/features/account/account-overview-cache"
import { rememberStoreRoster } from "@/features/stores/store-roster-cache"
import { rememberListingRows, rowCacheScope } from "@/bindings/listing-row-cache"
import { readCategorySchema } from "@/bindings/listing-material-cache"
import { primeCardSession, closeCardSession } from "@/features/workflow/card/card-session"
import { rowStatusView } from "@/features/workflow/model/row-state"
import { patchListingWorkbench, resetListingWorkbench } from "@/features/workflow/workbench/listing-workbench-store"
import { listingProjection } from "./listing-row-fixture"
import goldenJson from "./fixtures/listing-core/ozon-publish-input.json"
import schemaJson from "./fixtures/listing-core/decorative-wall-art-schema.json"

const golden = goldenJson as unknown as { row: LeanRow; card: import("@/listing-core/types").CardPayload }
const baseSchema = schemaJson as unknown as CategorySchemaSnapshot
export const workbenchSchema = { ...baseSchema, fields: [...baseSchema.fields, {
  ...baseSchema.fields.find((field) => field.key === "name")!, key: "native_search_tags", attribute_id: "23171", complex_id: null, required: false,
}] }
export const workbenchIds = { row: "fixture-workbench-row", store: "fixture-workbench-store", card: "fixture-workbench-card", intent: "fixture-exact-intent" } as const
const fixtureAccount: AccountOverview = {
  session: { authenticated: true }, owned_count: 1, owned_limit: 1,
  accounts: [{ active: true, uuid: "fixture-account", email: "fixture@example.test", name: "本地夹具" }],
  active_workspace: { id: 1, uuid: "fixture-workspace", is_owned: true, name: "本地夹具", plan: "test", role: "owner" }, workspaces: [],
}
export function seedFixtureIdentity() {
  rememberAccountOverview(fixtureAccount)
  const store: OzonStoreView = {
    id: workbenchIds.store, cloud_store_uuid: workbenchIds.store, active: true, label: "本地模拟店铺", configured: true, cloud_status: "active",
    can_manage: true, can_edit_credential: false, assignee_key_manage: false, client_id: "", advertising_client_id: "",
    advertising_configured: false, needs_reentry: false, ref_id: "", secret_status: "present", updated_at_ms: 1, watermark_name: "",
    permissions: { manage_store: true, manage_key: false, manage_key_grants: false, delete_store: false, edit_name: false, manage_tags: false, test_key: false },
  }
  rememberStoreRoster({ stores: [store] }, 1)
}
export type WorkbenchMode = "brand" | "brand-no-action" | "brand-stale-revision" | "unknown" | "unknown-missing-id" | "unknown-readback-failed" | "unknown-no-resident"
export function workbenchData(mode: WorkbenchMode) {
  const payload = structuredClone(golden.row)
  payload.draft.values.offer_id = { kind: "text", value: workbenchIds.row }
  payload.draft.values.native_search_tags = { kind: "text", value: "FixtureBrand" }
  const issue: components["schemas"]["ListingIssue"] = {
    code: "OZON_ROW_REJECTED", phase: "submit", allowed_actions: mode === "brand-no-action" ? [] : ["edit_row"], input_revision: mode === "brand-stale-revision" ? 0 : 1,
    dispatch_evidence: "rejected", row_id: workbenchIds.row, store_id: workbenchIds.store, intent_id: workbenchIds.intent, trace_id: "fixture-brand-trace",
    created_at_ms: 1, credential_revision: 1, endpoint: "import", request_hash: "fixture-hash", safe_message: "",
    remediation: "删除本行搜索标签中的品牌词，保存并重新校验，再明确发送。", summary: "搜索标签含品牌词", scope: "row", retry_after_fallback: false,
  }
  const unknown = mode.startsWith("unknown")
  const projection = unknown ? listingProjection({ stage: "outcome_unknown", readiness: { ready_to_publish: false, can_start_publish_attempt: false,
    blockers: ["outcome_unknown"], allowed_actions: [] } }) : listingProjection({ stage: "publish_rejected", error_code: "BR_hashtag_brand", submission_issue: issue,
      current_issue_status: "present", readiness: { ready_to_publish: false, can_start_publish_attempt: true, blockers: ["publish_conflict"], allowed_actions: ["publish", "edit_fields"] } })
  const raw: ListingRowView = {
    id: workbenchIds.row, card_id: workbenchIds.card, store_id: workbenchIds.store, revision: 1, view_revision: 1,
    content_state: "ready", media_state: "ready", validation_state: "passed", submission_state: unknown ? "unknown" : "none",
    projection, draft: payload.draft, validation_issues: [], media: payload.media, ai: payload.ai, source: payload.source,
    payload: payload as unknown as ListingRowView["payload"], updated_at_ms: 1, build: { state: "built", sources: [] },
  }
  const card: ListingCardView = { id: workbenchIds.card, title: "原生修复夹具", revision: 1, store_id: workbenchIds.store, payload: golden.card, updated_at_ms: 1 }
  const intent: ListingIntent = { id: workbenchIds.intent, listing_row_id: raw.id, store_id: workbenchIds.store, row_revision: 1,
    client_operation_id: "fixture-original-operation", state: "unknown", can_resume: false, current_issue_status: "absent", submission_issues: [],
    submission_receipt_status: "absent", updated_at_ms: 10, has_live_reconcile_claim: false, has_unfinished_dispatch_job: false }
  return { raw, card, intent, mode }
}
export type WorkbenchData = ReturnType<typeof workbenchData>
export async function seedWorkbench(data: WorkbenchData) {
  resetListingWorkbench()
  const entry = await readCategorySchema({ descriptionCategoryId: workbenchSchema.description_category_id, typeId: workbenchSchema.type_id, language: "default" })
  if (data.mode === "unknown-no-resident") closeCardSession(data.card.id)
  else primeCardSession(data.card)
  rememberListingRows([data.raw], rowCacheScope())
  const status = rowStatusView(data.raw)
  const product: WorkflowDraftView = { draft_id: data.raw.id, kind: "instance", display_name: "本地商品", schema: entry.view,
    draft: data.raw.draft, validation_state: "valid", issues: [], ai_prompt_id: "", ai_prompt: "", ai_prompt_file_name: "",
    psd_template_asset_id: "", psd_template_file_name: "", target_store_id: workbenchIds.store,
    ai_field_policy: { allowed_field_keys: [], protected_field_keys: [] }, lifecycle: status.lifecycle, updated_at_ms: 1 }
  patchListingWorkbench({ cardId: data.card.id, productDrafts: { [data.raw.id]: { ...product, ...status } }, queueFrozenIds: [data.raw.id],
    rows: [{ id: data.raw.id, draftId: data.raw.id, imageName: "fixture.png", status: data.mode.startsWith("unknown") ? "exception" : "failed",
      stage: status.lifecycle.stage, ai: "done", render: "done", upload: "done", log: "", readiness: status.readiness,
      publishUnconfirmed: data.mode.startsWith("unknown") }] })
}

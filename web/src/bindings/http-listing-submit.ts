/** D: one explicit submit, no retries, notifications, row reads or diagnostics. */
import { request, type CloudRefusal } from "@/api/client"
import type { RequestEvidence } from "@/api/client-options"
import { route } from "@/api/routes"
import type { components } from "@/api/schema"
import type { SubmitDraft } from "@/listing-core/types"
import { isListingIntent, isRecord, listingContractError } from "./http-listing-intents"

export type DraftSubmitResult = components["schemas"]["SubmitListingDraftsData"]
export type DraftSubmitRequest = Omit<components["schemas"]["SubmitListingDraftsRequest"], "items"> & { items: SubmitDraft[] }
export const SUBMIT_MAX_BYTES = 7.5 * 1024 * 1024
export const SUBMIT_DEADLINE_MS = 150_000
const skips = { schema_stale: true, blocked: true, media_foreign: true, media_expired: true, offer_busy: true, compose_failed: true } satisfies Record<components["schemas"]["SubmitDraftSkipReason"], true>

/** Only these exact status/code pairs prove this admission transaction did not commit. */
export function draftAdmissionRefusal(error: unknown): "store_busy" | "store_unavailable" | "submit_capacity_full" | "offer_busy" | undefined {
  if (!(error instanceof Error)) return undefined
  const { status, serverCode } = error as CloudRefusal
  if (status !== 409) return undefined
  switch (serverCode) {
    case "store_busy": case "store_unavailable": case "submit_capacity_full": case "offer_busy": return serverCode
    default: return undefined
  }
}

export function draftRequestBytes(body: DraftSubmitRequest): number {
  return new TextEncoder().encode(JSON.stringify(body)).byteLength
}

function fieldIssueShape(value: unknown): boolean {
  if (!isRecord(value) || typeof value.code !== "string" || typeof value.field_key !== "string"
    || typeof value.message !== "string" || (value.severity !== "blocking" && value.severity !== "warning")
    || (value.remediation != null && typeof value.remediation !== "string") || !isRecord(value.parameters)
    || !isRecord(value.address) || typeof value.address.field_key !== "string") return false
  const address = value.address
  if (address.kind !== "plain" && !(address.kind === "complex" && typeof address.group_key === "string" && typeof address.item_id === "string"
    && (address.value_index == null || (Number.isSafeInteger(address.value_index) && Number(address.value_index) >= 0)))) return false
  return Object.values(value.parameters).every((parameter) => isRecord(parameter)
    && ((parameter.kind === "text" && typeof parameter.value === "string") || (parameter.kind === "integer" && Number.isSafeInteger(parameter.value))))
}

export async function submitListingDrafts(
  body: DraftSubmitRequest,
  deadlineAt = Date.now() + SUBMIT_DEADLINE_MS,
  onEvidence?: (evidence: RequestEvidence) => void,
  onDispatch?: () => void,
): Promise<DraftSubmitResult> {
  if (!body.card_id || !body.store_id || body.items.length === 0 || body.items.length > 100
    || new Set(body.items.map((item) => item.rowId)).size !== body.items.length
    || body.items.some((item) => !item.rowId || !item.schemaRevision)
    || draftRequestBytes(body) > SUBMIT_MAX_BYTES) throw listingContractError()
  // Stop is intentionally NOT a request signal: once fetched, this block keeps its original deadline.
  const remaining = Math.min(SUBMIT_DEADLINE_MS, deadlineAt - Date.now())
  if (!Number.isFinite(remaining) || remaining <= 0) throw listingContractError()
  const value = await request<unknown>("POST", route("listingSubmit"), body, {}, remaining, undefined, { reportOwner: "caller", onEvidence, onDispatch })
  if (!isRecord(value) || typeof value.server_schema_revision !== "string" || !Array.isArray(value.items)) throw listingContractError()
  const seen = new Set<string>()
  for (const item of value.items) {
    if (!isRecord(item) || typeof item.row_id !== "string" || seen.has(item.row_id)
      || !body.items.some((draft) => draft.rowId === item.row_id)
      || typeof item.outcome !== "string" || !["created", "resumed", "replayed", "skipped"].includes(String(item.outcome))) throw listingContractError()
    seen.add(item.row_id)
    if (item.outcome === "skipped") {
      if (typeof item.skip_reason !== "string" || !Object.hasOwn(skips, item.skip_reason)) throw listingContractError()
    } else if (!isListingIntent(item.intent)) throw listingContractError()
    if (item.intent != null && (!isListingIntent(item.intent) || item.intent.listing_row_id !== item.row_id || item.intent.store_id !== body.store_id)) throw listingContractError()
    if ((item.issues != null && (!Array.isArray(item.issues) || !item.issues.every(fieldIssueShape))) || (item.blockers != null && (!Array.isArray(item.blockers) || !item.blockers.every((blocker) => isRecord(blocker)
        && ((blocker.kind === "video_snapshot_incomplete" && typeof blocker.supplier_product_id === "string")
          || (blocker.kind === "shipping_not_ready" && typeof blocker.status === "string" && Array.isArray(blocker.reasons))))))) throw listingContractError()
  }
  // Missing rows remain absent; the queue marks exactly those rows unconfirmed.
  return value as DraftSubmitResult
}

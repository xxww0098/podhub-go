/** E: explicit reconciliation/cancel/release only. Never polls or paginates. */
import { request } from "@/api/client"
import type { RequestOptions } from "@/api/client-options"
import { route } from "@/api/routes"
import type { components } from "@/api/schema"

export type ListingIntent = components["schemas"]["ListingIntentView"]
export type IntentPage = components["schemas"]["ListingIntentsPage"]
export type ReleasedIntents = components["schemas"]["ReleaseUnknownListingIntentsData"]

export function listingContractError(): Error {
  return Object.assign(new Error("发布响应与接口合同不符，发送结果尚未确认；请核对原店铺 Intent 后再操作"), { code: "listing_contract_invalid" })
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

/** Open state/error strings are preserved. Consumers grant no actions for unknown values. */
export function isListingIntent(value: unknown): value is ListingIntent {
  if (!isRecord(value)) return false
  return ["id", "listing_row_id", "store_id", "client_operation_id", "state", "current_issue_status", "submission_receipt_status"]
    .every((key) => typeof value[key] === "string" && value[key] !== "")
    && Number.isSafeInteger(value.row_revision) && Number(value.row_revision) >= 0
    && Number.isSafeInteger(value.updated_at_ms)
    && typeof value.can_resume === "boolean" && Array.isArray(value.submission_issues)
    // Missing read facts remain unknown. Even false/false is not send permission.
    && ["has_live_reconcile_claim", "has_unfinished_dispatch_job"]
      .every((key) => !Object.hasOwn(value, key) || typeof value[key] === "boolean")
    && (value.external_task_id == null || typeof value.external_task_id === "string")
    && (value.current_issue == null || isRecord(value.current_issue))
    && (value.submission_receipt == null || isRecord(value.submission_receipt))
}

function ids(input: readonly string[]): string[] {
  if (input.length === 0 || input.length > 100 || new Set(input).size !== input.length
    || input.some((id) => !id || id.trim() !== id || id.includes(","))) throw listingContractError()
  return [...input]
}
const opts = (signal?: AbortSignal): RequestOptions => ({ callerSignal: signal, reportOwner: "caller" })

export async function readListingIntent(id: string, signal?: AbortSignal): Promise<ListingIntent> {
  ids([id])
  const value = await request<unknown>("GET", route("listingIntentsById", { id }), undefined, {}, 15_000, undefined, opts(signal))
  if (!isListingIntent(value) || value.id !== id) throw listingContractError()
  return value
}

export async function readListingIntents(
  storeId: string,
  selection: { rowIds: readonly string[]; intentIds?: never } | { intentIds: readonly string[]; rowIds?: never },
  signal?: AbortSignal,
): Promise<IntentPage> {
  if (!storeId || storeId.trim() !== storeId) throw listingContractError()
  const key = selection.rowIds ? "rowIds" : "intentIds"
  const selected = ids(selection.rowIds ?? selection.intentIds!)
  const query = new URLSearchParams({ storeId, [key]: selected.join(","), limit: "100", latestPerRow: "true" })
  const value = await request<unknown>("GET", `${route("listingIntents")}?${query}`, undefined, {}, 15_000, undefined, opts(signal))
  if (!isRecord(value) || !Array.isArray(value.items) || value.items.length > 100
    || (value.next_cursor != null && typeof value.next_cursor !== "string")) throw listingContractError()
  const items: ListingIntent[] = []
  for (const item of value.items) {
    if (!isListingIntent(item) || item.store_id !== storeId || !selected.includes(key === "rowIds" ? item.listing_row_id : item.id)
      || items.some((prior) => prior.id === item.id)) throw listingContractError()
    items.push(item)
  }
  return { items, next_cursor: value.next_cursor as string | null | undefined }
}

/** One read of a stopped unknown import by its stored offer. Never resends. */
export async function probeListingIntent(id: string, signal?: AbortSignal): Promise<ListingIntent> {
  ids([id])
  const value = await request<unknown>("POST", route("listingIntentsByIdProbe", { id }), undefined, {}, 15_000, undefined, opts(signal))
  if (!isListingIntent(value) || value.id !== id) throw listingContractError()
  return value
}

export async function cancelListingIntent(id: string, signal?: AbortSignal): Promise<ListingIntent> {
  ids([id])
  const value = await request<unknown>("POST", route("listingIntentsByIdCancel", { id }), undefined, {}, 15_000, undefined, opts(signal))
  if (!isListingIntent(value) || value.id !== id) throw listingContractError()
  return value
}

export async function releaseUnknownListingIntents(intentIds: readonly string[], signal?: AbortSignal): Promise<ReleasedIntents> {
  const selected = ids(intentIds)
  const value = await request<unknown>("POST", route("listingIntentsReleaseUnknown"), { intentIds: selected }, {}, 15_000, undefined, opts(signal))
  if (!isRecord(value) || !Array.isArray(value.released_intent_ids) || !Array.isArray(value.intents)
    || value.released_intent_ids.some((id) => typeof id !== "string" || !selected.includes(id))
    || new Set(value.released_intent_ids).size !== value.released_intent_ids.length
    || value.intents.some((item) => !isListingIntent(item) || !selected.includes(item.id))) throw listingContractError()
  // This receipt is evidence of release only, never permission to send; caller must re-read current Intents.
  return value as ReleasedIntents
}

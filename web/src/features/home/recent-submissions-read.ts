import { request } from "@/api/client"
import { route } from "@/api/routes"
import {
  isIntentReviewCounts,
  isListingIntent,
  isRecord,
  type IntentReviewCounts,
  type ListingIntent,
} from "@/bindings/http-listing-intents"
import type { ListingRowView } from "@/bindings/listing-projection"

/** One attention group of the review queue; each group is disjoint. */
export type ReviewKind = "unknown" | "failed" | "accepted_issue"

export type RecentSubmission = { intent: ListingIntent; row?: ListingRowView }
export type ReviewRead = { phase: "loading" | "ready" | "error"; counts?: IntentReviewCounts }
export type RecentSubmissionsRead = { items: RecentSubmission[]; review: IntentReviewCounts; nextCursor?: string }
export type RecentSubmissionsQuery = {
  needsReview?: boolean
  reviewKind?: ReviewKind
  cursor?: string
}

export async function readRecentSubmissions(signal: AbortSignal, query: RecentSubmissionsQuery = {}): Promise<RecentSubmissionsRead> {
  const options = { callerSignal: signal, reportOwner: "caller" as const }
  const params = new URLSearchParams({ limit: "5", latestPerRow: "true", review: "true" })
  if (query.needsReview || query.reviewKind) params.set("needsReview", "true")
  if (query.reviewKind) params.set("reviewKind", query.reviewKind)
  if (query.cursor) params.set("cursor", query.cursor)
  const page = await request<unknown>("GET", `${route("listingIntents")}?${params}`, undefined, {}, 15_000, undefined, options)
  signal.throwIfAborted()
  if (!isRecord(page) || !Array.isArray(page.items) || page.items.length > 5
    || (page.next_cursor != null && typeof page.next_cursor !== "string")
    || page.items.some((item) => !isListingIntent(item))
    || !isIntentReviewCounts(page.review)
    || new Set(page.items.map((item: ListingIntent) => item.id)).size !== page.items.length) {
    throw new Error("上架提交响应格式无效")
  }

  const items = page.items as ListingIntent[]
  const rows = await Promise.all(items.map(async (intent): Promise<RecentSubmission> => {
    try {
      const row = await request<unknown>("GET", route("listingRowsById", { id: intent.listing_row_id }), undefined, {}, 15_000, undefined, options)
      signal.throwIfAborted()
      if (!isRecord(row) || row.id !== intent.listing_row_id || typeof row.card_id !== "string" || !row.card_id
        || !isRecord(row.draft) || !isRecord(row.draft.values)) throw new Error("商品信息响应格式无效")
      return { intent, row: row as ListingRowView }
    } catch (error) {
      if (signal.aborted) throw error
      return { intent }
    }
  }))
  signal.throwIfAborted()
  return {
    items: rows,
    review: page.review,
    nextCursor: typeof page.next_cursor === "string" ? page.next_cursor : undefined,
  }
}

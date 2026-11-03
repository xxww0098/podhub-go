import { request } from "@/api/client"
import { route } from "@/api/routes"
import { isListingIntent, isRecord, type ListingIntent } from "@/bindings/http-listing-intents"
import type { ListingRowView } from "@/bindings/listing-projection"

export type RecentSubmission = { intent: ListingIntent; row?: ListingRowView }

export async function readRecentSubmissions(signal: AbortSignal): Promise<RecentSubmission[]> {
  const options = { callerSignal: signal, reportOwner: "caller" as const }
  const page = await request<unknown>("GET", `${route("listingIntents")}?limit=5&latestPerRow=true`, undefined, {}, 15_000, undefined, options)
  signal.throwIfAborted()
  if (!isRecord(page) || !Array.isArray(page.items) || page.items.length > 5
    || (page.next_cursor != null && typeof page.next_cursor !== "string")
    || page.items.some((item) => !isListingIntent(item))
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
  return rows
}

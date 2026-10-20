import { api } from "@/api/client"
import { route } from "@/api/routes"
import type { components } from "@/api/schema"
import { mapLimit } from "../source-batch"

const INTENTS_PATH = route("listingIntents")
type IntentView = components["schemas"]["ListingIntentView"]
type IntentPage = components["schemas"]["ListingIntentsPage"]

async function readIntentPages(filter: "cardId" | "rowId", id: string): Promise<IntentView[]> {
  const intents: IntentView[] = []
  const seenCursors = new Set<string>()
  let cursor: string | undefined
  do {
    const query = `${INTENTS_PATH}?${filter}=${encodeURIComponent(id)}&limit=100&stableOrder=true` +
      (cursor ? `&cursor=${encodeURIComponent(cursor)}` : "")
    const page = await api.get<IntentPage>(query)
    intents.push(...page.items)
    const nextCursor = page.next_cursor ?? undefined
    if (nextCursor && (nextCursor === cursor || seenCursors.has(nextCursor))) {
      throw new Error("云端 Intent 分页游标重复，请稍后重试")
    }
    if (nextCursor) seenCursors.add(nextCursor)
    cursor = nextCursor
  } while (cursor)
  return intents
}

function collectCancelableIntentIds(intents: readonly IntentView[], draftIds: readonly string[]): string[] {
  const wanted = new Set(draftIds)
  const seen = new Set<string>()
  return intents.flatMap((intent) => {
    if (!wanted.has(intent.listing_row_id) || intent.state !== "queued" && intent.state !== "submitting") return []
    if (seen.has(intent.id)) return []
    seen.add(intent.id)
    return [intent.id]
  })
}

async function cancelIntentIds(intentIds: readonly string[]): Promise<{ attempted: number; cancelled: number }> {
  const results = await mapLimit(intentIds, 3, async (intentId) => {
    try {
      await api.post<IntentView>(route("listingIntentsByIdCancel", { id: intentId }))
      return true
    } catch {
      return false
    }
  })
  const cancelled = results.filter(Boolean).length
  if (cancelled !== intentIds.length) {
    throw new Error(`${intentIds.length - cancelled} 个 Intent 取消失败`)
  }
  return { attempted: intentIds.length, cancelled }
}

/**
 * Soft-cancel Cloud intents for the frozen publish queue, then return how many
 * cancel calls succeeded. Throws on list failure or when any cancel fails.
 */
export async function cancelInFlightIntentsForDrafts(
  draftIds: readonly string[],
  cardId: string,
): Promise<{ attempted: number; cancelled: number }> {
  if (!draftIds.length) return { attempted: 0, cancelled: 0 }
  if (!cardId.trim()) throw new Error("缺少 Listing Card 标识，无法安全取消")
  const intents = await readIntentPages("cardId", cardId)
  return cancelIntentIds(collectCancelableIntentIds(intents, draftIds))
}

/**
 * Soft-cancel the in-flight Cloud intent for one Product Instance.
 * No-op when the draft has nothing cancelable. Throws on list/cancel failure.
 */
export async function cancelInFlightIntentForDraft(
  draftId: string,
): Promise<{ cancelled: boolean; intentId?: string }> {
  const trimmed = draftId.trim()
  if (!trimmed) return { cancelled: false }
  const intents = await readIntentPages("rowId", trimmed)
  const intentIds = collectCancelableIntentIds(intents, [trimmed])
  const intentId = intentIds[0]
  if (!intentId) return { cancelled: false }
  await cancelIntentIds(intentIds)
  return { cancelled: true, intentId }
}

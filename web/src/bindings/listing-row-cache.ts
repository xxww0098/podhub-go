/**
 * Session-memory copy of the raw `ListingRowView`s this tab already received
 * (reads, create/patch replies, card pages, the card stream's snapshot and
 * events). Never a source of truth: Cloud re-checks every revision pin on
 * send, and nothing here is persisted.
 *
 * Two fences keep it honest:
 * - Per row, `viewRevision` only moves forward: a late GET never replaces a
 *   newer SSE row or write reply, whatever order they land in.
 * - Per session, a writer captures `rowCacheScope()` before its HTTP call or
 *   stream subscription. An identity/Workspace switch
 *   (`invalidateAllSessionCaches`) trips that scope, so a reply born earlier
 *   cannot refill the new session. A row removed after the scope was taken is
 *   not resurrected by that scope's writer.
 */
import { api } from "@/api/client"
import { route } from "@/api/routes"
import { createSessionCache } from "@/lib/session-cache"
import type { ListingRowView } from "./listing-projection"
import { refuse } from "./refusal"

export type RowCacheScope = Readonly<{ current: () => boolean, removalsSeen: number }>

/** Fence key no row id can take (ids are UUIDs). */
const SESSION = "\0session"

function fetchRow(rowId: string): Promise<ListingRowView> {
  return api.get<ListingRowView>(`${route("listingRows")}/${encodeURIComponent(rowId)}`)
}

function natural(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0
}

/** The identity the send rail relies on; anything else is not cached. */
function cacheable(row: unknown): row is ListingRowView {
  const value = row as Partial<ListingRowView> | null
  return !!value && typeof value.id === "string" && value.id !== "" && typeof value.card_id === "string" &&
    natural(value.revision) && natural(value.view_revision) &&
    typeof value.payload === "object" && value.payload !== null && !Array.isArray(value.payload)
}

const cache = createSessionCache<ListingRowView>(fetchRow, {
  commit: ({ next, current, write }) => {
    if (cacheable(next) && (!current || next.view_revision > current.view_revision)) write(next)
  },
})
/** Ids ever cached this tab, so a Card delete can find its rows. */
const known = new Set<string>()
let removals = 0
const removedAt = new Map<string, number>()

export function rowCacheScope(): RowCacheScope {
  return { current: cache.captureFence(SESSION), removalsSeen: removals }
}

function accept(row: unknown, scope: RowCacheScope): void {
  if (!cacheable(row) || (removedAt.get(row.id) ?? 0) > scope.removalsSeen) return
  const current = cache.peek(row.id)?.value
  if (current && current.view_revision >= row.view_revision) return
  known.add(row.id)
  cache.set(row.id, row)
}

export function rememberListingRows(rows: readonly unknown[], scope: RowCacheScope): void {
  if (!scope.current()) return
  for (const row of rows) accept(row, scope)
}

export function forgetListingRows(rowIds: Iterable<string>, scope?: RowCacheScope): void {
  if (scope && !scope.current()) return
  for (const rowId of rowIds) {
    removedAt.set(rowId, ++removals)
    known.delete(rowId)
    cache.drop(rowId)
  }
}

export function forgetCardRows(cardId: string): void {
  forgetListingRows([...known].filter((rowId) => cache.peek(rowId)?.value.card_id === cardId))
}

/** Zero-request peek. */
export function cachedListingRow(rowId: string): ListingRowView | undefined {
  return cache.peek(rowId)?.value
}

/** A fresh GET every call (poll semantics); the reply is cached if still newest. */
export async function readListingRowFresh(rowId: string): Promise<ListingRowView> {
  const row = await cache.load(rowId, { force: true })
  if (cacheable(row)) known.add(row.id)
  return row
}

/**
 * The resident row, or one shared GET on a miss. Answers what is resident
 * after the read — a newer SSE row wins over the reply — and refuses a reply
 * an identity switch fenced out.
 */
export async function residentListingRow(rowId: string): Promise<ListingRowView> {
  const hit = cache.peek(rowId)?.value
  if (hit) return hit
  const session = cache.captureFence(SESSION)
  const loaded = await cache.load(rowId)
  if (!session()) {
    throw refuse("workflow_row_cache_stale", "账号或工作区已切换，商品读取已作废", "请重新打开上架方案后再操作")
  }
  if (cacheable(loaded)) known.add(loaded.id)
  return cache.peek(rowId)?.value ?? loaded
}

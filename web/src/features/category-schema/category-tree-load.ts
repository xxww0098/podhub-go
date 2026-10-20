import type { CategoryTreeNodeView } from "@/bindings/commands"
import { listingHttp } from "@/bindings/http-listing"
import { readCategoryTreeCache, writeCategoryTreeCache } from "./category-tree-cache"

type TreeFetcher = () => Promise<CategoryTreeNodeView[]>

/**
 * One reader for the Seller category tree.
 *
 * A localStorage hit (24 h, see category-tree-cache) returns without a GET.
 * Otherwise every caller joins the in-flight request, including a hover
 * prefetch that did not name a Store and a screen that did: the platform
 * cache is the same document. An explicit refresh (`force`) skips the cache,
 * starts a new GET, and fences the previous reply so a slower one cannot
 * overwrite the refresh. An empty reply is not stored — a miss must not
 * occupy the 24 h slot.
 */
let generation = 0
let flight: Promise<CategoryTreeNodeView[]> | null = null

export function loadCategoryTree(options?: {
  force?: boolean
  storeId?: string
  fetcher?: TreeFetcher
}): Promise<CategoryTreeNodeView[]> {
  const external = Boolean(options?.fetcher)
  if (!options?.force && !external) {
    const cached = readCategoryTreeCache()
    if (cached && cached.length > 0) return Promise.resolve(cached)
    if (flight) return flight
  }

  const gen = ++generation
  const storeId = options?.storeId
  const fetcher = options?.fetcher ?? (() => listingHttp.listingCardLoadCategoryTree({
    language: "zh_hans",
    ...(storeId ? { target_store_id: storeId } : {}),
  }))
  const request = fetcher().then((tree) => {
    if (!external && gen === generation && tree.length > 0) writeCategoryTreeCache(tree)
    return tree
  })
  if (!external) flight = request
  return request.finally(() => {
    if (flight === request) flight = null
  })
}

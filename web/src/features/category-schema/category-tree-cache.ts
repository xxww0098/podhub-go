import type { CategoryTreeNodeView } from "@/bindings/commands"

const STORAGE_KEY = "podhub.workflow.category-tree.v1"
const LANGUAGE = "zh_hans"

/**
 * The client half of the category tree cache: entries expire after 24 h, an
 * expired entry is discarded rather than served as a fallback, and the next
 * request repopulates it.
 *
 * Expiring here *is* the refresh schedule. The screens fetch the tree exactly
 * when this cache misses — their mount effects guard on `categoryTree.length`
 * and never refetch a populated one — so without an expiry a tree fetched once
 * is painted forever and only 「重新拉取」 corrects it, an affordance the
 * refresh must not depend on.
 */
const MAX_AGE_MS = 24 * 60 * 60 * 1000

type CachedCategoryTree = {
  language: string
  fetchedAt: string
  tree: CategoryTreeNodeView[]
}

function isNode(value: unknown): value is CategoryTreeNodeView {
  if (!value || typeof value !== "object") return false
  const node = value as CategoryTreeNodeView
  return (
    typeof node.description_category_id === "number" &&
    typeof node.category_name === "string" &&
    typeof node.type_id === "number" &&
    typeof node.type_name === "string" &&
    typeof node.disabled === "boolean" &&
    Array.isArray(node.children) &&
    node.children.every(isNode)
  )
}

function isCached(value: unknown): value is CachedCategoryTree {
  if (!value || typeof value !== "object") return false
  const cached = value as CachedCategoryTree
  return (
    cached.language === LANGUAGE &&
    typeof cached.fetchedAt === "string" &&
    Array.isArray(cached.tree) &&
    cached.tree.every(isNode)
  )
}

/** Hydrate the Seller category tree from localStorage; null when absent, stale or corrupt. */
export function readCategoryTreeCache(): CategoryTreeNodeView[] | null {
  if (typeof window === "undefined") return null
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY)
    if (!raw) return null
    const parsed: unknown = JSON.parse(raw)
    if (!isCached(parsed)) return null
    // Keep the entry only for an age this clock can actually vouch for. An
    // unparseable stamp is `NaN` and a clock that moved backwards is negative;
    // both mean "cannot tell how old this is", which is a miss, not a hit.
    const age = Date.now() - Date.parse(parsed.fetchedAt)
    if (!(age >= 0 && age <= MAX_AGE_MS)) {
      window.localStorage.removeItem(STORAGE_KEY)
      return null
    }
    return parsed.tree
  } catch {
    return null
  }
}

/** Persist a freshly fetched tree so reopen / next session can skip the network. */
export function writeCategoryTreeCache(tree: CategoryTreeNodeView[]): void {
  if (typeof window === "undefined") return
  const payload: CachedCategoryTree = {
    language: LANGUAGE,
    fetchedAt: new Date().toISOString(),
    tree,
  }
  const document = JSON.stringify(payload)
  try {
    window.localStorage.setItem(STORAGE_KEY, document)
  } catch {
    // The tree is the largest thing this origin keeps in localStorage — one
    // was measured at 650 KB — and it shares one quota with the theme,
    // the Store pick, the reply snippets and the render cache's eviction
    // ledger, whose own silent write failure would stop that cache's ceiling
    // from ever tripping. So the big writer yields first: drop the previous
    // tree, which is what usually filled the quota, and try once more.
    // Storage access itself can throw (private mode / SecurityError) — the
    // eviction must not escape this never-throw writer.
    try {
      window.localStorage.removeItem(STORAGE_KEY)
    } catch {
      // Cannot even evict; the single retry below will surface its own error.
    }
    try {
      window.localStorage.setItem(STORAGE_KEY, document)
    } catch {
      // Still too large for what is free. This session runs uncached and the
      // quota stays available to the small keys that need it more.
    }
  }
}

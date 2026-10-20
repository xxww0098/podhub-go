import type { OzonStoreView } from "@/bindings/commands"

/**
 * The keyword match: the text the roster actually paints — 店铺名 / Client ID /
 * 标签 / 指派人. One declaration so the toolbar count and the painted rows
 * never disagree on what "matching" means.
 */
export function matchesStoreQuery(store: OzonStoreView, query: string): boolean {
  const needle = query.trim().toLowerCase()
  if (!needle) return true
  const haystack = [
    store.label,
    store.client_id,
    store.assignee_name ?? "",
    store.assignee_email ?? "",
    store.group?.name ?? "",
    ...(store.tags ?? []).map((tag) => tag.name),
  ]
  return haystack.join(" ").toLowerCase().includes(needle)
}

export function filterStoresBySearch(
  stores: readonly OzonStoreView[],
  query: string,
): OzonStoreView[] {
  if (!query.trim()) return [...stores]
  return stores.filter((store) => matchesStoreQuery(store, query))
}

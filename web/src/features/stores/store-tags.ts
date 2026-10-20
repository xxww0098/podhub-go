import type { OzonStoreView } from "@/bindings/commands"

export function sameTagUuids(a: readonly string[], b: readonly string[]): boolean {
  const left = new Set(a)
  const right = new Set(b)
  return left.size === right.size && [...left].every((uuid) => right.has(uuid))
}

export function filterStoresByTags(
  stores: readonly OzonStoreView[],
  selectedUuids: readonly string[],
  includeUntagged: boolean,
): OzonStoreView[] {
  const selected = new Set(selectedUuids)
  if (selected.size === 0 && !includeUntagged) return [...stores]
  return stores.filter((store) => {
    const tags = store.tags ?? []
    return (
      (includeUntagged && tags.length === 0) ||
      tags.some((tag) => selected.has(tag.uuid))
    )
  })
}

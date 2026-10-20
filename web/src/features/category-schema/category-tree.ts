import type { CategoryTreeNodeView } from "@/bindings/commands"

export type CategoryLeafRef = {
  descriptionCategoryId: number
  typeId: number
  /** "一级 / 二级 / 类型" */
  pathLabel: string
  l1Id: number
  l2Id: number
}

export type CategoryTreeSelection = {
  l1Id: number
  l2Id: number
  descriptionCategoryId: number
  typeId: number
}

export function isTypeLeaf(node: CategoryTreeNodeView): boolean {
  return node.type_id > 0
}

export function nodeName(node: CategoryTreeNodeView): string {
  return isTypeLeaf(node) ? node.type_name : node.category_name
}

export function findByCategoryId(
  nodes: CategoryTreeNodeView[],
  id: number,
): CategoryTreeNodeView | undefined {
  for (const node of nodes) {
    if (!isTypeLeaf(node) && node.description_category_id === id) return node
    const nested = findByCategoryId(node.children, id)
    if (nested) return nested
  }
  return undefined
}

export type CategorySearchHit = CategoryLeafRef & { haystack: string }

/** Flatten type leaves once so search does not DFS the tree per keystroke. */
export function buildCategorySearchIndex(
  tree: CategoryTreeNodeView[],
): CategorySearchHit[] {
  const hits: CategorySearchHit[] = []
  for (const l1 of tree) {
    const l1Name = nodeName(l1)
    const l1Id = l1.description_category_id
    for (const l2 of l1.children) {
      const l2Name = nodeName(l2)
      const l2Id = l2.description_category_id
      for (const leaf of l2.children) {
        if (!isTypeLeaf(leaf)) continue
        const pathLabel = `${l1Name} / ${l2Name} / ${nodeName(leaf)}`
        hits.push({
          descriptionCategoryId: l2Id,
          typeId: leaf.type_id,
          pathLabel,
          l1Id,
          l2Id,
          haystack: `${pathLabel} ${l2Id} ${leaf.type_id}`.toLocaleLowerCase(),
        })
      }
    }
  }
  return hits
}

export function searchCategoryIndex(
  index: readonly CategorySearchHit[],
  query: string,
): CategorySearchHit[] {
  const needle = query.trim().toLocaleLowerCase()
  if (!needle) return []
  return index.filter((hit) => hit.haystack.includes(needle))
}

/** Category (non-type) nodes by description_category_id. */
export function indexCategoryNodes(
  tree: CategoryTreeNodeView[],
): Map<number, CategoryTreeNodeView> {
  const map = new Map<number, CategoryTreeNodeView>()
  const walk = (nodes: CategoryTreeNodeView[]) => {
    for (const node of nodes) {
      if (!isTypeLeaf(node)) map.set(node.description_category_id, node)
      if (node.children.length) walk(node.children)
    }
  }
  walk(tree)
  return map
}

/** Resolve L1/L2 ancestry for a locked L2 category + type leaf. */
export function resolveLeaf(
  descriptionCategoryId: number,
  typeId: number,
  tree: CategoryTreeNodeView[],
): CategoryLeafRef | undefined {
  const walk = (
    nodes: CategoryTreeNodeView[],
    ancestors: CategoryTreeNodeView[],
  ): CategoryLeafRef | undefined => {
    for (const node of nodes) {
      if (isTypeLeaf(node) && node.type_id === typeId) {
        const categories = ancestors.filter((item) => !isTypeLeaf(item))
        const ids = categories.map((item) => item.description_category_id)
        if (descriptionCategoryId > 0 && !ids.includes(descriptionCategoryId)) {
          continue
        }
        const l1 = categories[0]
        const l2 =
          categories.find((item) => item.description_category_id === descriptionCategoryId) ??
          categories[1] ??
          categories.at(-1)
        if (!l1 || !l2) continue
        return {
          descriptionCategoryId,
          typeId,
          pathLabel: `${nodeName(l1)} / ${nodeName(l2)} / ${nodeName(node)}`,
          l1Id: l1.description_category_id,
          l2Id: l2.description_category_id,
        }
      }
      const found = walk(node.children, [...ancestors, node])
      if (found) return found
    }
    return undefined
  }
  return walk(tree, [])
}

/// Never interpolates an id it has not checked: a card whose category is unset
/// used to render the literal string "undefined" as its subtitle, and a card
/// whose leaf is merely missing from the tree still owes the operator a label
/// rather than two bare numbers.
export function categoryPathLabel(
  descriptionCategoryId: number,
  typeId: number,
  tree: CategoryTreeNodeView[],
): string {
  const resolved = resolveLeaf(descriptionCategoryId, typeId, tree)?.pathLabel
  if (resolved) {
    return resolved
  }
  if (!(descriptionCategoryId > 0) || !(typeId > 0)) {
    return "未选择类目"
  }
  return `类目 ${descriptionCategoryId} / 类型 ${typeId}`
}

export function emptyTreeSelection(): CategoryTreeSelection {
  return { l1Id: 0, l2Id: 0, descriptionCategoryId: 0, typeId: 0 }
}

export function selectionFromLeaf(leaf: CategoryLeafRef): CategoryTreeSelection {
  return {
    l1Id: leaf.l1Id,
    l2Id: leaf.l2Id,
    descriptionCategoryId: leaf.descriptionCategoryId,
    typeId: leaf.typeId,
  }
}

export type PromptBackedLeaf = {
  descriptionCategoryId: number
  typeId: number
}

/** Compose picker: keep only leaves that have Cloud prompts, prune empty parents. */
export function promptBackedTree(
  tree: CategoryTreeNodeView[],
  leaves: readonly PromptBackedLeaf[],
): CategoryTreeNodeView[] {
  const allowed = new Set(
    leaves.map((leaf) => `${leaf.descriptionCategoryId}:${leaf.typeId}`),
  )
  const prune = (
    nodes: CategoryTreeNodeView[],
    ancestors: number[],
  ): CategoryTreeNodeView[] => {
    const kept: CategoryTreeNodeView[] = []
    for (const node of nodes) {
      if (isTypeLeaf(node)) {
        const matches = [0, ...ancestors].some((categoryId) =>
          allowed.has(`${categoryId}:${node.type_id}`),
        )
        if (matches) kept.push({ ...node, children: [] })
        continue
      }
      const children = prune(node.children, [
        ...ancestors,
        node.description_category_id,
      ])
      if (children.length > 0) kept.push({ ...node, children })
    }
    return kept
  }
  return prune(tree, [])
}

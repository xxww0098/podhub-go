/**
 * Store quota allocation and sequential splitting utilities for multi-store workflow cards.
 */

export type StoreQuotaSlice = {
  storeId: string
  quota: number
  /** 0-indexed start index (inclusive). */
  startIndex: number
  /** 0-indexed end index (exclusive). */
  endIndex: number
  /** 1-indexed display start (e.g. 1). 0 if quota is 0. */
  startPosition: number
  /** 1-indexed display end (e.g. 49). 0 if quota is 0. */
  endPosition: number
}

/** Parse comma-separated or whitespace-separated store IDs into a unique list. */
export function parseStoreIds(storeIdString?: string | null): string[] {
  if (!storeIdString) return []
  const seen = new Set<string>()
  const list: string[] = []
  for (const part of storeIdString.split(",")) {
    const trimmed = part.trim()
    if (trimmed && !seen.has(trimmed)) {
      seen.add(trimmed)
      list.push(trimmed)
    }
  }
  return list
}

/** Format a list of store IDs into canonical comma-separated representation. */
export function formatStoreIds(storeIds: readonly string[]): string {
  return storeIds.map((s) => s.trim()).filter(Boolean).join(",")
}

/** The card queue has one durable owner even when its rows span many stores. */
export function queueControlStoreId(cardStoreIds?: string | null): string {
  return parseStoreIds(cardStoreIds)[0] ?? ""
}

/** Resolve the one Store that owns a Product Instance and its Seller receipt. */
export function productStoreId(
  productTargetStoreId: string | null | undefined,
  cardStoreIds?: string | null,
): string {
  return productTargetStoreId?.trim() || queueControlStoreId(cardStoreIds)
}

/** Stable, de-duplicated stores whose ledgers must be reconciled for a cohort. */
export function uniqueProductStoreIds(
  productTargetStoreIds: readonly (string | null | undefined)[],
  cardStoreIds?: string | null,
): string[] {
  const seen = new Set<string>()
  const result: string[] = []
  for (const targetStoreId of productTargetStoreIds) {
    const resolved = productStoreId(targetStoreId, cardStoreIds)
    if (resolved && !seen.has(resolved)) {
      seen.add(resolved)
      result.push(resolved)
    }
  }
  if (!result.length) {
    const fallback = queueControlStoreId(cardStoreIds)
    if (fallback) result.push(fallback)
  }
  return result
}

/** Count the persisted Product Instance ownership shown by the allocation UI. */
export function countStoreQuotas(
  productTargetStoreIds: readonly (string | null | undefined)[],
  storeIds: readonly string[],
): Record<string, number> {
  const result = Object.fromEntries(storeIds.map((storeId) => [storeId, 0]))
  for (const targetStoreId of productTargetStoreIds) {
    const storeId = targetStoreId?.trim()
    if (storeId && Object.hasOwn(result, storeId)) result[storeId] = (result[storeId] ?? 0) + 1
  }
  return result
}

/**
 * Distribute totalRows across stores evenly.
 * E.g., 100 rows across 2 stores -> { store1: 50, store2: 50 }
 * E.g., 100 rows across 3 stores -> { store1: 34, store2: 33, store3: 33 }
 */
export function calculateEvenStoreQuotas(
  totalRows: number,
  storeIds: readonly string[],
): Record<string, number> {
  const result: Record<string, number> = {}
  if (!storeIds.length) return result
  if (totalRows <= 0) {
    for (const storeId of storeIds) result[storeId] = 0
    return result
  }

  const count = storeIds.length
  const base = Math.floor(totalRows / count)
  const remainder = totalRows % count

  storeIds.forEach((storeId, index) => {
    result[storeId] = base + (index < remainder ? 1 : 0)
  })
  return result
}

/**
 * Normalize and reconcile quotas to ensure they match totalRows and cover all storeIds.
 */
export function reconcileStoreQuotas(
  totalRows: number,
  storeIds: readonly string[],
  customQuotas?: Record<string, number> | null,
): Record<string, number> {
  if (!storeIds.length) return {}
  if (!customQuotas || !storeIds.some((storeId) => Object.hasOwn(customQuotas, storeId))) {
    return calculateEvenStoreQuotas(totalRows, storeIds)
  }

  const result: Record<string, number> = {}
  let sum = 0
  for (const storeId of storeIds) {
    const raw = customQuotas[storeId]
    const quota = typeof raw === "number" && Number.isFinite(raw) && raw >= 0 ? Math.floor(raw) : 0
    result[storeId] = quota
    sum += quota
  }

  // Zero persisted ownership is the initial empty-card snapshot, not a user split.
  if (sum === 0 && totalRows > 0) return calculateEvenStoreQuotas(totalRows, storeIds)

  // If sum matches totalRows, return as is
  if (sum === totalRows) {
    return result
  }

  // If difference exists, adjust the last store or distribute remainder
  const diff = totalRows - sum
  const lastStoreId = storeIds[storeIds.length - 1]!
  const adjustedLast = (result[lastStoreId] ?? 0) + diff
  if (adjustedLast >= 0) {
    result[lastStoreId] = adjustedLast
  } else {
    // If negative, fall back to even distribution
    return calculateEvenStoreQuotas(totalRows, storeIds)
  }
  return result
}

/**
 * Calculate sequential slice boundaries for each store.
 * Slices are strictly sequential: store 1 takes rows 0..K1-1, store 2 takes K1..K1+K2-1, etc.
 */
export function calculateSequentialStoreSlices(
  totalRows: number,
  storeIds: readonly string[],
  customQuotas?: Record<string, number> | null,
): StoreQuotaSlice[] {
  if (!storeIds.length) return []
  const quotas = reconcileStoreQuotas(totalRows, storeIds, customQuotas)
  const slices: StoreQuotaSlice[] = []
  let cursor = 0

  for (const storeId of storeIds) {
    const quota = quotas[storeId] ?? 0
    const startIndex = cursor
    const endIndex = Math.min(cursor + quota, totalRows)
    const actualCount = endIndex - startIndex
    slices.push({
      storeId,
      quota: actualCount,
      startIndex,
      endIndex,
      startPosition: actualCount > 0 ? startIndex + 1 : 0,
      endPosition: actualCount > 0 ? endIndex : 0,
    })
    cursor = endIndex
  }

  return slices
}

/**
 * Assign each row its target store ID according to sequential store slices.
 */
export function assignStoreIdByRowIndex(
  rowIndex: number,
  slices: readonly StoreQuotaSlice[],
  fallbackStoreId = "",
): string {
  for (const slice of slices) {
    if (rowIndex >= slice.startIndex && rowIndex < slice.endIndex) {
      return slice.storeId
    }
  }
  return fallbackStoreId || slices[0]?.storeId || ""
}

/**
 * One row's send target: its identity, its current Store, and the association
 * it belongs to (absent for an ordinary row).
 */
export type StoreAssignmentRow = readonly [
  rowId: string,
  store: string | null | undefined,
  /** Non-empty = this row is one spec of an opt-in same-design association. */
  associationId?: string | undefined,
]

/**
 * Associated rows whose Store is no longer among the targets.
 *
 * One design's specs share one Store: a per-card quota must never re-home a
 * spec to a second Store, so these rows stay unassigned and the operator
 * re-assigns them explicitly before sending. The rows themselves are not
 * touched — attempts that already left keep their original Store.
 */
export function associationStoreConflicts(
  storeIds: readonly string[],
  rows: readonly StoreAssignmentRow[],
): string[] {
  return rows
    .filter(([, , association]) => Boolean(association?.trim()))
    .filter(([, store]) => !storeIds.includes(store?.trim() ?? ""))
    .map(([rowId]) => rowId)
}

/** Resolve new-send targets from current Card bindings, keeping valid multi-store quotas. */
export function sendStoreAssignments(
  storeIds: readonly string[],
  rows: readonly StoreAssignmentRow[],
): Map<string, string> {
  const counts = countStoreQuotas(rows.map(([, store]) => store), storeIds)
  const remaining = reconcileStoreQuotas(rows.length, storeIds, counts)
  for (const store of storeIds) remaining[store] = remaining[store]! - counts[store]!
  // Only rows the quota may actually move take a slice: an ordinary row whose
  // Store is gone, never an associated one (those are the operator's call).
  const movable = rows.filter(
    ([, store, association]) =>
      !association?.trim() && !storeIds.includes(store?.trim() ?? ""),
  ).length
  const slices = calculateSequentialStoreSlices(movable, storeIds, remaining)
  let index = 0
  return new Map(rows.map(([rowId, store, association]) => {
    const current = store?.trim()
    if (association?.trim()) {
      return [rowId, current && storeIds.includes(current) ? current : ""]
    }
    return [rowId, current && storeIds.includes(current) ? current : assignStoreIdByRowIndex(index++, slices)]
  }))
}

/**
 * Adjust quota for a single store and auto-balance the other stores to keep total sum constant.
 */
export function adjustStoreQuota(
  currentQuotas: Record<string, number>,
  targetStoreId: string,
  newQuotaInput: number,
  totalRows: number,
  storeIds: readonly string[],
): Record<string, number> {
  if (!storeIds.length) return {}
  const targetIndex = storeIds.indexOf(targetStoreId)
  if (targetIndex === -1) return reconcileStoreQuotas(totalRows, storeIds, currentQuotas)

  const newQuota = Math.max(0, Math.min(Math.floor(newQuotaInput), totalRows))
  if (storeIds.length === 1) {
    return { [storeIds[0]!]: totalRows }
  }

  const remainingStores = storeIds.filter((id) => id !== targetStoreId)
  const remainingTotal = totalRows - newQuota

  const currentRemainingSum = remainingStores.reduce(
    (sum, id) => sum + (currentQuotas[id] ?? 0),
    0,
  )

  const nextQuotas: Record<string, number> = {
    [targetStoreId]: newQuota,
  }

  if (currentRemainingSum <= 0) {
    const even = calculateEvenStoreQuotas(remainingTotal, remainingStores)
    Object.assign(nextQuotas, even)
  } else {
    // Proportional redistribution for remaining stores
    let allocated = 0
    remainingStores.forEach((id, idx) => {
      if (idx === remainingStores.length - 1) {
        nextQuotas[id] = Math.max(0, remainingTotal - allocated)
      } else {
        const ratio = (currentQuotas[id] ?? 0) / currentRemainingSum
        const share = Math.max(0, Math.round(remainingTotal * ratio))
        nextQuotas[id] = share
        allocated += share
      }
    })
  }

  return nextQuotas
}

import type { SupplierDbRow } from "@/bindings/http-supplier-dbs"
import { missingReadiness } from "./supplier-readiness"

export type SupplierProductGroup = { key: string; row: SupplierDbRow; rows: SupplierDbRow[] }

export function supplierProductGroups(rows: readonly SupplierDbRow[]): SupplierProductGroup[] {
  const groups = new Map<string, SupplierProductGroup>()
  for (const row of rows) {
    if (row.archived) continue
    const group = row.variantGroup?.trim()
    const key = JSON.stringify([row.sourceId, group ? "group" : "row", group || row.productId])
    const existing = groups.get(key)
    if (existing) existing.rows.push(row)
    else groups.set(key, { key, row, rows: [row] })
  }
  return [...groups.values()]
}

export function productOzonReady(group: SupplierProductGroup): boolean {
  return group.rows.every((row) => row.readiness.ozonConfig
    && row.descriptionCategoryId === group.row.descriptionCategoryId
    && row.typeId === group.row.typeId)
}

export function productNeedsCompletion(group: SupplierProductGroup): boolean {
  return !productOzonReady(group) || group.rows.some((row) => missingReadiness(row).length > 0)
}

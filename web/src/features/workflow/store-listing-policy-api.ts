import { request } from "@/api/client"
import { route } from "@/api/routes"
import type { components } from "@/api/schema"

export type StoreListingPolicy = components["schemas"]["StoreListingPolicy"]

export function loadStoreListingPolicy(storeId: string, signal?: AbortSignal): Promise<StoreListingPolicy> {
  return request("GET", route("listingStorePoliciesByStoreId", { store_id: storeId }), undefined, {}, undefined, undefined, { responseBody: "json", callerSignal: signal })
}

export function saveStoreListingPolicy(storeId: string, dailyCap: number | null, minGapSeconds: number): Promise<StoreListingPolicy> {
  return request("PUT", route("listingStorePoliciesByStoreId", { store_id: storeId }), { daily_cap: dailyCap, min_gap_seconds: minGapSeconds }, {}, undefined, undefined, { responseBody: "json" })
}

export function parseStoreListingPolicy(dailyCap: string, gap: string): { dailyCap: number | null; minGapSeconds: number } | null {
  const cap = dailyCap.trim()
  const interval = gap.trim()
  if (cap !== "" && (!/^\d+$/.test(cap) || Number(cap) < 1 || Number(cap) > 1000000)) return null
  if (!/^\d+$/.test(interval) || Number(interval) > 86400) return null
  return { dailyCap: cap === "" ? null : Number(cap), minGapSeconds: Number(interval) }
}

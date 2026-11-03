import { request } from "@/api/client"
import { route } from "@/api/routes"
import type { components } from "@/api/schema"

export type TaskRecord = components["schemas"]["TaskRecord"]
export type TaskRecordsPage = components["schemas"]["TaskRecordsPage"]
export type TaskRecordQuery = {
  kind?: "listing" | "product_sync" | "media"
  status?: "active" | "attention" | "finished" | "cancelled"
  storeId?: string
  cursor?: string
}

export function loadTaskRecords(query: TaskRecordQuery, signal?: AbortSignal): Promise<TaskRecordsPage> {
  const params = new URLSearchParams()
  for (const [key, value] of Object.entries(query)) if (value) params.set(key, value)
  return request("GET", `${route("listingTaskRecords")}${params.size ? `?${params}` : ""}`,
    undefined, {}, undefined, undefined, { callerSignal: signal })
}

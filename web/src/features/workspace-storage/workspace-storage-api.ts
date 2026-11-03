import { request } from "@/api/client"
import { route } from "@/api/routes"
import type { components } from "@/api/schema"

export type WorkspaceStorage = components["schemas"]["WorkspaceSliceStorage"]
export type StorageObject = components["schemas"]["WorkspaceSliceObject"]
export type StorageObjects = components["schemas"]["WorkspaceSliceObjects"]
export type StorageStats = components["schemas"]["WorkspaceSliceStats"]
const options = { responseBody: "json", reportOwner: "caller" } as const
const query = (values: Record<string, string>) => `?${new URLSearchParams(values)}`
type DeleteResult = { deleted: number; failed_keys: string[] | null; has_more: boolean }

export const workspaceStorage = {
  get: () => request<WorkspaceStorage>("GET", route("workspaceSliceStorage"), undefined, {}, 30_000, undefined, options),
  authorize: () => request<{ authorization_url: string }>("POST", route("workspaceSliceStorageCloudflareAuthorize"), undefined, {}, 30_000, undefined, options),
  disconnect: () => request<void>("DELETE", route("workspaceSliceStorageCloudflare"), undefined, {}, 30_000, undefined, options),
  accounts: () => request<{ accounts: { id: string; name: string }[] }>("GET", route("workspaceSliceStorageCloudflareAccounts"), undefined, {}, 30_000, undefined, options),
  create: (accountId: string, bucket?: string) => request<WorkspaceStorage>("POST", route("workspaceSliceStorage"), { account_id: accountId, public_access: true, ...(bucket ? { bucket } : {}) }, {}, 180_000, undefined, options),
  updateCleanup: (mode: "daily" | "manual", time: string | null) => request<WorkspaceStorage>("PATCH", route("workspaceSliceStorageCleanup"), { cleanup_mode: mode, cleanup_time: time }, {}, 30_000, undefined, options),
  list: (prefix: string, cursor: string) => request<StorageObjects>("GET", route("workspaceSliceStorageObjects") + query({ prefix, cursor }), undefined, {}, 30_000, undefined, options),
  stats: () => request<StorageStats>("GET", route("workspaceSliceStorageStats"), undefined, {}, 40_000, undefined, options),
  download: (key: string) => request<{ url: string }>("GET", route("workspaceSliceStorageDownload") + query({ key }), undefined, {}, 30_000, undefined, options),
  remove: (keys: string[]) => request<DeleteResult>("POST", route("workspaceSliceStorageObjectsDelete"), { keys }, {}, 60_000, undefined, options),
  removeFolder: (prefix: string, signal?: AbortSignal) => request<DeleteResult>("POST", route("workspaceSliceStorageObjectsDelete"), { prefix }, {}, 60_000, undefined, { ...options, callerSignal: signal }),
  clear: () => request<{ clear_status: "pending" }>("POST", route("workspaceSliceStorageClear"), undefined, {}, 30_000, undefined, options),
}

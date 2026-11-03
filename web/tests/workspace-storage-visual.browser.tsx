// Local UI fixture only. It is not evidence of a Cloudflare connection.
import { createRoot } from "react-dom/client"
import { WorkspaceStoragePanel } from "@/features/workspace-storage/workspace-storage-panel"
import { Toaster } from "@/components/ui/toast"
import "../src/index.css"

const mode = new URLSearchParams(location.search).get("mode") ?? "owner"
if (mode === "dark") document.documentElement.classList.add("dark")
let cleared = mode === "empty"
let created = false
let createdBucket = ""
let connected = ["connected", "pending", "pending-other", "revoke-error", "configured-connected"].includes(mode)
let folderDeletes = 0
let cleanupMode: "daily" | "manual" = "daily"
let cleanupTime: string | null = "04:00"
const storage = () => ({ configured: created || !["setup", "available", "connected", "member-setup", "pending", "pending-other", "revoke-error"].includes(mode), can_manage: mode !== "member" && mode !== "member-setup", delete_enabled: mode !== "disabled", key_prefix: "podhub-slices/fixture/", bucket: created ? createdBucket : "podhub-test-workspace", public_base_url: location.origin, daily_clear_status: "waiting", cleanup_mode: cleanupMode, cleanup_time: cleanupTime, oauth_available: ["available", "connected", "pending", "pending-other", "revoke-error", "configured-connected"].includes(mode), cloudflare_connected: connected, provision: ["pending", "pending-other"].includes(mode) ? {id:"fixture",account_id:"a".repeat(32),bucket:"saved-workspace-assets",phase:"verifying",error_code:""} : undefined })
const paths = ["site/product-shirt.jpg", "site/product-tote.jpg", "site/product-mug.jpg", "site/preview-unavailable-长文件名与空格 包装正面切片.png"]
const batchDate = "2026-11-02/"
const batchPath = `${batchDate}1793601000000-550e8400-e29b-41d4-a716-446655440000/`
const folders = mode === "many" ? Array.from({ length: 80 }, (_, index) => `素材文件夹-${String(index + 1).padStart(2, "0")}/`) : ["2026-11-02/", "包含非常长名称的文件夹用于验证网格在窄屏上的换行与完整路径/"]
window.fetch = async (input, init) => {
  const url = new URL(input instanceof Request ? input.url : String(input), location.href)
  if (url.pathname === "/api/workspace/slice-storage") {
    if (init?.method === "POST") {
      const body = JSON.parse(String(init.body))
      document.body.dataset.bucketRequest = JSON.stringify(body)
      createdBucket = body.bucket || `podhub-${crypto.randomUUID().replaceAll("-", "")}`
      created = true
    }
    return Response.json(storage())
  }
  if (url.pathname.endsWith("/cleanup") && init?.method === "PATCH") {
    if (mode === "cleanup-error") return Response.json({ error: "自动清理正在进行，请稍后重试", code: "WORKSPACE_STORAGE_BUSY" }, { status: 409 })
    const body = JSON.parse(String(init.body))
    cleanupMode = body.cleanup_mode; cleanupTime = body.cleanup_time
    document.body.dataset.cleanupRequest = JSON.stringify(body)
    return Response.json(storage())
  }
  if (url.pathname.endsWith("/cloudflare/accounts")) return Response.json({ accounts: [{ id: (mode === "pending-other" ? "b" : "a").repeat(32), name: "PodHub 测试账户" }] })
  if (url.pathname.endsWith("/cloudflare") && init?.method === "DELETE") {
    document.body.dataset.cloudflareActions = (document.body.dataset.cloudflareActions ?? "") + "disconnect "
    if (mode === "revoke-error") return Response.json({ error: "无法确认 Cloudflare 授权已撤销，请重试", code: "CLOUDFLARE_REVOKE_FAILED" }, { status: 502 })
    connected = false
    return new Response(null, { status: 204 })
  }
  if (url.pathname.endsWith("/cloudflare/authorize") && init?.method === "POST") {
    document.body.dataset.cloudflareActions = (document.body.dataset.cloudflareActions ?? "") + "authorize "
    return Response.json({ authorization_url: "#fixture-authorized" })
  }
  if (url.pathname.endsWith("/stats")) return Response.json({ objects: cleared ? 0 : 143, bytes: cleared ? 0 : 83216913, complete: true, observed_at: new Date().toISOString() })
  if (url.pathname.endsWith("/objects")) {
    if (mode === "error") return Response.json({ error: "暂时无法读取存储桶，请稍后重试", code: "STORAGE_UNAVAILABLE" }, { status: 503 })
    const prefix = url.searchParams.get("prefix") ?? ""
    const visibleFolders = mode === "batch" ? (prefix === "" ? [batchDate] : prefix === batchDate ? [batchPath] : []) : !prefix ? folders : []
    const visibleObjects = mode === "batch" && prefix !== batchPath ? [] : paths
    return Response.json({ folders: cleared ? [] : visibleFolders, objects: cleared ? [] : visibleObjects.map((key, index) => ({ key, size: (index + 1) * 278345, last_modified: "2026-11-02T06:30:00Z", etag: `fixture-etag-${index}` })), next_cursor: "" })
  }
  if (url.pathname.endsWith("/download")) {
    document.body.dataset.downloaded = url.searchParams.get("key") ?? ""
    return Response.json({ url: "#fixture-download" })
  }
  if (url.pathname.endsWith("/objects/delete") && init?.method === "POST") {
    const body = JSON.parse(String(init.body))
    if (body.prefix) {
      if (body.prefix !== "podhub-slices/fixture/uploads/2026-11-02/") throw new Error("Folder delete escaped its namespace")
      folderDeletes++
      document.body.dataset.folderDeletes = String(folderDeletes)
      if (mode === "folder-partial") return Response.json({ deleted: 1, failed_keys: ["fixture-failed-key"], has_more: true })
      if (mode === "folder-error") return Response.json({ error: "图片上传链接仍可能有效，请在上传后 16 分钟再删除", code: "WORKSPACE_STORAGE_UPLOAD_ACTIVE" }, { status: 409 })
      if (folderDeletes === 1) return Response.json({ deleted: 100, failed_keys: [], has_more: true })
      cleared = true
      return Response.json({ deleted: 23, failed_keys: [], has_more: false })
    }
    cleared = true
    return Response.json({ deleted: body.keys.length, failed_keys: [], has_more: false })
  }
  if (url.pathname.endsWith("/clear") && init?.method === "POST") return Response.json({ clear_status: "pending" }, { status: 202 })
  throw new Error(`Unexpected fixture request ${url.pathname}`)
}
createRoot(document.getElementById("fixture")!).render(<main className="flex h-dvh flex-col overflow-y-auto bg-background p-4 sm:p-6"><WorkspaceStoragePanel /><Toaster /></main>)

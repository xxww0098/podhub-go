import assert from "node:assert/strict"
import test from "node:test"
import { renderToStaticMarkup } from "react-dom/server"
import { r2BucketNameValid } from "@/components/r2-bucket-fields"
import { WorkspaceStorageSetup } from "./workspace-storage-setup"
import { workspaceStorage } from "./workspace-storage-api"
import { storageBytes, storageFolderLabel, WorkspaceStoragePanel } from "./workspace-storage-panel"
import { route } from "@/api/routes"

const noop = () => {}
test("owners fill in R2 credentials with bucket and CORS guidance", () => {
  const html = renderToStaticMarkup(<WorkspaceStorageSetup busy={false} create={noop} />)
  assert.match(html, /id="workspace-r2-endpoint"/)
  assert.match(html, /id="workspace-r2-bucket"/)
  assert.match(html, /id="workspace-r2-public"/)
  assert.match(html, /id="workspace-r2-access-key"/)
  assert.match(html, /id="workspace-r2-secret-key"/)
  assert.match(html, /r2\/api\/tokens/)
  assert.match(html, /r2\/buckets\/cors/)
  assert.match(html, /PayPal/)
  assert.match(html, /共享额度/)
  assert.doesNotMatch(html, /登录并授权 Cloudflare|oauth|Account API Tokens Write/)
})

test("members cannot see the workspace bucket settings", () => {
  const html = renderToStaticMarkup(<WorkspaceStoragePanel role="member" />)
  assert.match(html, /仅工作空间所有者可查看/)
  assert.doesNotMatch(html, /<form|<input|<button|<select/)
})

test("bucket names follow the R2 rule", () => {
  for (const value of ["team-assets", "abc", "a".repeat(63)]) assert.equal(r2BucketNameValid(value), true, value)
  for (const value of ["中文存储桶", "Team-assets", "has space", "-starts", "ends-", "ab", "a".repeat(64)]) assert.equal(r2BucketNameValid(value), false, value)
})

test("storage size formatting preserves zero and meaningful byte precision", () => {
  assert.equal(storageBytes(0), "0 B")
  assert.equal(storageBytes(1536), "1.5 KB")
  assert.equal(storageBytes(1024 ** 3), "1 GB")
})

test("batch folders show a UTC time and short identifier without changing other names", () => {
  assert.equal(storageFolderLabel("1767225600000-550e8400-e29b-41d4-a716-446655440000"), "00:00:00 UTC · 550e8400")
  assert.equal(storageFolderLabel("2026-01-01"), "2026-01-01")
  assert.equal(storageFolderLabel("999999999999999999-550e8400-e29b-41d4-a716-446655440000"), "999999999999999999-550e8400-e29b-41d4-a716-446655440000")
})

test("the API submits the filled credential and still lists and deletes slices", async () => {
  const previous = globalThis.fetch
  const calls: { path: string; init?: RequestInit }[] = []
  globalThis.fetch = (async (path, init) => { calls.push({ path: String(path), init }); return Response.json({ configured: true }) }) as typeof fetch
  const input = { endpoint: "https://" + "a".repeat(32) + ".r2.cloudflarestorage.com", bucket: "team-assets", public_base_url: "https://pub-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb.r2.dev", access_key_id: "access", secret_access_key: "secret" }
  try {
    await workspaceStorage.get()
    await workspaceStorage.create(input)
    await workspaceStorage.list("folder with space/", "opaque+cursor")
    await workspaceStorage.removeFolder("podhub-slices/config-id/uploads/2026-11-02/")
    await workspaceStorage.updateCleanup("daily", "17:30")
    await workspaceStorage.updateCleanup("manual", null)
    assert.equal(calls.every(({ path, init }) => path.startsWith(route("workspaceSliceStorage")) && init?.credentials === "include"), true)
    assert.deepEqual(JSON.parse(String(calls[1]!.init?.body)), input)
    const url = new URL(calls[2]!.path, "https://podhub.example")
    assert.equal(url.searchParams.get("prefix"), "folder with space/")
    assert.equal(url.searchParams.get("cursor"), "opaque+cursor")
    assert.deepEqual(JSON.parse(String(calls[3]!.init?.body)), { prefix: "podhub-slices/config-id/uploads/2026-11-02/" })
    assert.deepEqual(JSON.parse(String(calls[4]!.init?.body)), { cleanup_mode: "daily", cleanup_time: "17:30" })
    assert.deepEqual(JSON.parse(String(calls[5]!.init?.body)), { cleanup_mode: "manual", cleanup_time: null })
  } finally { globalThis.fetch = previous }
})

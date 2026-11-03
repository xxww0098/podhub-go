import assert from "node:assert/strict"
import test from "node:test"
import { renderToStaticMarkup } from "react-dom/server"
import { WorkspaceStorageSetup } from "./workspace-storage-setup"
import { workspaceStorage } from "./workspace-storage-api"
import { cloudflareCallbackError, storageBytes, storageFolderLabel } from "./workspace-storage-panel"
import { route } from "@/api/routes"

const noop = () => {}
test("owner onboarding preserves registration and payment guidance without manual credentials or GIFs", () => {
  const html = renderToStaticMarkup(<WorkspaceStorageSetup storage={{ configured: false, can_manage: true, oauth_available: false }} accounts={[]} accountsLoaded={false} account="" setAccount={noop} bucketName="" setBucketName={noop} consent={false} setConsent={noop} busy={false} authorize={noop} disconnect={noop} reconnect={noop} create={noop} />)
  assert.match(html, /dash.cloudflare.com\/login/)
  assert.match(html, /dash.cloudflare.com\/sign-up/)
  assert.match(html, /PayPal/)
  assert.match(html, /共享额度/)
  assert.match(html, /平台尚未完成/)
  assert.doesNotMatch(html, /<input|\.gif|Access Key|Secret Access|连接 Cloudflare<\/button>/)
})

test("members do not get a create or Cloudflare authorization entry", () => {
  const html = renderToStaticMarkup(<WorkspaceStorageSetup storage={{ configured: false, can_manage: false, oauth_available: true }} accounts={[]} accountsLoaded={false} account="" setAccount={noop} bucketName="" setBucketName={noop} consent={false} setConsent={noop} busy={false} authorize={noop} disconnect={noop} reconnect={noop} create={noop} />)
  assert.match(html, /联系工作空间所有者/)
  assert.doesNotMatch(html, /<button|<select|<input/)
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

test("the API omits a default name and submits a custom name without credentials", async () => {
  const previous = globalThis.fetch
  const calls: { path: string; init?: RequestInit }[] = []
  globalThis.fetch = (async (path, init) => { calls.push({ path: String(path), init }); return init?.method === "DELETE" ? new Response(null, { status: 204 }) : Response.json({ configured: true, can_manage: true }) }) as typeof fetch
  try {
    await workspaceStorage.get()
    await workspaceStorage.create("a".repeat(32))
    await workspaceStorage.list("folder with space/", "opaque+cursor")
    await workspaceStorage.removeFolder("podhub-slices/config-id/uploads/2026-11-02/")
    await workspaceStorage.create("a".repeat(32), "team-assets")
    await workspaceStorage.updateCleanup("daily", "17:30")
    await workspaceStorage.updateCleanup("manual", null)
    await workspaceStorage.disconnect()
    assert.equal(calls.every(({ path, init }) => path.startsWith(route("workspaceSliceStorage")) && init?.credentials === "include"), true)
    assert.deepEqual(JSON.parse(String(calls[1]!.init?.body)), { account_id: "a".repeat(32), public_access: true })
    const url = new URL(calls[2]!.path, "https://podhub.example")
    assert.equal(url.searchParams.get("prefix"), "folder with space/")
    assert.equal(url.searchParams.get("cursor"), "opaque+cursor")
    assert.deepEqual(JSON.parse(String(calls[3]!.init?.body)), { prefix: "podhub-slices/config-id/uploads/2026-11-02/" })
    assert.deepEqual(JSON.parse(String(calls[4]!.init?.body)), { account_id: "a".repeat(32), public_access: true, bucket: "team-assets" })
    assert.deepEqual(JSON.parse(String(calls[5]!.init?.body)), { cleanup_mode: "daily", cleanup_time: "17:30" })
    assert.deepEqual(JSON.parse(String(calls[6]!.init?.body)), { cleanup_mode: "manual", cleanup_time: null })
    assert.equal(calls[7]!.path, route("workspaceSliceStorageCloudflare"))
    assert.equal(calls[7]!.init?.method, "DELETE")
  } finally { globalThis.fetch = previous }
})

test("connected owners get name validation and a reserved name cannot be edited", () => {
  const props = { accounts: [{id:"a".repeat(32),name:"Test"}], accountsLoaded:true, account:"a".repeat(32), setAccount:noop, bucketName:"中文", setBucketName:noop, consent:true, setConsent:noop, busy:false, authorize:noop, disconnect:noop, reconnect:noop, create:noop }
  const storage = {configured:false,can_manage:true,oauth_available:true,cloudflare_connected:true}
  const invalid = renderToStaticMarkup(<WorkspaceStorageSetup {...props} storage={storage} />)
  assert.match(invalid, /不可包含中文/)
  assert.match(invalid, /aria-invalid="true"/)
  const pending = renderToStaticMarkup(<WorkspaceStorageSetup {...props} storage={{...storage,provision:{id:"id",account_id:props.account,bucket:"saved-assets",phase:"verifying",error_code:""}}} />)
  const input = pending.match(/<input[^>]*id="workspace-r2-bucket"[^>]*>/)?.[0] ?? ""
  assert.match(input, /value="saved-assets"/)
  assert.match(input, /disabled/)
  assert.doesNotMatch(pending, /不可包含中文/)
  assert.match(pending, /退出授权/)
  assert.match(pending, /重新登录并授权/)
  const wrongAccount = renderToStaticMarkup(<WorkspaceStorageSetup {...props} storage={{...storage,provision:{id:"id",account_id:"b".repeat(32),bucket:"saved-assets",phase:"verifying",error_code:""}}} account={"b".repeat(32)} />)
  assert.match(wrongAccount, /需要原 Cloudflare 账户/)
  const resumeButton = wrongAccount.match(/<button[^>]*>[\s\S]*?<\/button>/g)?.find((button) => button.includes("继续创建并核对")) ?? ""
  assert.match(resumeButton, /disabled=""/)
  const noAccounts = renderToStaticMarkup(<WorkspaceStorageSetup {...props} storage={storage} accounts={[]} account="" />)
  assert.match(noAccounts, /未找到可用的 Cloudflare 账户/)
})

test("existing accounts can start authorization without registering", () => {
  const html = renderToStaticMarkup(<WorkspaceStorageSetup storage={{ configured: false, can_manage: true, oauth_available: true }} accounts={[]} accountsLoaded={false} account="" setAccount={noop} bucketName="" setBucketName={noop} consent={false} setConsent={noop} busy={false} authorize={noop} disconnect={noop} reconnect={noop} create={noop} />)
  assert.match(html, /登录并授权 Cloudflare/)
  assert.match(html, /Account API Tokens Write/)
  assert.ok(html.indexOf("登录并授权 Cloudflare") < html.indexOf("注册账号"))
  assert.doesNotMatch(html, /平台尚未完成/)
})

test("OAuth callback failures have actionable messages and ignore arbitrary fragments", () => {
  assert.match(cloudflareCallbackError("#cloudflare_error=denied"), /授权未完成/)
  assert.match(cloudflareCallbackError("#cloudflare_error=invalid_state"), /已过期/)
  assert.match(cloudflareCallbackError("#cloudflare_error=failed"), /无法完成/)
  assert.equal(cloudflareCallbackError("#cloudflare_error=untrusted"), "")
})

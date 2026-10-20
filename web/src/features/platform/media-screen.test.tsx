import assert from "node:assert/strict"
import test from "node:test"
import { Children, isValidElement, type ReactNode } from "react"
import { renderToStaticMarkup } from "react-dom/server"

import { route } from "@/api/routes"
import type {
  IntegrationCredentialsOverview,
  MediaAccountView,
} from "@/bindings/commands"
import { integrationsHttp } from "@/bindings/http-integrations"
import { invalidateAccountOverview, loadAccountOverview, rememberAccountOverview } from "@/features/account/account-overview-cache"
import { NotificationsProvider } from "@/features/notifications/notifications"

import { PlatformMediaScreen } from "./media-screen"
import { MediaEditor } from "./media-editor"
import { MediaTable } from "./media-table"

const transitAccount: MediaAccountView = {
  id: "s3_transit",
  label: "中转桶",
  role: "transit",
  provider: "cloudflare",
  ref_id: "s3_transit",
  configured: true,
  active: true,
  endpoint: "https://r2.example.test",
  region: "auto",
  bucket: "podhub-transit",
  key_prefix: "",
  public_base_url: "https://transit.podhub.si",
  force_path_style: true,
}

const assetsAccount: MediaAccountView = {
  ...transitAccount,
  id: "s3_assets",
  label: "素材库桶",
  role: "assets",
  bucket: "podhub-assets",
  public_base_url: "https://assets.podhub.si",
}

const overview = (...accounts: MediaAccountView[]): IntegrationCredentialsOverview => ({
  ai_default_model: "",
  ai_accounts: [],
  media_accounts: accounts,
})

/** The save button's own opening tag: the last <button> before the label. */
function saveButton(html: string): string {
  const label = html.lastIndexOf("保存配置")
  return html.slice(html.lastIndexOf("<button", label), label)
}

function render(element: ReactNode): string {
  return renderToStaticMarkup(<NotificationsProvider>{element}</NotificationsProvider>)
}

test("对象存储屏按用途分成中转桶、素材库与私有数据三个分区", () => {
  const html = render(
    <PlatformMediaScreen initialOverview={overview(transitAccount, assetsAccount)} />,
  )
  assert.match(html, /role="tablist"/)
  assert.match(html, /role="tab"/)
  assert.match(html, /role="tabpanel"/)
  assert.match(html, /中转桶/)
  assert.match(html, /素材库/)
  assert.match(html, /私有数据/)
  assert.match(html, /podhub-transit/)
  assert.match(html, /podhub-assets/)
})

test("未配置的角色显示待配置态与配置入口", () => {
  const html = render(
    <PlatformMediaScreen initialOverview={overview(transitAccount)} defaultTab="private" />,
  )
  assert.match(html, /还没有配置这个存储桶/)
  assert.match(html, /配置存储桶/)
})

test("中转桶按批次写入，不提供整桶连通测试", () => {
  const html = render(<PlatformMediaScreen initialOverview={overview(transitAccount)} />)
  const row = [...html.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/g)]
    .map((m) => m[1])
    .find((cell) => cell.includes("podhub-transit"))
  assert.ok(row, "缺中转桶行")
  const testButton = [...row.matchAll(/<button[^>]*>/g)]
    .map((m) => m[0])
    .find((button) => button.includes('aria-label="测试存储桶"'))
  assert.ok(testButton, "缺测试按钮")
  assert.match(testButton, /disabled/)
})

test("单个角色只有一份配置：重新配置与移除存储桶", () => {
  const html = render(<PlatformMediaScreen initialOverview={overview(assetsAccount)} />)
  const row = [...html.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/g)]
    .map((m) => m[1])
    .find((cell) => cell.includes("podhub-assets"))
  assert.ok(row, "缺素材库行")
  const labels = [...row.matchAll(/aria-label="([^"]+)"/g)].map((m) => m[1])
  assert.deepEqual(labels, ["当前存储", "测试存储桶", "重新配置", "移除存储桶"])
})

test("移除只删除当前角色的桶", async () => {
  const previousFetch = globalThis.fetch
  const requests: Array<{ method: string; url: string; body: unknown }> = []
  globalThis.fetch = (async (input, init) => {
    const method = init?.method ?? "GET"
    const body = init?.body ? JSON.parse(String(init.body)) : undefined
    requests.push({ method, url: String(input), body })
    if (String(input) === route("integrationsConfig")) {
      return new Response(JSON.stringify({ data: {
        schema_version: 1,
        revision: 4,
        cache_ttl_seconds: 300,
        ai_default_model: "",
        ai_accounts: [],
        storage_buckets: [
          {
            id: "s3_transit", label: "中转桶", role: "transit", provider: "cloudflare",
            endpoint: "https://r2.example.test", region: "auto", bucket: "podhub-transit",
            key_prefix: "", public_base_url: "https://transit.podhub.si", force_path_style: true, active: true,
          },
          {
            id: "s3_assets", label: "素材库桶", role: "assets", provider: "cloudflare",
            endpoint: "https://r2.example.test", region: "auto", bucket: "podhub-assets",
            key_prefix: "", public_base_url: "https://assets.podhub.si", force_path_style: true, active: true,
          },
        ],
      } }), { headers: { "Content-Type": "application/json" } })
    }
    return new Response(JSON.stringify({ data: {
      schema_version: 1,
      revision: 5,
      cache_ttl_seconds: 300,
      ai_default_model: "",
      ai_accounts: [],
      storage_buckets: [],
    } }), { headers: { "Content-Type": "application/json" } })
  }) as typeof fetch
  try {
    await integrationsHttp.integrationsDeleteMediaAccount({ role: "transit" })
    const put = requests.find((call) => call.method === "PUT")
    assert.ok(put, "缺快照写回")
    const buckets = (put.body as { storage_buckets: Array<{ role: string }> }).storage_buckets
    assert.deepEqual(buckets.map((row) => row.role), ["assets"])
  } finally {
    globalThis.fetch = previousFetch
  }
})

test("私有桶没有公开域名，其余角色必须填写", () => {
  const base = {
    label: "私有数据桶",
    provider: "cloudflare" as const,
    endpoint: "https://acct.r2.cloudflarestorage.com",
    region: "auto",
    bucket: "podhub-private",
    keyPrefix: "",
    publicBaseUrl: "",
    forcePathStyle: true,
    accessKey: "AK",
    secretKey: "SK",
    sessionToken: "",
  }
  const privateHTML = render(
    <MediaEditor draft={{ ...base, role: "private" }} busy={false} hasStoredSecret={false} onChange={() => {}} onSave={() => {}} />,
  )
  assert.doesNotMatch(saveButton(privateHTML), /\sdisabled=""/)
  assert.match(privateHTML, /disabled=""/)

  const assetsHTML = render(
    <MediaEditor draft={{ ...base, role: "assets", bucket: "podhub-assets" }} busy={false} hasStoredSecret={false} onChange={() => {}} onSave={() => {}} />,
  )
  assert.match(saveButton(assetsHTML), /\sdisabled=""/)
})

test("已存密钥的角色允许留空保存", () => {
  const draft = {
    role: "assets" as const,
    label: "素材库桶",
    provider: "cloudflare" as const,
    endpoint: "https://acct.r2.cloudflarestorage.com",
    region: "auto",
    bucket: "podhub-assets",
    keyPrefix: "",
    publicBaseUrl: "https://assets.podhub.si",
    forcePathStyle: true,
    accessKey: "",
    secretKey: "",
    sessionToken: "",
  }
  const html = render(
    <MediaEditor draft={draft} busy={false} hasStoredSecret onChange={() => {}} onSave={() => {}} />,
  )
  assert.doesNotMatch(saveButton(html), /\sdisabled=""/)
  assert.match(html, /留空保留/)
})

function mediaTestAction(initialOverview: IntegrationCredentialsOverview): (id: string) => void {
  let screen: ReactNode
  function Capture() {
    screen = PlatformMediaScreen({ initialOverview })
    return null
  }
  renderToStaticMarkup(<Capture />)
  function findAction(children: ReactNode): ((id: string) => void) | undefined {
    for (const child of Children.toArray(children)) {
      if (!isValidElement<{ children?: ReactNode; onTest?: (id: string) => void }>(child)) continue
      if (child.type === MediaTable && child.props.onTest) return child.props.onTest
      const action = findAction(child.props.children)
      if (action) return action
    }
  }
  const action = findAction(screen)
  assert.ok(action, "缺存储测试入口")
  return action
}

test("存储测试在点击时捕获 Workspace", async () => {
  const previousFetch = globalThis.fetch
  const previousTest = integrationsHttp.integrationsTestMediaAccount
  const calls: unknown[] = []
  const requests: string[] = []
  globalThis.fetch = async (input) => {
    requests.push(String(input))
    assert.equal(String(input), route("viewAccountOverview"))
    return new Response(JSON.stringify({ data: {
      session: { authenticated: true, role: "super_admin" },
      workspaces: [],
      active_workspace: { id: 1, uuid: "workspace-before-render", name: "示例", plan: "pro", role: "owner", is_owned: true },
      owned_count: 1, owned_limit: 3,
    } }), { headers: { "Content-Type": "application/json" } })
  }
  integrationsHttp.integrationsTestMediaAccount = async (target) => {
    calls.push(target)
    return { latency_ms: 1 }
  }
  try {
    const starting = await loadAccountOverview({ force: true })
    assert.ok(starting?.active_workspace)
    const workspace = starting.active_workspace
    const action = mediaTestAction(overview(assetsAccount))
    requests.length = 0
    rememberAccountOverview({ ...starting, active_workspace: { ...workspace, uuid: "workspace-at-click" } })
    action("s3_assets")
    rememberAccountOverview({ ...starting, active_workspace: { ...workspace, uuid: "workspace-after-click" } })
    await Promise.resolve()
    assert.deepEqual(calls, [{ id: "s3_assets", workspaceUuid: "workspace-at-click" }])
    invalidateAccountOverview()
    action("s3_assets")
    await Promise.resolve()
    assert.deepEqual(calls[1], { id: "s3_assets", workspaceUuid: "" })
    assert.deepEqual(requests, [])
  } finally {
    integrationsHttp.integrationsTestMediaAccount = previousTest
    globalThis.fetch = previousFetch
    invalidateAccountOverview()
  }
})

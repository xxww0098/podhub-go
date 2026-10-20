import { useEffect, useState } from "react"
import { CloudUpload, Factory, ImageUp, Plus } from "lucide-react"
import type { IntegrationCredentialsOverview, IntegrationMediaRole, MediaAccountView } from "@/bindings/commands"
import { integrationsHttp } from "@/bindings/http-integrations"
import { PlatformAdminSurface } from "@/components/platform-admin-surface"
import { Button } from "@/components/ui/button"
import { Spinner } from "@/components/ui/spinner"
import { Tabs, TabsContent, TabsIndicator, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { peekAccountOverview } from "@/features/account/account-overview-cache"
import { notifyCommandError, notifySuccess } from "@/lib/notify"
import { MediaDialog } from "./media-dialogs"
import type { MediaDraft } from "./media-editor"
import { MediaTable } from "./media-table"

export type MediaStorageTab = "transit" | "assets" | "private"

function resolveDefaultTab(tab?: MediaStorageTab): MediaStorageTab {
  if (tab) return tab
  if (typeof window !== "undefined") {
    const param = new URLSearchParams(window.location.search).get("tab")
    if (param === "transit" || param === "assets" || param === "private") return param
  }
  return "transit"
}

/** One empty draft per role. The bucket name and public host are fixed. */
function newDraft(role: IntegrationMediaRole, existing?: MediaAccountView): MediaDraft {
  const copy: Record<IntegrationMediaRole, { label: string; bucket: string; publicBase: string }> = {
    transit: { label: "中转桶", bucket: "podhub-transit", publicBase: "https://transit.podhub.si" },
    assets: { label: "素材库桶", bucket: "podhub-assets", publicBase: "https://assets.podhub.si" },
    private: { label: "私有数据桶", bucket: "podhub-private", publicBase: "" },
  }
  const defaults = copy[role]
  return {
    role,
    label: existing?.label ?? defaults.label,
    provider: existing?.provider ?? "cloudflare",
    endpoint: existing?.endpoint ?? "",
    region: existing?.region ?? "auto",
    bucket: existing?.bucket ?? defaults.bucket,
    keyPrefix: existing?.key_prefix ?? "",
    publicBaseUrl: existing?.public_base_url ?? defaults.publicBase,
    forcePathStyle: existing?.force_path_style ?? true,
    accessKey: "",
    secretKey: "",
    sessionToken: "",
  }
}

/**
 * SuperAdmin-only storage screen.
 *
 * One account per bucket role (docs/architecture/storage-*.md):
 * - transit：wasm 渲染产物投递目标，固定上海时间每天 04:00 清空整桶；
 * - assets：公开的长期素材库，公开域名固定为 https://assets.podhub.si；
 * - private：组织私有的长期数据桶，没有公开域名，读取只走短时签名 URL。
 * 服务端逐字校验桶名、端点与公开域名；同一角色第二次出现即拒绝。
 */
export function PlatformMediaScreen({
  initialOverview,
  defaultTab = "transit",
}: {
  initialOverview?: IntegrationCredentialsOverview
  defaultTab?: MediaStorageTab
} = {}) {
  const [overview, setOverview] = useState<IntegrationCredentialsOverview | undefined>(
    initialOverview,
  )
  const [busy, setBusy] = useState(false)
  const [loading, setLoading] = useState(!initialOverview)
  const [testingMediaId, setTestingMediaId] = useState<string>()
  const [mediaTestLatencies, setMediaTestLatencies] = useState<Record<string, number>>({})
  const [draft, setDraft] = useState<MediaDraft>()
  const [tab, setTab] = useState<MediaStorageTab>(() => resolveDefaultTab(defaultTab))

  useEffect(() => {
    if (initialOverview) return
    let cancelled = false
    void integrationsHttp
      .integrationsGetCredentials()
      .then((data) => {
        if (!cancelled) setOverview(data)
      })
      .catch((reason) => {
        if (!cancelled) {
          notifyCommandError(reason, "无法读取对象存储配置，请稍后重试。")
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [initialOverview])

  useEffect(() => {
    if (defaultTab) setTab(resolveDefaultTab(defaultTab))
  }, [defaultTab])

  async function apply(
    next: Promise<IntegrationCredentialsOverview>,
    ok?: { title: string; description?: string },
  ): Promise<boolean> {
    setBusy(true)
    try {
      const data = await next
      setOverview(data)
      if (ok) notifySuccess(ok.title, { description: ok.description })
      return true
    } catch (reason) {
      notifyCommandError(reason, "保存对象存储配置失败，请稍后重试。")
      return false
    } finally {
      setBusy(false)
    }
  }

  async function testMedia(id: string) {
    // Read at click time: this retained screen may outlive a Workspace switch.
    const workspaceUuid = peekAccountOverview()?.active_workspace?.uuid ?? ""
    const label = overview?.media_accounts.find((row) => row.id === id)?.label
    setBusy(true)
    setTestingMediaId(id)
    try {
      const result = await integrationsHttp.integrationsTestMediaAccount({ id, workspaceUuid })
      setMediaTestLatencies((latencies) => ({ ...latencies, [id]: result.latency_ms }))
      notifySuccess(`对象存储连接成功 · ${result.latency_ms} ms`, {
        description: label ? `「${label}」上传与读取正常。` : "对象存储上传与读取正常。",
      })
    } catch (reason) {
      notifyCommandError(reason, "对象存储连接失败，请检查端点、空间与密钥。")
    } finally {
      setBusy(false)
      setTestingMediaId(undefined)
    }
  }

  const rows = overview?.media_accounts ?? []
  const byRole = (role: IntegrationMediaRole) => rows.filter((row) => row.role === role)
  const rowOf = (role: IntegrationMediaRole) => byRole(role)[0]

  const tabs: Array<{ role: IntegrationMediaRole; label: string; icon: typeof CloudUpload; title: string }> = [
    { role: "transit", label: "中转桶", icon: CloudUpload, title: "中转桶：wasm 产物投递，每日 04:00 清空" },
    { role: "assets", label: "素材库", icon: Factory, title: "素材库：公开长期素材" },
    { role: "private", label: "私有数据", icon: ImageUp, title: "私有数据：委托原图 / 模板 / 用户文件" },
  ]

  return (
    <div className="flex w-full flex-col gap-4">
      <Tabs
        value={tab}
        onValueChange={(val) => setTab(val as MediaStorageTab)}
        className="w-full gap-4"
      >
        <div className="flex flex-wrap items-center justify-between gap-3">
          <TabsList variant="line" aria-label="对象存储分区" className="min-w-0 max-w-full overflow-x-auto">
            <TabsIndicator variant="line" />
            {tabs.map(({ role, label, icon: Icon, title }) => (
              <TabsTrigger key={role} value={role} title={title} variant="line" className="shrink-0">
                <Icon aria-hidden className="size-3.5" />
                <span>{label}</span>
              </TabsTrigger>
            ))}
          </TabsList>
          {!rowOf(tab) ? (
            <Button
              type="button"
              size="sm"
              className="cursor-pointer"
              disabled={busy}
              onClick={() => setDraft(newDraft(tab))}
            >
              <Plus data-icon="inline-start" />
              配置存储桶
            </Button>
          ) : null}
        </div>

        {tabs.map(({ role }) => {
          const row = rowOf(role)
          return (
            <TabsContent key={role} value={role} keepMounted className="flex flex-col gap-4 outline-none">
              <PlatformAdminSurface>
                {loading && !overview ? (
                  <div className="grid min-h-48 place-items-center">
                    <Spinner aria-label="正在读取对象存储配置" />
                  </div>
                ) : (
                  <MediaTable
                    rows={row ? [row] : []}
                    busy={busy}
                    testingId={testingMediaId}
                    testLatencies={mediaTestLatencies}
                    emptyMessage="还没有配置这个存储桶。"
                    singleNoun="存储桶"
                    testUnavailableHint={
                      role === "transit" ? "中转桶按批次写入，不提供整桶连通测试" : undefined
                    }
                    onAdd={() => setDraft(newDraft(role))}
                    onTest={role === "transit" ? undefined : (id) => void testMedia(id)}
                    onEdit={(view) => setDraft(newDraft(role, view))}
                    onRemove={() => {
                      void apply(integrationsHttp.integrationsDeleteMediaAccount({ role }), {
                        title: "存储桶已移除",
                        description: "对应功能将不可用，直到重新配置。",
                      })
                    }}
                  />
                )}
              </PlatformAdminSurface>
            </TabsContent>
          )
        })}
      </Tabs>

      <MediaDialog
        draft={draft}
        setDraft={setDraft}
        busy={busy}
        hasStoredSecret={Boolean(draft && rowOf(draft.role))}
        apply={apply}
      />
    </div>
  )
}

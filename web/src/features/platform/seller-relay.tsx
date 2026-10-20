import { useEffect, useState, type ReactNode } from "react"
import { Globe, Trash2, TriangleAlert } from "lucide-react"

import type { SellerRelayData, SellerRelayProbeData } from "@/bindings/commands"
import { integrationsHttp } from "@/bindings/http-integrations"
import { PlatformAdminEmpty, PlatformAdminSurface } from "@/components/platform-admin-surface"
import { StateChip } from "@/components/state-chip"
import { Button } from "@/components/ui/button"
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field"
import { Spinner } from "@/components/ui/spinner"
import { Textarea } from "@/components/ui/textarea"
import { commandErrorCode, errorMessage } from "@/lib/error-message"
import { clearLive, notifyCommandError, notifyLive, notifySuccess } from "@/lib/notify"

const SELLER_RELAY_LIVE = "seller-relay-load"

/** SuperAdmin-only 平台管理 → 网络代理 pane: import VLESS nodes, pick the one in use (ADR-0106). */
export function PlatformSellerRelayScreen() {
  return (
    <>
      <SellerRelayPanel />
    </>
  )
}

export function SellerRelayPanel({ initialConfig }: { initialConfig?: SellerRelayData } = {}) {
  const [config, setConfig] = useState(initialConfig)
  const [links, setLinks] = useState("")
  const [linksRefused, setLinksRefused] = useState(false)
  const [busy, setBusy] = useState(false)
  const [loadError, setLoadError] = useState(false)
  const [probe, setProbe] = useState<SellerRelayProbeData | null>(null)
  const [probing, setProbing] = useState(false)

  async function load() {
    setLoadError(false)
    clearLive(SELLER_RELAY_LIVE)
    try {
      setConfig(await integrationsHttp.integrationsGetSellerRelay())
    } catch (reason) {
      setLoadError(true)
      notifyLive({
        id: SELLER_RELAY_LIVE,
        type: "error",
        reason,
        title: errorMessage(reason, "无法读取网络代理，请稍后重试。"),
        action: { label: "重试", onClick: () => void load() },
      })
    }
  }

  useEffect(() => {
    if (initialConfig) return
    void load()
    return () => clearLive(SELLER_RELAY_LIVE)
  }, [initialConfig])

  if (!config) {
    return (
      <PlatformAdminSurface>
        <PlatformAdminEmpty
          icon={Globe}
          busy={!loadError}
          title={loadError ? undefined : "正在读取网络代理…"}
          action={loadError ? <Button type="button" variant="outline" size="sm" onClick={() => void load()}>重试</Button> : undefined}
        />
      </PlatformAdminSurface>
    )
  }

  const active = config.nodes.find((node) => node.active)
  const locked = busy || probing || !config.sidecar_managed

  async function run(action: () => Promise<SellerRelayData>, done: string, failed: string): Promise<boolean> {
    setBusy(true)
    try {
      setConfig(await action())
      setProbe(null)
      notifySuccess(done)
      return true
    } catch (reason) {
      notifyCommandError(reason, failed)
      // Anything but a refused input may have changed the files; show what is there now.
      if (commandErrorCode(reason) !== "cloud_validation") void load()
      return false
    } finally {
      setBusy(false)
    }
  }

  async function importLinks() {
    const imported = await run(
      () => integrationsHttp.integrationsImportSellerRelayNodes(links),
      "节点已导入",
      "无法导入节点，请检查链接。",
    )
    setLinksRefused(!imported)
    if (imported) setLinks("")
  }

  function switchTo(nodeId: string | null) {
    void run(
      () => integrationsHttp.integrationsSwitchSellerRelay(nodeId),
      nodeId ? "已切换节点" : "已停用代理，Seller 请求改为直连",
      "无法切换，请稍后重试。",
    )
  }

  async function runProbe() {
    setProbing(true)
    try {
      setProbe(await integrationsHttp.integrationsProbeSellerRelay())
    } catch (reason) {
      notifyCommandError(reason, "无法检测连通，请稍后重试。")
    } finally {
      setProbing(false)
    }
  }

  return (
    <PlatformAdminSurface>
      <div className="flex max-w-3xl flex-col gap-6 px-5 py-5">
        {!config.relay_route ? (
          <Notice>本部署的 Seller 出口链（<code className="font-mono">CLOUD_SELLER_EGRESS_ROUTES</code>）没有列出中转，选中的节点不会被使用。</Notice>
        ) : null}
        {!config.sidecar_managed ? <Notice>当前环境没有中转容器（本地开发），不能导入或切换节点。</Notice> : null}

        <section aria-label="节点" className="flex flex-col gap-3">
          <ul className="divide-y divide-border rounded-lg border border-border">
            {config.nodes.length === 0 ? (
              <li className="px-4 py-6 text-sm text-muted-foreground">还没有节点，在下方导入。</li>
            ) : null}
            {config.nodes.map((node) => (
              <li key={node.id} className="flex flex-wrap items-center gap-3 px-4 py-3">
                <div className="min-w-0 basis-full sm:flex-1 sm:basis-auto">
                  <p className="truncate text-sm font-medium">{node.name || node.address}</p>
                  {node.name ? <p className="truncate font-mono text-compact text-muted-foreground">{node.address}</p> : null}
                </div>
                {node.active ? (
                  <StateChip status={config.relay_route ? "使用中" : "已选择，未生效"} tone={config.relay_route ? "good" : undefined} />
                ) : (
                  <Button type="button" variant="outline" size="sm" disabled={locked || !config.relay_route} onClick={() => switchTo(node.id)}>切换到此节点</Button>
                )}
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  aria-label={`删除节点 ${node.name || node.address}`}
                  disabled={locked}
                  onClick={() => void run(() => integrationsHttp.integrationsDeleteSellerRelayNode(node.id), "节点已删除", "无法删除节点，请稍后重试。")}
                >
                  <Trash2 aria-hidden />
                </Button>
              </li>
            ))}
          </ul>
          <div className="flex flex-wrap items-center gap-3">
            {active ? (
              <>
                <Button type="button" variant="outline" size="sm" disabled={locked} onClick={() => void runProbe()}>
                  {probing ? <Spinner data-icon="inline-start" /> : null}检测连通
                </Button>
                {probe ? (
                  <StateChip status={probe.reachable ? `连通 · ${probe.latency_ms ?? "—"} ms` : "不通"} tone={probe.reachable ? "good" : "bad"} />
                ) : null}
                <Button type="button" variant="ghost" size="sm" disabled={locked} onClick={() => switchTo(null)}>停用代理</Button>
              </>
            ) : config.nodes.length > 0 ? (
              <p className="text-sm text-muted-foreground">未使用代理，Seller 请求直连。</p>
            ) : null}
          </div>
        </section>

        <div className="flex flex-col gap-3 border-t border-border pt-5">
          <Field data-invalid={linksRefused || undefined}>
            <FieldLabel htmlFor="seller-relay-links">导入节点</FieldLabel>
            <Textarea
              id="seller-relay-links"
              rows={3}
              spellCheck={false}
              autoComplete="off"
              placeholder="vless://…（每行一个）"
              value={links}
              disabled={locked}
              aria-invalid={linksRefused || undefined}
              onChange={(event) => {
                setLinks(event.target.value)
                setLinksRefused(false)
              }}
            />
            <FieldDescription>在节点服务器上运行 <code className="font-mono">sb info</code>，复制 vless:// 开头的那一行。只支持 REALITY。</FieldDescription>
          </Field>
          <div>
            <Button type="button" disabled={locked || !links.trim()} onClick={() => void importLinks()}>
              {busy ? <Spinner data-icon="inline-start" /> : null}导入
            </Button>
          </div>
        </div>
      </div>
    </PlatformAdminSurface>
  )
}

function Notice({ children }: { children: ReactNode }) {
  return (
    <p className="flex items-start gap-2 text-sm text-muted-foreground">
      <TriangleAlert className="mt-0.5 size-4 shrink-0" aria-hidden />
      <span>{children}</span>
    </p>
  )
}

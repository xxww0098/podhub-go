import { useEffect, useState, type ReactNode } from "react"
import { Activity, Globe, Link2, PackageOpen, RotateCcw, Trash2, TriangleAlert } from "lucide-react"

import type { SellerRelayData, SellerRelayProbeData } from "@/bindings/commands"
import { integrationsHttp } from "@/bindings/http-integrations"
import { PlatformAdminEmpty, PlatformAdminSurface } from "@/components/platform-admin-surface"
import { StateChip } from "@/components/state-chip"
import { Button } from "@/components/ui/button"
import { IconButton } from "@/components/ui/icon-button"
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field"
import { InputGroup, InputGroupAddon, InputGroupTextarea } from "@/components/ui/input-group"
import { Spinner } from "@/components/ui/spinner"
import { Switch } from "@/components/ui/switch"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
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
  const [reading, setReading] = useState(false)
  const [loadError, setLoadError] = useState(false)
  const [probe, setProbe] = useState<SellerRelayProbeData | null>(null)
  const [probing, setProbing] = useState(false)

  async function load() {
    setReading(true)
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
    } finally {
      setReading(false)
    }
  }

  useEffect(() => {
    if (initialConfig) return
    void load()
    return () => clearLive(SELLER_RELAY_LIVE)
  }, [initialConfig])

  if (!config) {
    return (
      <PlatformAdminSurface bodyClassName="border-t-0">
        <PlatformAdminEmpty
          icon={Globe}
          busy={!loadError}
          title={loadError ? undefined : "正在读取网络代理…"}
          action={loadError ? <IconButton icon={RotateCcw} label="重试" variant="outline" size="icon-sm" onClick={() => void load()} /> : undefined}
        />
      </PlatformAdminSurface>
    )
  }

  const active = config.nodes.find((node) => node.active)
  const stateUnknown = reading || loadError
  const locked = busy || probing || stateUnknown || !config.sidecar_managed

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
      if (commandErrorCode(reason) !== "cloud_validation") await load()
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
    setProbe(null)
    try {
      setProbe(await integrationsHttp.integrationsProbeSellerRelay())
    } catch (reason) {
      notifyCommandError(reason, "无法检测连通，请稍后重试。")
    } finally {
      setProbing(false)
    }
  }

  return (
    <PlatformAdminSurface bodyClassName="flex min-h-0 flex-col border-t-0">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-5">
        <section aria-label="代理状态" className="shrink-0 rounded-xl border border-border bg-card p-5 sm:p-6">
          <div className="flex min-w-0 flex-wrap items-center gap-x-5 gap-y-4">
            <div className="min-w-0 flex-1 basis-64">
              <div className="flex flex-wrap items-center gap-3">
                <h3 className="text-2xl font-semibold">网络代理</h3>
                <StateChip status={stateUnknown ? "状态未确认" : active ? (config.relay_route ? "使用中" : "已选择，未生效") : config.nodes.length ? "未启用" : "未配置"} tone={!stateUnknown && active && config.relay_route ? "good" : undefined} />
              </div>
              <p className="mt-3 text-lg text-muted-foreground">{active ? `已选择 ${active.name || active.address}` : config.nodes.length ? "未使用代理，Seller 请求直连。请在下方选择节点启用。" : "未使用代理，Seller 请求直连。"}</p>
            </div>
            {active ? <>
              <Button type="button" aria-label="检测连通" title="检测连通" variant="outline" size="icon-sm" disabled={locked} onClick={() => void runProbe()}>{probing ? <Spinner /> : <Activity aria-hidden />}</Button>
              {probe ? <StateChip status={probe.reachable ? `连通 · ${probe.latency_ms ?? "—"} ms` : "不通"} tone={probe.reachable ? "good" : "bad"} /> : null}
            </> : null}
            <div className="flex items-center gap-3">
              <Switch
                aria-label="代理节点选择"
                checked={Boolean(active)}
                disabled={locked || !active}
                onCheckedChange={(checked) => { if (!checked && active) switchTo(null) }}
              />
              <span className="text-lg text-muted-foreground">{stateUnknown ? "未确认" : active ? (config.relay_route ? "已启用" : "未生效") : "未启用"}</span>
            </div>
          </div>
          {loadError || !config.relay_route || !config.sidecar_managed ? (
            <div className="mt-4 flex flex-col gap-2 border-t border-border pt-4">
              {loadError ? <div role="alert" className="flex flex-wrap items-center gap-2 text-compact text-muted-foreground">当前状态未能更新，请重新读取后再操作。<Button type="button" variant="outline" size="sm" disabled={reading} onClick={() => void load()}>重试读取</Button></div> : null}
              {!config.relay_route ? <Notice>本部署的 Seller 出口链（<code className="font-mono">CLOUD_SELLER_EGRESS_ROUTES</code>）没有列出中转，选中的节点不会被使用。</Notice> : null}
              {!config.sidecar_managed ? <Notice>当前环境没有中转容器（本地开发），不能导入或切换节点。</Notice> : null}
            </div>
          ) : null}
        </section>

        <section className="shrink-0 rounded-xl border border-border bg-card p-5 sm:p-6">
          <Field data-invalid={linksRefused || undefined}>
            <h3 className="text-xl font-semibold">导入节点</h3>
            <FieldLabel className="sr-only" htmlFor="seller-relay-links">VLESS 节点链接</FieldLabel>
            <div className="flex min-w-0 flex-wrap items-start gap-3">
              <InputGroup className="min-w-0 flex-1 basis-56">
                <InputGroupAddon><label htmlFor="seller-relay-links"><Link2 aria-hidden /></label></InputGroupAddon>
                <InputGroupTextarea
                  id="seller-relay-links"
                  rows={1}
                  spellCheck={false}
                  autoComplete="off"
                  className="min-h-12"
                  placeholder="请输入 VLESS 节点链接，每行一个"
                  value={links}
                  disabled={locked}
                  aria-invalid={linksRefused || undefined}
                  onChange={(event) => {
                    setLinks(event.target.value)
                    setLinksRefused(false)
                  }}
                />
              </InputGroup>
              <Button type="button" variant="brand" size="lg" className="h-12 min-w-24" disabled={locked || !links.trim()} onClick={() => void importLinks()}>
                {busy ? <Spinner data-icon="inline-start" /> : null}导入
              </Button>
            </div>
            <FieldDescription>在节点服务器上运行 <code className="font-mono">sb info</code>，复制 vless:// 开头的那一行。只支持 REALITY。</FieldDescription>
          </Field>
        </section>

        <section aria-label="节点" className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-xl border border-border bg-card p-5 sm:p-6">
          <div className="flex shrink-0 items-center justify-between gap-2 pb-4">
            <h3 className="flex items-baseline gap-2 text-xl font-semibold text-foreground">
              节点列表<span className="font-mono text-meta tabular-nums text-muted-foreground">{config.nodes.length}</span>
            </h3>
          </div>
          <Table aria-label="代理节点列表" containerClassName="min-h-0 flex-1 overflow-auto">
            <TableHeader className="sticky top-0 z-10 bg-card [&_th]:h-12 [&_th]:text-md [&_th]:text-foreground"><TableRow><TableHead>节点</TableHead><TableHead>状态</TableHead><TableHead>操作</TableHead></TableRow></TableHeader>
            <TableBody>
              {config.nodes.length === 0 ? <TableRow><TableCell colSpan={3}>
                <div className="flex min-h-64 flex-col items-center justify-center gap-2 text-center">
                  <span className="mb-2 flex size-20 items-center justify-center rounded-full bg-muted text-muted-foreground"><PackageOpen className="size-10" aria-hidden /></span>
                  <p className="text-lg font-medium">暂无代理节点</p>
                  <p className="text-lg text-muted-foreground">{config.sidecar_managed ? "请先导入 VLESS 节点链接。" : "中转容器可用后可导入 VLESS 节点。"}</p>
                </div>
              </TableCell></TableRow> : null}
              {config.nodes.map((node) => (
                <TableRow key={node.id}>
                  <TableCell><div className="flex min-w-32 items-center gap-3">
                    <span aria-hidden className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground"><Globe className="size-4" /></span>
                    <div className="min-w-0"><p className="break-all text-compact font-medium">{node.name || node.address}</p>{node.name ? <p className="break-all font-mono text-meta text-muted-foreground">{node.address}</p> : null}</div>
                  </div></TableCell>
                  <TableCell><StateChip status={stateUnknown ? "状态未确认" : node.active ? (config.relay_route ? "使用中" : "已选择，未生效") : "未启用"} tone={!stateUnknown && node.active && config.relay_route ? "good" : undefined} /></TableCell>
                  <TableCell><div className="flex flex-wrap items-center gap-2">
                    {!node.active ? <Button type="button" variant="outline" size="sm" disabled={locked || !config.relay_route} onClick={() => switchTo(node.id)}>切换到此节点</Button> : null}
                    <IconButton icon={Trash2} label={`删除节点 ${node.name || node.address}`} tip="删除节点" size="icon-sm" disabled={locked} onClick={() => void run(() => integrationsHttp.integrationsDeleteSellerRelayNode(node.id), "节点已删除", "无法删除节点，请稍后重试。")}/>
                  </div></TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </section>
      </div>
    </PlatformAdminSurface>
  )
}

function Notice({ children }: { children: ReactNode }) {
  return (
    <p className="flex items-start gap-2 text-compact text-muted-foreground">
      <TriangleAlert className="mt-0.5 size-4 shrink-0" aria-hidden />
      <span>{children}</span>
    </p>
  )
}

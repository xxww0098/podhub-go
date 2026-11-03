import { useEffect, useState } from "react"
import { RotateCcw, Search } from "lucide-react"
import type { AiPurpose, IntegrationCredentialsOverview } from "@/bindings/commands"
import { adminHttp } from "@/bindings/http-admin"
import { integrationsHttp } from "@/bindings/http-integrations"
import { aiAccountsHttp } from "@/bindings/http-ai-accounts"
import { PlatformAdminSurface } from "@/components/platform-admin-surface"
import { FieldLabel } from "@/components/ui/field"
import { IconButton } from "@/components/ui/icon-button"
import { InputGroup, InputGroupAddon, InputGroupInput } from "@/components/ui/input-group"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Spinner } from "@/components/ui/spinner"
import { Tabs, TabsContent, TabsIndicator, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { notifyCommandError, notifyError, notifySuccess } from "@/lib/notify"
import { accountForModel } from "./ai-account-model"
import { AiAccountPool, AiReadState } from "./ai-account-pool"
import type { AiConnectionState } from "./ai-account-status"
import type { PublishedAiPrice } from "./ai-price-billing"
import { AiAllowlist } from "./ai-prices"
import { AiRuntimeForm } from "./ai-runtime-form"

/**
 * 平台管理 · AI 账号: one snapshot, four views. 识图, 对话 and 生图 each list
 * the accounts of one purpose; 识图 also owns the default model and the
 * published model prices. 运行限制 edits the platform-wide ceilings. All views
 * share one overview and one busy flag, because every write replaces the whole
 * snapshot.
 */
export function PlatformAiAccountsScreen({ initialOverview }: {
  initialOverview?: IntegrationCredentialsOverview
} = {}) {
  const [overview, setOverview] = useState(initialOverview)
  const [loading, setLoading] = useState(!initialOverview)
  const [reload, setReload] = useState(0)
  const [busy, setBusy] = useState(false)
  const [connections, setConnections] = useState<Record<string, AiConnectionState>>({})
  const [prices, setPrices] = useState<PublishedAiPrice[]>()
  const [priceLoading, setPriceLoading] = useState(true)
  const [priceFailed, setPriceFailed] = useState(false)
  const [modelQuery, setModelQuery] = useState("")
  useEffect(() => {
    if (initialOverview && reload === 0) return
    let cancelled = false
    setLoading(true)
    void integrationsHttp.integrationsGetCredentials().then((data) => {
      if (!cancelled) { setOverview(data); setConnections({}) }
    }).catch((reason) => {
      if (!cancelled) { setOverview(undefined); notifyCommandError(reason, "无法读取 AI 账号，请重试。") }
    }).finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [initialOverview, reload])
  useEffect(() => {
    let cancelled = false
    setPriceLoading(true)
    setPriceFailed(false)
    setPrices(undefined)
    void adminHttp.adminListAiPrices().then((data) => {
      if (!cancelled) setPrices(data)
    }).catch((reason) => {
      if (!cancelled) { setPriceFailed(true); notifyCommandError(reason, "无法读取模型价格，请刷新后重试。") }
    }).finally(() => { if (!cancelled) setPriceLoading(false) })
    return () => { cancelled = true }
  }, [reload])

  const accounts = overview?.ai_accounts ?? []
  const defaultModel = overview?.ai_default_model ?? ""
  const unknownAccounts = accounts.filter((account) => account.purpose === null)
  const incomplete = Boolean(overview && (unknownAccounts.length > 0 || !overview.ai_runtime))
  const locked = busy || loading || incomplete
  const selectableModels = [...new Set((prices ?? []).map((price) => price.model))]
    .filter((model) => accountForModel(accounts, model))

  async function setDefaultModel(model: string) {
    if (locked || priceLoading || priceFailed || !prices?.some((price) => price.model === model) || !accountForModel(accounts, model)) return
    setBusy(true)
    try {
      setOverview(await aiAccountsHttp.setDefaultModel(model))
      notifySuccess("识图模型已切换", { description: `之后的识图使用「${model}」。` })
    } catch (reason) { notifyCommandError(reason, "切换识图模型失败，请稍后重试。") }
    finally { setBusy(false) }
  }

  async function deletePrice(model: string): Promise<boolean> {
    if (busy || model === defaultModel) return false
    setBusy(true)
    let removed = false
    try {
      await adminHttp.adminDeleteAiPrice(model)
      removed = true
      setPrices(await adminHttp.adminListAiPrices())
      notifySuccess("识图模型已下架", { description: `「${model}」已退出可售列表，新的识图请求会被拒绝。` })
      return true
    } catch (reason) {
      if (removed) {
        setPriceFailed(true)
        notifyError("识图模型已下架，但列表刷新失败，请重试读取。", { reason })
      } else notifyCommandError(reason, "下架失败，该模型仍在可售列表中。")
      return removed
    } finally { setBusy(false) }
  }

  const retry = () => setReload((value) => value + 1)
  const pool = (purpose: AiPurpose) => overview
    ? <AiAccountPool purpose={purpose} overview={overview} loading={loading} busy={busy} readOnly={incomplete} connections={connections}
        defaultModel={purpose === "ocr" ? defaultModel : undefined}
        onBusy={setBusy} onOverview={setOverview} onConnections={setConnections} onReload={retry} />
    : <AiReadState loading={loading} onRetry={retry} />

  const modelList = priceLoading ? (
    <div className="grid min-h-48 place-items-center rounded-xl border border-border bg-card"><Spinner aria-label="正在读取模型价格" /></div>
  ) : priceFailed ? (
    <div className="flex justify-center rounded-xl border border-border bg-card p-6"><IconButton icon={RotateCcw} label="重试读取价格" variant="outline" onClick={retry} /></div>
  ) : (
    <AiAllowlist
      hideModelSummary
      paginate
      modelQuery={modelQuery}
      listToolbar={<div className="flex min-w-0 items-center gap-2">
        <InputGroup className="min-w-0 flex-1">
          <InputGroupAddon><Search aria-hidden /></InputGroupAddon>
          <InputGroupInput aria-label="搜索模型名称" placeholder="搜索模型名称" value={modelQuery} onChange={(event) => setModelQuery(event.target.value)} />
        </InputGroup>
        <IconButton icon={RotateCcw} label="刷新模型" variant="outline" disabled={busy} onClick={retry} />
      </div>}
      accounts={accounts}
      accountsUnknown={unknownAccounts.length > 0 || !overview}
      defaultModel={defaultModel}
      prices={prices ?? []}
      busy={locked}
      onPrices={setPrices}
      onDefaultModel={(model) => void setDefaultModel(model)}
      onDeletePrice={deletePrice}
    />
  )

  return (
    <div className="flex w-full flex-col gap-3">
      <PlatformAdminSurface bodyClassName="border-t-0">
        {incomplete ? <div role="status" className="mb-3 rounded-lg border border-border bg-card p-3 text-sm text-muted-foreground">
          {unknownAccounts.length ? <p>以下账号用途未确认：{unknownAccounts.map((account) => account.label).join("、")}。</p> : null}
          {!overview?.ai_runtime ? <p>AI 运行限制未确认。</p> : null}
          <p>暂不能修改配置，请更新服务并刷新。</p>
        </div> : null}
        <Tabs defaultValue="ocr">
          <TabsList aria-label="AI 账号分类" variant="line">
            <TabsIndicator variant="line" />
            <TabsTrigger value="ocr" variant="line">AI识图</TabsTrigger>
            <TabsTrigger value="chat" variant="line">对话</TabsTrigger>
            <TabsTrigger value="image" variant="line">生图</TabsTrigger>
            <TabsTrigger value="runtime" variant="line">运行限制</TabsTrigger>
          </TabsList>
          <TabsContent value="ocr" keepMounted className="flex flex-col gap-3 pt-1">
            <section className="flex flex-wrap items-center gap-x-4 gap-y-3 rounded-xl border border-border bg-card px-4 py-4">
              <FieldLabel htmlFor="ai-default-model">AI识图默认模型</FieldLabel>
              <Select value={defaultModel || null} onValueChange={(model) => { if (model && model !== defaultModel) void setDefaultModel(model) }}>
                <SelectTrigger id="ai-default-model" className="min-w-0 flex-1 basis-56" aria-label="AI识图默认模型" disabled={!overview || locked || priceLoading || priceFailed || selectableModels.length === 0}>
                  <SelectValue>{() => overview ? defaultModel || "尚未选择" : loading ? "正在读取…" : "状态未确认"}</SelectValue>
                </SelectTrigger>
                <SelectContent>
                  {defaultModel && !selectableModels.includes(defaultModel) ? <SelectItem value={defaultModel} disabled>{defaultModel}（不可选）</SelectItem> : null}
                  {selectableModels.map((model) => <SelectItem key={model} value={model}>{model}</SelectItem>)}
                </SelectContent>
              </Select>
              {priceFailed ? <span role="status" className="text-meta text-muted-foreground">模型价格未确认，请刷新。</span> : null}
              {overview && !incomplete && !priceLoading && !priceFailed && selectableModels.length === 0 ? <span className="basis-full text-meta text-muted-foreground">需先为模型定价并配置可用的AI识图账号。</span> : null}
            </section>
            {pool("ocr")}
            {modelList}
          </TabsContent>
          <TabsContent value="chat" keepMounted className="flex flex-col gap-3 pt-1">{pool("chat")}</TabsContent>
          <TabsContent value="image" keepMounted className="flex flex-col gap-3 pt-1">{pool("image")}</TabsContent>
          <TabsContent value="runtime" keepMounted className="pt-1">
            {overview?.ai_runtime
              ? <AiRuntimeForm key={JSON.stringify(overview.ai_runtime)} runtime={overview.ai_runtime} busy={locked} onBusy={setBusy} onOverview={setOverview} />
              : overview ? <p role="status" className="rounded-lg border border-border bg-card p-4 text-sm text-muted-foreground">AI 运行限制未确认，请更新服务并刷新。</p>
                : <AiReadState loading={loading} onRetry={retry} />}
          </TabsContent>
        </Tabs>
      </PlatformAdminSurface>
    </div>
  )
}

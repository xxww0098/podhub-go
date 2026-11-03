import { estimateCallYuan } from "@/lib/ai-call-estimate"
/** OCR default model and independently published retail prices. */
import { useEffect, useState, type ReactNode } from "react"
import type { AiAccountView } from "@/bindings/commands"
import { adminHttp } from "@/bindings/http-admin"
import { aiAccountsHttp } from "@/bindings/http-ai-accounts"
import { PlatformAdminDialog } from "@/components/platform-admin-dialog"
import { Button } from "@/components/ui/button"
import { IconButton } from "@/components/ui/icon-button"
import { ConfirmDialog } from "@/components/ui/confirm-dialog"
import { PlatformAdminEmpty } from "@/components/platform-admin-surface"
import { Spinner } from "@/components/ui/spinner"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { StateChip } from "@/components/state-chip"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { Activity, ChevronLeft, ChevronRight, Info, Plus, ScanText, SquarePen, Trash2 } from "lucide-react"
import { notifyCommandError, notifyError, notifyInfo, notifySuccess } from "@/lib/notify"
import { accountForModel } from "./ai-account-model"
import { billingDraftFromPrice, publishRequestFromBilling, microfenToYuan, formatYuan, type PublishedAiPrice } from "./ai-price-billing"
import { PriceEditor, type PriceDraft } from "./ai-price-editor"

export function AiAllowlist({
  accounts,
  defaultModel,
  prices,
  busy,
  accountsUnknown = false,
  paginate = false,
  hideModelSummary = false,
  modelSummary,
  modelQuery = "",
  listToolbar,
  onPrices,
  onDefaultModel,
  onDeletePrice,
}: {
  accounts: AiAccountView[]
  defaultModel: string
  prices: PublishedAiPrice[]
  busy: boolean
  accountsUnknown?: boolean
  paginate?: boolean
  /** 外层容器（如 PlatformAdminSurface）已展示当前识图摘要时，隐藏内联重复的当前识别模型摘要。 */
  hideModelSummary?: boolean
  modelSummary?: ReactNode
  modelQuery?: string
  listToolbar?: ReactNode
  onPrices: (prices: PublishedAiPrice[]) => void
  onDefaultModel: (model: string) => void
  /** 下架一个已定价模型；返回是否成功（失败原因走通知）。 */
  onDeletePrice: (model: string) => Promise<boolean>
}) {
  const [draft, setDraft] = useState<PriceDraft>()
  const [unpublishing, setUnpublishing] = useState<string>()
  const [testingModel, setTestingModel] = useState<string>()
  const readyAccount = accountForModel(accounts, defaultModel)
  const [saving, setSaving] = useState(false)
  const [pageSize, setPageSize] = useState("10")
  const [page, setPage] = useState(1)
  const defaultUnpublished =
    Boolean(defaultModel) && !prices.some((price) => price.model === defaultModel)
  const query = modelQuery.trim().toLocaleLowerCase()
  const visiblePrices = prices.filter((price) => price.model.toLocaleLowerCase().includes(query))
  const visibleUnpublished = defaultUnpublished && defaultModel.toLocaleLowerCase().includes(query)
  const visibleCount = visiblePrices.length + Number(visibleUnpublished)
  const pageCount = Math.max(1, Math.ceil(visibleCount / Number(pageSize)))
  const currentPage = Math.min(page, pageCount)
  const start = (currentPage - 1) * Number(pageSize)
  const offset = Number(visibleUnpublished)
  const displayedPrices = paginate
    ? visiblePrices.slice(Math.max(0, start - offset), Math.max(0, start + Number(pageSize) - offset))
    : visiblePrices
  const showUnpublished = visibleUnpublished && (!paginate || start === 0)
  useEffect(() => { setPage(1) }, [modelQuery, pageSize])
  useEffect(() => { setPage((current) => Math.min(current, pageCount)) }, [pageCount])

  function openEditor(model: string, price?: PublishedAiPrice) {
    setDraft({
      model,
      billing: billingDraftFromPrice(price),
      existing: Boolean(price),
      setCurrent: false,
    })
  }

  /**
   * 只读一次上游模型目录：凭证有效且目录里有这个模型才算通过。探测不发起
   * 识图、不消耗 Token；目录没列出只是提示——部分网关不公开目录。
   */
  async function testModel(model: string) {
    const account = accountForModel(accounts, model)?.id
    if (!account || testingModel !== undefined) return
    setTestingModel(model)
    try {
      const result = await aiAccountsHttp.verifyModel({
        id: account,
        model,
      })
      if (result.model_present) {
        notifySuccess(`「${model}」测试通过 · ${result.latency_ms} ms`, {
          description: "上游凭证有效，模型出现在上游目录中。",
        })
      } else {
        notifyInfo(`凭证有效，但上游未列出「${model}」`, {
          description: "部分网关不公开模型目录，识图仍可能可用；可用真实识图复核。",
        })
      }
    } catch (reason) {
      notifyCommandError(reason, "模型测试失败，请检查上游账号与网络。")
    } finally {
      setTestingModel(undefined)
    }
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3">
      {modelSummary || !hideModelSummary ? <section className="shrink-0 overflow-hidden rounded-xl border border-border bg-card">
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2 p-5">
          {modelSummary}
          {hideModelSummary ? null : (
            <div className="flex min-w-0 flex-1 basis-56 items-center gap-3">
              <span aria-hidden className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground">
                <ScanText className="size-4" />
              </span>
              <div className="min-w-0">
                <p className="text-meta text-muted-foreground">当前识图</p>
                <p className="truncate font-mono text-compact font-medium">{defaultModel || "—"}</p>
              </div>
              {readyAccount ? (
                defaultUnpublished ? (
                  <StateChip status="unknown" label="未定价" />
                ) : (
                  <StateChip status="good" label="已就绪" />
                )
              ) : (
                <StateChip status="idle" label="待配置" />
              )}
            </div>
          )}
        </div>
        {!readyAccount && !modelSummary ? (
          <p className="flex items-center gap-2 border-t border-border bg-muted/40 px-4 py-2 text-meta text-muted-foreground">
            <Info aria-hidden className="size-3.5 shrink-0" />
            上游账号未就绪，仍可先发布模型和价格。
          </p>
        ) : null}
      </section> : null}
      <section className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden rounded-xl border border-border bg-card">
        <div className="flex shrink-0 flex-wrap items-center gap-2 p-2">
          {listToolbar ? <div className="min-w-0 flex-1 basis-64">{listToolbar}</div> : null}
          <IconButton icon={Plus} label="添加模型" size="icon-sm" variant="outline" disabled={busy} onClick={() => openEditor("")} />
        </div>
        <Table variant="directory" containerClassName="min-h-0 flex-1 overflow-auto">
          <TableHeader className="sticky top-0 z-10 bg-card">
            <TableRow>
              <TableHead>模型</TableHead>
              <TableHead>计价</TableHead>
              <TableHead>{paginate ? "价格" : "零售（元 / 百万 Token）"}</TableHead>
              <TableHead className="w-24">单次约估</TableHead>
              <TableHead className="w-24">生效自</TableHead>
              <TableHead className="w-40">操作</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {prices.length === 0 && !defaultUnpublished ? (
              <TableRow><TableCell colSpan={6}>
                <PlatformAdminEmpty icon={ScanText} title="还没有识图模型" description="添加模型并定价后，即可选为默认识图模型。" />
              </TableCell></TableRow>
            ) : visiblePrices.length === 0 && !visibleUnpublished ? (
              <TableRow><TableCell colSpan={6}>
                <PlatformAdminEmpty icon={ScanText} title="没有匹配的模型" description="试试其他模型名称。" />
              </TableCell></TableRow>
            ) : null}
            {showUnpublished ? (
              <TableRow>
                <TableCell>
                  <span className="flex items-center gap-2 font-mono text-sm">
                    <span className="max-w-56 truncate" title={defaultModel}>
                      {defaultModel}
                    </span>
                    <StateChip status="unknown" label="未定价" />
                  </span>
                </TableCell>
                <TableCell colSpan={4} className="text-xs text-muted-foreground">
                  请先定价，再使用此模型识图
                </TableCell>
                <TableCell>
                  <div className="flex flex-nowrap items-center gap-1.5">
                    <Button
                      type="button"
                      size="sm"
                      className="cursor-pointer"
                      disabled={busy}
                      onClick={() => openEditor(defaultModel)}
                    >
                      为它定价
                    </Button>
                    <ModelTestButton
                      model={defaultModel}
                      accountReady={Boolean(readyAccount)}
                      busy={busy}
                      testingModel={testingModel}
                      onTest={(model) => void testModel(model)}
                    />
                  </div>
                </TableCell>
              </TableRow>
            ) : null}
            {displayedPrices.map((price) => {
              const current = defaultModel === price.model
              const supported = Boolean(accountForModel(accounts, price.model))
              return (
                <TableRow key={price.model}>
                  <TableCell>
                    <span className="flex items-center gap-2 font-mono text-sm">
                      <span className="max-w-56 truncate" title={price.model}>
                        {price.model}
                      </span>
                      {current ? <StateChip status="present" label="默认识图" /> : null}
                      {!supported ? <StateChip status={accountsUnknown ? "unknown" : "idle"} label={accountsUnknown ? "账号状态未确认" : "无可用账号"} /> : null}
                    </span>
                  </TableCell>
                  <TableCell className="text-xs whitespace-nowrap text-muted-foreground">
                    {price.billing_mode === "per_request" ? "按次" : "Token"}
                  </TableCell>
                  <TableCell>
                    {price.billing_mode === "per_request" ? (
                      <span className="text-xs tabular-nums">
                        ¥{microfenToYuan(price.per_request_microfen ?? 0)} / 次
                      </span>
                    ) : (
                      <span className="flex flex-col gap-0.5">
                        <span className="text-xs font-medium tabular-nums">
                          入 {microfenToYuan(price.input_microfen_per_million)} · 出{" "}
                          {microfenToYuan(price.output_microfen_per_million)}
                        </span>
                        <span className="text-meta tabular-nums text-faint-foreground">
                          缓存 {microfenToYuan(price.cached_input_microfen_per_million)} ·
                          思考 {microfenToYuan(price.reasoning_microfen_per_million)} ·
                          预占 ≤¥{microfenToYuan(price.max_request_microfen)}
                        </span>
                      </span>
                    )}
                  </TableCell>
                  <TableCell
                    className="text-xs tabular-nums text-muted-foreground"
                    title="按典型识图 4 万输入 + 3.5 千输出估算"
                  >
                    ¥{formatYuan(estimateCallYuan(price))}
                  </TableCell>
                  <TableCell className="text-xs whitespace-nowrap tabular-nums text-muted-foreground">
                    {price.effective_from?.slice(0, 10) || "—"}
                  </TableCell>
                  <TableCell>
                    <div className="flex flex-nowrap items-center gap-1.5">
                      {!current ? (
                        <Button
                          type="button"
                          size="sm"
                          variant="outline"
                          className="cursor-pointer"
                          disabled={busy || !supported}
                          title={!supported ? "请先在AI识图账号中启用支持该模型的账号" : undefined}
                          onClick={() => onDefaultModel(price.model)}
                        >
                          设为识图
                        </Button>
                      ) : null}
                      <ModelTestButton
                        model={price.model}
                        accountReady={supported}
                        busy={busy}
                        testingModel={testingModel}
                        onTest={(model) => void testModel(model)}
                      />
                      <Tooltip>
                        <TooltipTrigger
                          render={
                            <Button
                              type="button"
                              size="icon-sm"
                              variant="outline"
                              className="cursor-pointer"
                              aria-label={`编辑 ${price.model} 价格`}
                              disabled={busy}
                              onClick={() => openEditor(price.model, price)}
                            />
                          }
                        >
                          <SquarePen aria-hidden />
                        </TooltipTrigger>
                        <TooltipContent>编辑价格</TooltipContent>
                      </Tooltip>
                      <Tooltip>
                        <TooltipTrigger
                          render={
                            <Button
                              type="button"
                              size="icon-sm"
                              variant="outline"
                              className="cursor-pointer"
                              aria-label={`下架 ${price.model}`}
                              disabled={busy || current}
                              onClick={() => setUnpublishing(price.model)}
                            />
                          }
                        >
                          <Trash2 aria-hidden />
                        </TooltipTrigger>
                        <TooltipContent>
                          {current
                            ? "当前识图模型不能下架，请先切换"
                            : "下架 · 新的识图请求将拒绝该模型"}
                        </TooltipContent>
                      </Tooltip>
                    </div>
                  </TableCell>
                </TableRow>
              )
            })}
          </TableBody>
        </Table>
      </section>
      {paginate ? <div className="flex flex-wrap items-center justify-between gap-3 px-2 text-sm text-muted-foreground">
        <div className="flex items-center gap-2"><span>共 {visibleCount} 条，每页</span>
          <Select value={pageSize} onValueChange={(value) => { if (value) setPageSize(value) }}>
            <SelectTrigger aria-label="每页模型数"><SelectValue>{(value) => `${value} 条`}</SelectValue></SelectTrigger>
            <SelectContent><SelectItem value="10">10 条</SelectItem><SelectItem value="20">20 条</SelectItem><SelectItem value="50">50 条</SelectItem></SelectContent>
          </Select>
        </div>
        <div className="flex items-center gap-2">
          <IconButton icon={ChevronLeft} label="上一页模型" variant="outline" disabled={currentPage <= 1} onClick={() => setPage(currentPage - 1)} />
          <span aria-label={`第 ${currentPage} 页，共 ${pageCount} 页`} className="grid size-9 place-items-center rounded-lg bg-brand text-sm font-medium text-white">{currentPage}</span>
          <IconButton icon={ChevronRight} label="下一页模型" variant="outline" disabled={currentPage >= pageCount} onClick={() => setPage(currentPage + 1)} />
        </div>
      </div> : <p className="px-2 text-sm text-muted-foreground">共 {prices.length} 个已定价模型</p>}
      <PlatformAdminDialog
        open={Boolean(draft)}
        onOpenChange={(open) => { if (!open && !saving) setDraft(undefined) }}
        title={draft?.existing ? "编辑价格" : "添加识图模型"}
        description="模型 id 与零售价"
        width="sm:max-w-md"
      >
        {draft ? (
          <PriceEditor
            draft={draft}
            accounts={accounts}
            defaultModel={defaultModel}
            busy={busy || saving}
            onChange={(next) => {
              const targetPrice = prices.find((price) => price.model === next.model.trim())
              setDraft((current) => {
                if (!current) return current
                const modelChanged = current.model.trim() !== next.model.trim()
                return {
                  ...next,
                  model: next.model.trim(),
                  billing:
                    modelChanged && targetPrice
                      ? billingDraftFromPrice(targetPrice)
                      : next.billing,
                  existing: Boolean(targetPrice),
                }
              })
            }}
            onSave={() => {
              const request = publishRequestFromBilling(draft.model.trim(), draft.billing)
              if (!request || saving) return
              setSaving(true)
              void (async () => {
                let published = false
                try {
                  await adminHttp.adminPublishAiPrice(request)
                  published = true
                  setDraft(undefined)
                  onPrices(await adminHttp.adminListAiPrices())
                  notifySuccess(draft.existing ? "价格已更新" : "识图模型已定价", {
                    description: `「${request.model}」按此价格计费。`,
                  })
                  const setCurrent = draft.setCurrent
                  if (setCurrent && accountForModel(accounts, request.model)) onDefaultModel(request.model)
                } catch (reason) {
                  if (published) notifyError("价格已保存，但列表刷新失败，请刷新页面。", { reason })
                  else notifyCommandError(reason, "价格保存失败，请重试。")
                } finally { setSaving(false) }
              })()
            }}
          />
        ) : null}
      </PlatformAdminDialog>
      <ConfirmDialog
        open={unpublishing !== undefined}
        onOpenChange={(open) => {
          if (!open) setUnpublishing(undefined)
        }}
        title="下架识图模型"
        description={`下架后「${unpublishing ?? ""}」立即退出可售列表，新的识图与 AI 请求会被拒绝；进行中和已结算的请求不受影响。`}
        confirmText="下架"
        busy={busy}
        onConfirm={async () => {
          const model = unpublishing
          if (!model) return
          if (await onDeletePrice(model)) setUnpublishing(undefined)
        }}
      />
    </div>
  )
}

/**
 * 一行一个模型的只读探测：读上游模型目录（不发识图、不计费）。上游账号
 * 未就绪时禁用——没有账号就没有可探测的凭证。
 */
function ModelTestButton({
  model,
  accountReady,
  busy,
  testingModel,
  onTest,
}: {
  model: string
  accountReady: boolean
  busy: boolean
  testingModel?: string
  onTest: (model: string) => void
}) {
  const testing = testingModel === model
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            type="button"
            size="icon-sm"
            variant="outline"
            className="cursor-pointer"
            aria-label={testing ? `正在测试 ${model}` : `测试 ${model}`}
            disabled={busy || testingModel !== undefined || !accountReady}
            onClick={() => onTest(model)}
          />
        }
      >
        {testing ? <Spinner aria-hidden /> : <Activity aria-hidden />}
      </TooltipTrigger>
      <TooltipContent>
        {accountReady
          ? "测试上游连通与模型可用性 · 只读模型目录，不消耗 Token"
          : "上游账号未就绪，无法测试"}
      </TooltipContent>
    </Tooltip>
  )
}

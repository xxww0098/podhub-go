import { estimateCallYuan } from "@/lib/ai-call-estimate"
/** OCR default model and independently published retail prices. */
import { useState } from "react"
import type { AiAccountView, AiPriceView } from "@/bindings/commands"
import { adminHttp } from "@/bindings/http-admin"
import { aiAccountsHttp } from "@/bindings/http-ai-accounts"
import { PlatformAdminDialog } from "@/components/platform-admin-dialog"
import { Button } from "@/components/ui/button"
import { ConfirmDialog } from "@/components/ui/confirm-dialog"
import { Spinner } from "@/components/ui/spinner"
import { StateChip } from "@/components/state-chip"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { Activity, Plus, ScanText, SquarePen, Trash2 } from "lucide-react"
import { notifyCommandError, notifyInfo, notifySuccess } from "@/lib/notify"
import { accountForModel } from "./ai-account-model"
import { billingDraftFromPrice, publishRequestFromBilling, microfenToYuan, formatYuan } from "./ai-price-billing"
import { PriceEditor, type PriceDraft } from "./ai-price-editor"

export function AiAllowlist({
  accounts,
  defaultModel,
  prices,
  busy,
  hideModelSummary = false,
  onPrices,
  onDefaultModel,
  onDeletePrice,
}: {
  accounts: AiAccountView[]
  defaultModel: string
  prices: AiPriceView[]
  busy: boolean
  /** 外层容器（如 PlatformAdminSurface）已展示当前识图摘要时，隐藏内联重复的当前识别模型摘要。 */
  hideModelSummary?: boolean
  onPrices: (prices: AiPriceView[]) => void
  onDefaultModel: (model: string) => void
  /** 下架一个已定价模型；返回是否成功（失败原因走通知）。 */
  onDeletePrice: (model: string) => Promise<boolean>
}) {
  const [draft, setDraft] = useState<PriceDraft>()
  const [unpublishing, setUnpublishing] = useState<string>()
  const [testingModel, setTestingModel] = useState<string>()
  const readyAccount = accountForModel(accounts, defaultModel)
  const [saving, setSaving] = useState(false)
  const defaultUnpublished =
    Boolean(defaultModel) && !prices.some((price) => price.model === defaultModel)

  function openEditor(model: string, price?: AiPriceView) {
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
    <div className="flex flex-col">
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2 border-b border-border px-4 py-3">
        {hideModelSummary ? (
          <p className="text-xs text-muted-foreground">
            {!readyAccount
              ? "上游账号未就绪，仍可先发布模型和价格。"
              : "定价后的模型可用于识图。"}
          </p>
        ) : (
          <div className="flex min-w-0 items-center gap-2">
            <ScanText aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
            <span className="shrink-0 text-compact text-muted-foreground">当前识图</span>
            <span className="truncate font-mono text-sm font-medium">
              {defaultModel || "—"}
            </span>
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
        <div className="ml-auto flex items-center gap-2">
          <Button
            type="button"
            size="sm"
            className="cursor-pointer"
            disabled={busy}
            onClick={() => openEditor("")}
          >
            <Plus data-icon="inline-start" />
            添加模型
          </Button>
        </div>
      </div>
      {!readyAccount && !hideModelSummary ? (
        <p className="border-b border-border px-4 py-2.5 text-xs text-muted-foreground">
          上游账号未就绪，仍可先发布模型和价格。
        </p>
      ) : null}
      {prices.length === 0 && !defaultUnpublished ? (
        <div className="flex flex-col items-center gap-1.5 px-4 py-10 text-center">
          <p className="text-sm text-muted-foreground">还没有识图模型。</p>
          <p className="text-meta text-faint-foreground">
            添加模型并定价后，即可选为默认识图模型。
          </p>
        </div>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>模型</TableHead>
              <TableHead>计价</TableHead>
              <TableHead>零售（元 / 百万 Token）</TableHead>
              <TableHead className="w-24">单次约估</TableHead>
              <TableHead className="w-24">生效自</TableHead>
              <TableHead className="w-40">操作</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {defaultUnpublished ? (
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
            {prices.map((price) => {
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
                      {!supported ? <StateChip status="idle" label="无可用账号" /> : null}
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
                    {price.effective_from.slice(0, 10) || "—"}
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
                          title={!supported ? "请先在 AI 账号池启用支持该模型的账号" : undefined}
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
      )}
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
                try {
                  onPrices(await adminHttp.adminPublishAiPrice(request))
                  notifySuccess(draft.existing ? "价格已更新" : "识图模型已定价", {
                    description: `「${request.model}」按此价格计费。`,
                  })
                  const setCurrent = draft.setCurrent
                  setDraft(undefined)
                  if (setCurrent && accountForModel(accounts, request.model)) onDefaultModel(request.model)
                } catch (reason) {
                  notifyCommandError(reason, "价格保存失败，请重试。")
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

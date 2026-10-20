/**
 * 「同款规格」的预览 → 确认 → 逐项结果。
 *
 * 预览是服务端对明确选定商品的定向读取；执行只发 `operationId` + 预览摘要，
 * 摘要只能来自这次预览。重复点击复用同一个 operationId（写账本重放回执，
 * 不会二次写 Seller）；摘要变了、或关掉重开都会换新 id。
 *
 * 409 = 预览之后事实变了（属性被外部改过、凭据轮换、权限撤销）：这里重新预览，
 * 绝不重试写入。任务号只证明已受理，只有 `applied` 才显示「已并入同款」。
 *
 * 观察走有界预算（10 轮 / 5 秒 / 30 分钟），到点转常驻的「待人工核实」提示——
 * 读不到不等于完成。
 */
import { useRef, useState } from "react"

import { productVariantsHttp, type VariantOperationItem } from "@/bindings/http-product-variants"
import { Button } from "@/components/ui/button"
import { ConfirmDialog } from "@/components/ui/confirm-dialog"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { StateChip } from "@/components/state-chip"
import {
  clearLive,
  notifyCommandError,
  notifyError,
  notifyInfo,
  notifyLive,
  notifySuccess,
} from "@/lib/notify"
import { useVisiblePolling } from "@/lib/visible-polling"

import { ACTION_LABEL } from "./products-actions"
import type { StoreProductRow } from "./products-api"
import { useOperationIds } from "./products-dispatch"
import { VariantPreviewPane } from "./products-variant-body"
import {
  VARIANT_ACTION_NOTE,
  VARIANT_OBSERVE_INTERVAL_MS,
  buildVariantOperationCommand,
  buildVariantPreviewRequest,
  variantActionOf,
  variantCheckedLabel,
  variantItemDetailCopy,
  variantItemStateView,
  variantObservationExhausted,
  variantOperationCounts,
  variantOutcomeNotice,
  variantRefusalStep,
  variantTargetReady,
  variantTargetsForStore,
  type VariantProductAction,
  type VariantTargetChoice,
  type VariantTargetOption,
} from "./products-variant-model"
import { useVariantPreview } from "./products-variant-preview"

/** 常驻提示的键：还有商品没确认时一直挂着，直到核实清楚。 */
export const LIVE_VARIANT_OPEN = "products-variant-open"

type VariantOperationResult = {
  operationId: string
  items: VariantOperationItem[]
}

/** 逐项结果：每件商品的真实结果 + 只读复核入口。 */
export function VariantOperationResults({
  items,
  checkedLabel,
  verifying,
  onVerify,
}: {
  items: readonly VariantOperationItem[]
  checkedLabel: string | null
  verifying: boolean
  onVerify: () => void
}) {
  return (
    <section className="flex flex-col gap-1.5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-compact font-medium">逐项结果</h3>
        <div className="flex items-center gap-2">
          {checkedLabel ? (
            <span className="text-meta text-muted-foreground">{checkedLabel}</span>
          ) : null}
          <Button type="button" variant="outline" size="xs" disabled={verifying} onClick={onVerify}>
            {verifying ? "核实中…" : "核实结果"}
          </Button>
        </div>
      </div>
      <ul className="flex flex-col gap-1">
        {items.map((item) => {
          const view = variantItemStateView(item.state)
          const detail = variantItemDetailCopy(item.detailCode)
          return (
            <li
              key={`${item.productId}:${item.offerId}`}
              className="flex items-start justify-between gap-2"
            >
              <span className="flex min-w-0 flex-col">
                <span className="truncate font-mono text-xs" title={item.offerId}>
                  {item.offerId}
                </span>
                {detail ? <span className="text-xs text-muted-foreground">{detail}</span> : null}
              </span>
              <StateChip status={view.label} label={view.label} tone={view.tone} />
            </li>
          )
        })}
      </ul>
    </section>
  )
}

/** 只有移入需要选择已核实的目标；合并和拆出都由服务端建立新型号。 */
function VariantTargetPicker({
  modelId,
  targets,
  onModelId,
}: {
  modelId: string
  targets: readonly VariantTargetOption[]
  onModelId: (modelId: string) => void
}) {
  return (
    <label className="grid gap-1 text-compact">
      <span className="font-medium">目标同款</span>
      <Select value={modelId} onValueChange={(value) => value && onModelId(value)}>
        <SelectTrigger aria-label="已核实的同款" disabled={targets.length === 0}>
          <SelectValue>
            {() => targets.find((target) => target.modelId === modelId)?.label ?? "选择已核实的同款"}
          </SelectValue>
        </SelectTrigger>
        <SelectContent>
          {targets.map((target) => (
            <SelectItem key={target.modelId} value={target.modelId}>
              {target.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {targets.length === 0 ? (
        <span className="text-muted-foreground">当前列表没有已核实的同款，请先同步店铺并显示目标组。</span>
      ) : null}
    </label>
  )
}

export function ProductVariantDialog({
  action,
  rows,
  storeName,
  scopeKey,
  targets,
  onClose,
  onApplied,
}: {
  action: VariantProductAction
  /** 同一家店铺的可写行（外层已过滤并按店分组）。 */
  rows: StoreProductRow[]
  storeName: string
  /** 打开状态的范围键（工作空间 + 店铺）：变了就是在途读取作废。 */
  scopeKey: string
  targets: readonly VariantTargetOption[]
  onClose: () => void
  /** 有回执落地时通知外层重读镜像与汇总。 */
  onApplied: () => void
}) {
  const variantAction = variantActionOf(action)
  const storeId = rows[0]?.store_id ?? ""
  // 候选只取本店：一次分组操作只写一家店，跨店的型号号不能当目标。
  const candidates = variantTargetsForStore(targets, storeId)
  const [targetModelId, setTargetModelId] = useState(candidates[0]?.modelId ?? "")
  const [submitting, setSubmitting] = useState(false)
  const [result, setResult] = useState<VariantOperationResult | null>(null)
  const [checkedAtMs, setCheckedAtMs] = useState<number | null>(null)
  const [verifying, setVerifying] = useState(false)
  const [cooledDown, setCooledDown] = useState(false)
  const observeStartedAt = useRef(0)
  const passes = useRef(0)
  const operationIdsFor = useOperationIds(scopeKey)

  const target: VariantTargetChoice = variantAction === "move"
    ? { kind: "verified", modelId: targetModelId }
    : { kind: "new" }
  const request =
    storeId && rows.length > 0 && variantTargetReady(target)
      ? buildVariantPreviewRequest({ storeId, action: variantAction, rows, target })
      : null
  const { state, reload } = useVariantPreview({
    enabled: true,
    scopeKey,
    request,
    failureCopy: "无法读取同款规格预览，请稍后重试。",
  })

  const unsettled = result !== null && variantOperationCounts(result.items).open > 0

  /** 只读复核。自动观察静默失败，下一轮或到点后的常驻提示负责说明。 */
  async function readOperation(quiet: boolean) {
    const operationId = result?.operationId
    if (!operationId) return
    setVerifying(true)
    try {
      const data = await productVariantsHttp.operation(operationId)
      setResult({ operationId: data.operationId ?? operationId, items: data.items })
      setCheckedAtMs(data.lastCheckedAtMs ?? Date.now())
      const counts = variantOperationCounts(data.items)
      if (counts.open === 0) clearLive(LIVE_VARIANT_OPEN)
      if (quiet) return
      if (counts.open > 0) {
        notifyLive({
          id: LIVE_VARIANT_OPEN,
          type: "unknown",
          title: `${counts.open} 件还没确认生效`,
          description: "Ozon 生效需要时间；自动核实到上限后可以手动再核实。",
          action: { label: "再核实一次", onClick: requestVerify },
        })
        return
      }
      clearLive(LIVE_VARIANT_OPEN)
      if (counts.rejected > 0) notifyInfo(variantOutcomeNotice(counts))
      else notifySuccess(variantOutcomeNotice(counts))
    } catch (reason) {
      if (!quiet) notifyCommandError(reason, "无法读取这次操作的结果，请稍后重试。")
    } finally {
      setVerifying(false)
    }
  }

  /** 手动核实：冷却后重开一轮读取预算。 */
  function requestVerify() {
    if (cooledDown) {
      passes.current = 0
      observeStartedAt.current = Date.now()
      setCooledDown(false)
      clearLive(LIVE_VARIANT_OPEN)
      return
    }
    void readOperation(false)
  }

  useVisiblePolling({
    enabled: unsettled && !cooledDown,
    intervalMs: VARIANT_OBSERVE_INTERVAL_MS,
    restartKey: result?.operationId ?? "",
    onPoll: () => {
      passes.current += 1
      if (variantObservationExhausted(passes.current, observeStartedAt.current, Date.now())) {
        setCooledDown(true)
        notifyLive({
          id: LIVE_VARIANT_OPEN,
          type: "unknown",
          title: "还有商品的结果没确认",
          description: "自动核实已到观察上限；店铺占用不会因此解除，请人工核实。",
          action: { label: "再核实一次", onClick: requestVerify },
        })
        return
      }
      void readOperation(true)
    },
  })

  async function execute() {
    if (submitting || state.phase !== "ready") return
    const preview = state.data
    // 同一份预览内容的重试复用同一个 operation_id；账本按键重放，不会二次写。
    const [operationId] = operationIdsFor([
      { storeId: preview.storeId, previewDigest: preview.digest, productIds: preview.products.map((item) => item.productId) },
    ])
    if (!operationId) return
    setSubmitting(true)
    try {
      const data = await productVariantsHttp.operate(buildVariantOperationCommand(preview, operationId))
      const items = data.items
      setResult({ operationId: data.operationId ?? operationId, items })
      setCheckedAtMs(data.lastCheckedAtMs ?? null)
      passes.current = 0
      observeStartedAt.current = Date.now()
      setCooledDown(false)
      if (items.length === 0) {
        notifyError("Ozon 没有返回可对账的商品，本次结果未被确认。")
        return
      }
      const counts = variantOperationCounts(items)
      const notice = variantOutcomeNotice(counts)
      if (counts.open > 0) {
        notifyLive({
          id: LIVE_VARIANT_OPEN,
          type: "unknown",
          title: notice,
          description: "已受理不等于已生效；自动核实会继续读到上限。",
          action: { label: "再核实一次", onClick: requestVerify },
        })
      } else {
        clearLive(LIVE_VARIANT_OPEN)
        if (counts.rejected > 0) notifyInfo(notice)
        else notifySuccess(notice)
      }
      onApplied()
    } catch (reason) {
      if (variantRefusalStep(reason) === "repreview") {
        // 摘要过期：真的重新预览（新摘要会自动换新的 operation_id），绝不重试这次写入。
        setResult(null)
        setCheckedAtMs(null)
        notifyError("商品事实在预览后变了，已重新读取预览；请核对后再确认。")
        reload()
      } else {
        notifyCommandError(reason, "同款规格变更没有提交，请稍后重试。")
      }
    } finally {
      setSubmitting(false)
    }
  }

  const ready = state.phase === "ready" ? state.data : null
  const blocked = ready !== null && ready.problems.length > 0
  const executed = result !== null

  return (
    <ConfirmDialog
      open
      size="lg"
      variant="brand"
      title={ACTION_LABEL[action]}
      description={`${storeName || "当前店铺"}：${rows.length} 件商品`}
      confirmText={executed ? "关闭" : "确认执行"}
      cancelText="取消"
      busy={submitting}
      disabled={!executed && (ready === null || blocked || request === null)}
      onConfirm={executed ? onClose : () => void execute()}
      onCancel={onClose}
      showCloseButton={!executed}
    >
      <div className="flex max-h-96 flex-col gap-3 overflow-y-auto pr-1">
        <p className="text-xs text-muted-foreground">{VARIANT_ACTION_NOTE[variantAction]}</p>
        {/* 合并/拆出没有既有目标；移入只提供可核实的型号 ID。 */}
        {variantAction === "move" ? (
          <VariantTargetPicker
            modelId={targetModelId}
            targets={candidates}
            onModelId={setTargetModelId}
          />
        ) : null}
        {request === null ? (
          <p className="text-xs text-muted-foreground">先选好目标同款，再读取预览。</p>
        ) : (
          <VariantPreviewPane state={state} onRetry={reload} />
        )}
        {result ? (
          <VariantOperationResults
            items={result.items}
            checkedLabel={variantCheckedLabel(checkedAtMs)}
            verifying={verifying}
            onVerify={requestVerify}
          />
        ) : null}
      </div>
    </ConfirmDialog>
  )
}

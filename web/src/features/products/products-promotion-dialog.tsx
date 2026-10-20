/**
 * 店铺商品表「促销活动」：读出所选商品可参加的 Ozon 活动，按统一折扣率
 * 加入（每件按自身售价计算并夹在活动上限内）或整体退出。
 */
import { useEffect, useMemo, useState } from "react"

import { opsHttp } from "@/bindings/http-ops"
import type {
  ProductMutationRequest,
  ProductPromotionActionView,
  ProductPromotionOfferView,
} from "@/bindings/commands"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Tabs, TabsIndicator, TabsList, TabsTrigger } from "@/components/ui/tabs"
import {
  PROMOTION_EXITABLE_TYPES,
  buildPromotionJoinMutation,
  buildPromotionLeaveMutation,
  promotionFrozen,
  shortDate,
} from "@/features/products/product-list-model"
import { notifyCommandError } from "@/lib/notify"

import type { StoreProductRow } from "./products-api"
import { dispatchChunks, reportOutcome, useOperationIds } from "./products-dispatch"
import { PROMOTION_MUTATION_LIMIT, chunkRows, parseDiscountPercent } from "./products-mutation"

type PromotionMode = "join" | "leave"

export function ProductPromotionDialog({
  open,
  rows,
  storeName,
  onClose,
  onApplied,
}: {
  open: boolean
  rows: StoreProductRow[]
  storeName: string
  onClose: () => void
  onApplied: () => void
}) {
  const [actions, setActions] = useState<ProductPromotionActionView[]>([])
  const [offers, setOffers] = useState<ProductPromotionOfferView[]>([])
  const [loading, setLoading] = useState(false)
  const [actionId, setActionId] = useState("")
  const [mode, setMode] = useState<PromotionMode>("join")
  const [percentInput, setPercentInput] = useState("")
  const [mutating, setMutating] = useState(false)
  const operationIdsFor = useOperationIds(open)
  const storeId = rows[0]?.store_id ?? ""
  const percent = parseDiscountPercent(percentInput)

  useEffect(() => {
    if (!open || !storeId || rows.length === 0) return
    let cancelled = false
    setLoading(true)
    setActions([])
    setOffers([])
    setActionId("")
    setMode("join")
    setPercentInput("")
    void opsHttp
      .productsListPromotions({ store_id: storeId, product_ids: rows.map((row) => row.product_id) })
      .then((view) => {
        if (cancelled) return
        setActions(view.actions)
        setOffers(view.offers)
        setActionId(String(view.actions[0]?.action_id ?? ""))
      })
      .catch((reason) => {
        if (!cancelled) notifyCommandError(reason, "无法读取 Ozon 促销活动，请稍后重试。")
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [open, storeId, rows])

  const action = actions.find((item) => String(item.action_id) === actionId) ?? null
  const actionOffers = useMemo(
    () => offers.filter((offer) => String(offer.action_id) === actionId),
    [offers, actionId],
  )
  const isFrozen = action !== null && promotionFrozen(action.freeze_date)
  const participating = actionOffers.filter((offer) => offer.participating).length
  // The server routes Leave by the promotion's type and refuses what the API
  // cannot exit; hiding the tab for those types keeps the refusal from being
  // the first thing an operator learns.
  const exitable = action !== null && PROMOTION_EXITABLE_TYPES.includes(action.action_type)
  // A type that cannot leave must not keep the dialog stuck on the leave tab.
  const effectiveMode: PromotionMode = mode === "leave" && !exitable ? "join" : mode
  const valid =
    action !== null &&
    (effectiveMode === "leave"
      ? participating > 0 && !isFrozen && exitable
      : percent !== null && actionOffers.length > 0)

  function buildRequests(): ProductMutationRequest[] {
    const id = Number(actionId)
    return chunkRows(actionOffers, PROMOTION_MUTATION_LIMIT).map((chunk) =>
      effectiveMode === "leave"
        ? buildPromotionLeaveMutation(id, action?.action_type ?? "", chunk)
        : buildPromotionJoinMutation(id, chunk, rows, (offer) => {
            const target = offer.price * (1 - (percent ?? 0) / 100)
            return offer.max_action_price > 0 ? Math.min(target, offer.max_action_price) : target
          }),
    )
  }

  async function submit() {
    if (!storeId || !valid) return
    let requests: ProductMutationRequest[]
    try {
      requests = buildRequests()
    } catch (reason) {
      notifyCommandError(reason, "操作参数无效，请检查填写内容后重试。")
      return
    }
    setMutating(true)
    try {
      const { items, failure } = await dispatchChunks(storeId, requests, operationIdsFor(requests))
      if (items.length > 0) {
        reportOutcome(items, (count) =>
          effectiveMode === "leave"
            ? `已让 ${count} 件商品退出活动`
            : `已将 ${count} 件商品加入活动`,
        )
        onApplied()
      }
      if (failure !== undefined) {
        notifyCommandError(failure, "部分分块未提交；已提交的分块不会重复写入，请稍后重试。")
        return
      }
      onClose()
    } catch (reason) {
      notifyCommandError(reason, "Ozon 促销写入失败，未确认的结果请先检查后再重试。")
    } finally {
      setMutating(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={(next) => !next && !mutating && onClose()}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>促销活动</DialogTitle>
          <DialogDescription>
            {storeName} 中已选 {rows.length} 件商品可参加的 Ozon 活动。
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-3">
          <label className="grid gap-1.5 text-compact">
            <span className="font-medium">活动</span>
            <Select
              disabled={loading || actions.length === 0}
              value={actionId}
              onValueChange={(value) => value && setActionId(value)}
            >
              <SelectTrigger aria-label="选择活动">
                <SelectValue>
                  {() => {
                    if (loading) return "正在读取活动…"
                    if (actions.length === 0) return "没有可参加的活动"
                    return action?.title ?? "选择活动"
                  }}
                </SelectValue>
              </SelectTrigger>
              <SelectContent>
                {actions.map((item) => (
                  <SelectItem key={item.action_id} value={String(item.action_id)}>
                    {item.title}
                    <span className="text-muted-foreground">
                      {shortDate(item.date_start)}–{shortDate(item.date_end)} · 已参加{" "}
                      {item.participating_selected}/{item.eligible_selected}
                    </span>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </label>
          {action ? (
            <p className="text-xs text-muted-foreground">
              已选商品中 {actionOffers.length} 件可参加，{participating} 件已在活动中
              {isFrozen ? "。活动已冻结：不能退出，也不能提高活动价" : ""}。
            </p>
          ) : null}
          <Tabs
            value={effectiveMode}
            onValueChange={(next) => {
              // 最后防线开关位（README 降级预案引用）：若写路径需要紧急停用
              // 促销 Join/Leave，把这里的 setMode 换成恒等 join 并禁用两个
              // TabsTrigger，服务端仍是裁决者。
              setMode(next as PromotionMode)
            }}
          >
            <TabsList aria-label="活动操作" className="h-8 w-fit">
              <TabsIndicator />
              <TabsTrigger value="join" className="h-7 w-28">加入 / 调整活动价</TabsTrigger>
              <TabsTrigger value="leave" className="h-7 w-28" disabled={!exitable}>
                退出活动
              </TabsTrigger>
            </TabsList>
          </Tabs>
          {effectiveMode === "join" ? (
            <label className="grid gap-1.5 text-compact">
              <span className="font-medium">相对售价的折扣率（%）</span>
              <Input
                type="number"
                min={0}
                max={99}
                step={0.1}
                value={percentInput}
                aria-invalid={(percentInput.trim() !== "" && percent === null) || undefined}
                onChange={(event) => setPercentInput(event.target.value)}
              />
              <small className="text-muted-foreground">
                每件按自身售价打折；超出 Ozon 给该商品的活动价上限时自动取上限。
              </small>
            </label>
          ) : null}
        </div>
        <DialogFooter>
          <Button variant="outline" disabled={mutating} onClick={onClose}>
            取消
          </Button>
          <Button disabled={mutating || !valid} onClick={() => void submit()}>
            {mutating ? "正在提交…" : effectiveMode === "leave" ? "退出活动" : "确认加入"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/**
 * 派发包详情和拒单。从排单屏拆出，避免队列文件继续变长。
 * 生产中到已发货由物流信息自动迁，这里不手填快递单号。
 * 动作是否可用只看服务端下发的 actions。失败只走 toast。
 */
import { useCallback, useState } from "react"
import { Download, Image } from "lucide-react"

import {
  acceptSupplierDispatch,
  rejectSupplierDispatch,
  downloadSupplierAsset,
  supplierAssetUrl,
  type SupplierDispatchDetail,
} from "@/bindings/http-supplier-portal"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field"
import { Spinner } from "@/components/ui/spinner"
import { Textarea } from "@/components/ui/textarea"
import { notifyCommandError, notifyError, notifySuccess } from "@/lib/notify"

import { payoutLabel } from "./supplier-money"
import { countdownLabel, useNow, useReducedMotion } from "./supplier-urgency"

export function DispatchDetailDialog({
  open,
  detail,
  busy,
  onOpenChange,
  onAction,
}: {
  open: boolean
  detail?: SupplierDispatchDetail
  busy: boolean
  onOpenChange: (open: boolean) => void
  onAction: () => Promise<void>
}) {
  const [actionBusy, setActionBusy] = useState(false)
  const [rejectOpen, setRejectOpen] = useState(false)
  const reducedMotion = useReducedMotion()
  const now = useNow(reducedMotion)

  const run = useCallback(
    async (action: () => Promise<unknown>, success: string) => {
      setActionBusy(true)
      try {
        await action()
        notifySuccess(success)
        await onAction()
      } catch (reason) {
        notifyCommandError(reason, "操作失败，请稍后重试。")
      } finally {
        setActionBusy(false)
      }
    },
    [onAction],
  )

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[85svh] flex-col overflow-hidden sm:max-w-lg">
        <DialogHeader className="shrink-0">
          <DialogTitle>
            <span className="flex min-w-0 items-center gap-2">
              <span className="min-w-0 truncate">
                {detail ? productTitle(detail) : "订单详情"}
              </span>
              {detail ? (
                <Badge variant={stateVariant(detail.state)}>
                  {stateLabel(detail.state)}
                </Badge>
              ) : null}
            </span>
          </DialogTitle>
          <DialogDescription>
            {busy || !detail ? "正在读取…" : dialogSummary(detail, now)}
          </DialogDescription>
        </DialogHeader>
        {detail ? (
          <div className="flex min-h-0 flex-col gap-4 overflow-y-auto">
            <ProductionSection detail={detail} />
            <FactSheet detail={detail} />
          </div>
        ) : null}
        <DialogFooter className="shrink-0">
          {detail?.actions.can_accept ? (
            <Button
              type="button"
              disabled={actionBusy}
              onClick={() =>
                void run(
                  () => acceptSupplierDispatch(detail.dispatch_id),
                  "接好了，开始做",
                )
              }
            >
              {actionBusy ? <Spinner data-icon="inline-start" /> : null}
              接单
            </Button>
          ) : null}
          {detail?.actions.can_reject ? (
            <Button
              type="button"
              variant="outline"
              disabled={actionBusy}
              onClick={() => setRejectOpen(true)}
            >
              拒绝
            </Button>
          ) : null}
          {detail?.state === "accepted" ? (
            <p className="text-meta text-muted-foreground">
              物流到了会自动变成已发货。
            </p>
          ) : null}
        </DialogFooter>
        {detail ? (
          <RejectDialog
            open={rejectOpen}
            busy={actionBusy}
            onOpenChange={setRejectOpen}
            onConfirm={(reason) =>
              run(
                () => rejectSupplierDispatch(detail.dispatch_id, reason),
                "已拒绝，这单退回去了",
              ).then(() => setRejectOpen(false))
            }
          />
        ) : null}
      </DialogContent>
    </Dialog>
  )
}

function productTitle(detail: SupplierDispatchDetail): string {
  const [first] = detail.lines
  if (!first) return "订单"
  const name = first.name || "未命名商品"
  if (detail.lines.length === 1) return `${name} × ${first.quantity}`
  return `${name} 等 ${detail.lines.length} 种`
}

function dialogSummary(detail: SupplierDispatchDetail, now: number): string {
  const parts = [`单号 ${detail.posting_number}`]
  if ((detail.nudge_count ?? 0) > 0) parts.push("对方在催")
  const remaining = countdownLabel(detail.deadline, now)
  if (remaining === "超时") parts.push("超时")
  else if (remaining) parts.push(`还剩 ${remaining}`)
  return parts.join(" · ")
}

function stateVariant(
  state: string,
): "outline" | "brand" | "good" | "destructive" {
  if (state === "accepted") return "brand"
  if (state === "shipped") return "good"
  if (state === "rejected" || state === "cancelled") return "destructive"
  return "outline"
}

const PREVIEWABLE = new Set(["image/jpeg", "image/png", "image/webp"])

function ProductionSection({ detail }: { detail: SupplierDispatchDetail }) {
  const assets = detail.lines.flatMap((line) => line.assets)
  return (
    <section className="flex flex-col gap-3">
      <h3 className="text-meta font-medium text-muted-foreground">生产图</h3>
      {assets.length === 0 ? (
        <div className="flex h-56 flex-col items-center justify-center gap-2 rounded-lg border border-border bg-muted text-muted-foreground">
          <Image aria-hidden />
          <p className="text-meta">这单还没有生产图</p>
        </div>
      ) : (
        <ul className="flex flex-col gap-3">
          {assets.map((asset) => {
            const name = downloadName(asset.file_name, asset.mime)
            const url = supplierAssetUrl(detail.dispatch_id, asset.asset_id)
            return (
              <li key={asset.asset_id} className="flex flex-col gap-2">
                {PREVIEWABLE.has(asset.mime) ? (
                  <ProductionImage url={url} name={name} />
                ) : (
                  <p className="truncate text-compact">{name}</p>
                )}
                <div className="flex items-center justify-between gap-3">
                  <span className="min-w-0 truncate text-meta text-muted-foreground">
                    {name}
                  </span>
                  <Button
                    variant="outline"
                    nativeButton={false}
                    render={
                      <a
                        href={url}
                        download={name}
                        onClick={(event) => {
                          if (
                            event.button !== 0
                            || event.metaKey
                            || event.ctrlKey
                            || event.shiftKey
                            || event.altKey
                          ) {
                            return
                          }
                          event.preventDefault()
                          void downloadSupplierAsset(
                            detail.dispatch_id,
                            asset.asset_id,
                          ).catch((reason) => {
                            notifyCommandError(reason, "素材下载失败，请稍后重试。")
                          })
                        }}
                      />
                    }
                    aria-label={`下载${name}`}
                  >
                    <Download data-icon="inline-start" />
                    下载生产图
                  </Button>
                </div>
              </li>
            )
          })}
        </ul>
      )}
    </section>
  )
}

function ProductionImage({ url, name }: { url: string; name: string }) {
  const [failed, setFailed] = useState(false)
  if (failed) {
    return (
      <div className="flex h-56 items-center justify-center rounded-lg border border-border bg-muted px-3 text-center text-meta text-muted-foreground">
        图片暂时打不开，可以直接下载
      </div>
    )
  }
  return (
    <img
      src={url}
      alt={name}
      className="max-h-56 w-full rounded-lg border border-border bg-muted object-contain"
      onError={() => setFailed(true)}
    />
  )
}

function downloadName(fileName: string, mime: string): string {
  const name = fileName.trim() || "生产图"
  if (name.includes(".")) return name
  const extension =
    mime === "image/png"
      ? ".png"
      : mime === "image/jpeg"
        ? ".jpg"
        : mime === "image/webp"
          ? ".webp"
          : mime === "application/pdf"
            ? ".pdf"
            : ""
  return name + extension
}

function RejectDialog({
  open,
  busy,
  onOpenChange,
  onConfirm,
}: {
  open: boolean
  busy: boolean
  onOpenChange: (open: boolean) => void
  onConfirm: (reason: string) => void
}) {
  const [reason, setReason] = useState("")
  const [invalid, setInvalid] = useState(false)
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>拒绝这单</DialogTitle>
          <DialogDescription>
            拒绝后这单会退回去，对方能看到原因。
          </DialogDescription>
        </DialogHeader>
        <FieldGroup>
          <Field data-invalid={invalid || undefined}>
            <FieldLabel htmlFor="supplier-reject-reason">原因</FieldLabel>
            <Textarea
              id="supplier-reject-reason"
              value={reason}
              aria-invalid={invalid}
              onChange={(event) => setReason(event.target.value)}
            />
          </Field>
        </FieldGroup>
        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            disabled={busy}
            onClick={() => onOpenChange(false)}
          >
            取消
          </Button>
          <Button
            type="button"
            variant="destructive"
            disabled={busy}
            onClick={() => {
              if (reason.trim() === "") {
                setInvalid(true)
                notifyError("请填写原因")
                return
              }
              onConfirm(reason.trim())
            }}
          >
            确认拒绝
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function FactSheet({ detail }: { detail: SupplierDispatchDetail }) {
  const rows: Array<{ key: string; label: string; value: string }> = []
  for (const line of detail.lines) {
    rows.push({
      key: line.offer_id,
      label: "商品",
      value: `${line.name || "未命名商品"} × ${line.quantity}`,
    })
  }
  rows.push({
    key: "payout",
    label: "订单价格",
    value: payoutLabel(detail) ?? "还没有",
  })
  const logistics = detail.logistics
  if (logistics) {
    const entries: Array<[string, string | undefined]> = [
      ["仓库", logistics.warehouse ?? undefined],
      ["怎么送", logistics.delivery_method ?? undefined],
      ["快递", logistics.tpl_provider ?? undefined],
      ["城市", logistics.city ?? undefined],
      ["地区", logistics.region ?? undefined],
      ["什么时候到", joinWindow(logistics.delivery_date_begin, logistics.delivery_date_end)],
      ["最晚发出", plainTime(logistics.shipment_date)],
    ]
    for (const [label, value] of entries) {
      if (value) rows.push({ key: label, label, value })
    }
  }
  if (detail.seller_note) {
    rows.push({ key: "note", label: "备注", value: detail.seller_note })
  }
  if (detail.receipt?.tracking_no) {
    rows.push({
      key: "tracking",
      label: "快递单号",
      value: detail.receipt.tracking_no,
    })
  } else if (detail.receipt?.reason) {
    rows.push({ key: "reason", label: "原因", value: detail.receipt.reason })
  }
  return (
    <dl className="overflow-hidden rounded-lg border border-border">
      {rows.map((row) => (
        <div
          key={row.key}
          className="flex items-start justify-between gap-3 border-b border-border px-3 py-2 last:border-b-0"
        >
          <dt className="shrink-0 text-meta text-muted-foreground">{row.label}</dt>
          <dd className="min-w-0 text-right text-compact wrap-anywhere">{row.value}</dd>
        </div>
      ))}
    </dl>
  )
}

function plainTime(value?: string | null): string | undefined {
  if (!value) return undefined
  const parsed = Date.parse(value)
  if (Number.isNaN(parsed)) return value
  return new Date(parsed).toLocaleString("zh-CN", {
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  })
}

function joinWindow(
  begin?: string | null,
  end?: string | null,
): string | undefined {
  const left = plainTime(begin)
  const right = plainTime(end)
  if (left && right) return `${left} ~ ${right}`
  return left ?? right
}

function stateLabel(state: string): string {
  if (state === "dispatched") return "待接单"
  if (state === "accepted") return "生产中"
  if (state === "shipped") return "已发货"
  if (state === "rejected") return "已拒绝"
  if (state === "cancelled") return "已取消"
  return state
}

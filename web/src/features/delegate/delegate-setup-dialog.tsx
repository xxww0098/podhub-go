/**
 * 补齐流（`needs_setup` 行）：逐行选厂家 + 上传原图 + 随单备注，全部
 * 就绪后建单。
 *
 * 绑定是晋升的唯一触发点：这里每行的「上传并就绪」先确保绑定
 * 指向所选厂家（新建或 CAS 改绑），再走 presign → 中转 PUT → 落行 三步。
 * 建单本身发生在最后一步 `POST /orders`，列表读绝不建单。`partial` 行从
 * 在途单里取已覆盖的 offer 集，只把剩余行送进建单（未选定行永不进单）。
 */
import { useCallback, useEffect, useRef, useState } from "react"
import { UploadCloud } from "lucide-react"

import type {
  DelegateBinding,
  DelegatePosting,
  DelegateSource,
} from "./delegate-http"
import { delegateHttp } from "./delegate-http"
import {
  ASSET_ACCEPT,
  assetFileError,
  normalizedOfferId,
  newIdempotencyKey,
} from "./delegate-model"
import { uploadDelegateAsset } from "./delegate-upload"
import { StateChip } from "@/components/state-chip"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Label } from "@/components/ui/label"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Spinner } from "@/components/ui/spinner"
import { Textarea } from "@/components/ui/textarea"
import { notifyCommandError, notifyError, notifySuccess } from "@/lib/notify"

type LineStatus = "pending" | "working" | "ready"

type LineSetup = {
  offerId: string
  name: string
  quantity: number
  sku: number
  binding: DelegateBinding | null
  sourceId: string
  status: LineStatus
  /** 已被在途单覆盖的行（`partial` 委托剩余行时），不需要补齐。 */
  covered: boolean
}

export type DelegateSetupDialogProps = {
  posting: DelegatePosting | null
  storeId: string
  sources: DelegateSource[]
  onClose: () => void
  /** 建单成功后回调（外带刷新信号）。 */
  onOrderCreated: (orderId: string) => void
}

export function DelegateSetupDialog({
  posting,
  storeId,
  sources,
  onClose,
  onOrderCreated,
}: DelegateSetupDialogProps) {
  const open = Boolean(posting)
  const [lines, setLines] = useState<LineSetup[]>([])
  const [loading, setLoading] = useState(false)
  const [note, setNote] = useState("")
  const [creating, setCreating] = useState(false)
  const idempotencyKey = useRef(newIdempotencyKey())

  const loadLines = useCallback(async () => {
    if (!posting) return
    setLoading(true)
    try {
      // partial：已覆盖行从在途单读出来，只补剩余行。
      const coveredOffers = new Set<string>()
      if (posting.delegate_state === "partial" && posting.order_id) {
        const order = await delegateHttp.getOrder(posting.order_id)
        for (const line of order.lines) {
          coveredOffers.add(normalizedOfferId(line.offer_id))
        }
      }
      const bindings = await delegateHttp.listBindings(storeId)
      const byOffer = new Map(
        bindings.map((binding) => [normalizedOfferId(binding.offer_id), binding]),
      )
      const seen = new Set<string>()
      const next: LineSetup[] = []
      for (const product of posting.products) {
        const offerId = normalizedOfferId(product.offer_id)
        if (!offerId || seen.has(offerId)) continue
        seen.add(offerId)
        const binding = byOffer.get(offerId) ?? null
        const covered = coveredOffers.has(offerId)
        next.push({
          offerId,
          name: product.name,
          quantity: product.quantity,
          sku: product.sku,
          binding,
          sourceId: binding?.source.source_id ?? "",
          status:
            covered ||
            (binding !== null && binding.assets.some((asset) => asset.verified))
              ? "ready"
              : "pending",
          covered,
        })
      }
      setLines(next)
      idempotencyKey.current = newIdempotencyKey()
    } catch (reason) {
      notifyCommandError(reason, "无法读取委托绑定")
      onClose()
    } finally {
      setLoading(false)
    }
  }, [posting, storeId, onClose])

  useEffect(() => {
    if (!open) {
      setLines([])
      setNote("")
      return
    }
    void loadLines()
  }, [open, loadLines])

  const pendingLines = lines.filter((line) => !line.covered)
  const readyCount = pendingLines.filter((line) => line.status === "ready").length
  const allReady = pendingLines.length > 0 && readyCount === pendingLines.length
  const hasCovered = lines.some((line) => line.covered)

  function patchLine(offerId: string, patch: Partial<LineSetup>) {
    setLines((current) =>
      current.map((line) =>
        line.offerId === offerId ? { ...line, ...patch } : line,
      ),
    )
  }

  async function prepareLine(line: LineSetup, file: File) {
    const precheck = assetFileError(file)
    if (precheck) {
      notifyError(precheck)
      return
    }
    patchLine(line.offerId, { status: "working" })
    try {
      let binding = line.binding
      const wanted = line.sourceId
      if (!binding) {
        binding = await delegateHttp.createBinding({
          store_id: storeId,
          offer_id: line.offerId,
          source_id: wanted,
        })
      } else if (binding.source.source_id !== wanted) {
        // 改绑带 CAS；409 说明绑定已被别处更新，重新装载让用户看到现状。
        try {
          binding = await delegateHttp.patchBinding(binding.binding_id, {
            expected_revision: binding.revision,
            source_id: wanted,
          })
        } catch (patchReason) {
          notifyError("绑定已被更新，请刷新后重试", { reason: patchReason })
          throw patchReason
        }
      }
      const asset = await uploadDelegateAsset(
        {
          presign: delegateHttp.presignAsset,
          putObject: delegateHttp.putAssetObject,
          finalize: delegateHttp.finalizeAsset,
        },
        { binding_id: binding.binding_id, file },
      )
      patchLine(line.offerId, {
        binding,
        status: asset.verified ? "ready" : "pending",
      })
      if (!asset.verified) {
        notifyError("原图已上传，服务端核验未通过，请重新上传")
      }
    } catch (reason) {
      patchLine(line.offerId, { status: "pending" })
      notifyCommandError(reason, `「${line.offerId}」原图上传失败`)
    }
  }

  async function createOrder() {
    if (!posting) return
    setCreating(true)
    try {
      // 未被在途单覆盖时省略 offerIds（= 全部行）；委托剩余行只送剩余行。
      const offerIds = hasCovered
        ? pendingLines.map((line) => line.offerId)
        : undefined
      const order = await delegateHttp.createOrder(
        {
          store_id: storeId,
          posting_number: posting.posting_number,
          offer_ids: offerIds,
          seller_note: note.trim() || undefined,
        },
        idempotencyKey.current,
      )
      notifySuccess(
        hasCovered ? `已委托剩余行（共 ${order.lines.length} 行在单）` : "已建委托单",
      )
      onOrderCreated(order.order_id)
      onClose()
    } catch (reason) {
      notifyCommandError(reason, "建单失败")
    } finally {
      setCreating(false)
    }
  }

  const isRest = posting?.delegate_state === "partial"

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose()
      }}
    >
      <DialogContent className="flex max-h-[min(46rem,calc(100dvh-2rem))] flex-col gap-0 overflow-hidden p-0 sm:max-w-2xl">
        <div className="shrink-0 border-b border-border py-3 pr-12 pl-4">
          <DialogHeader>
            <DialogTitle>
              <span className="block font-mono text-sm break-all">
                {posting?.posting_number ?? "补齐并委托"}
              </span>
            </DialogTitle>
            <DialogDescription>
              逐行选厂家并上传原图（jpg/png/webp/psd，单张 ≤500MB）；全部就绪后
              {isRest ? "委托剩余行" : "建单"}。
            </DialogDescription>
          </DialogHeader>
        </div>
        <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto p-4">
          {loading ? (
            <div role="status" aria-live="polite" className="grid min-h-24 place-items-center">
              <Spinner className="size-5" aria-label="正在读取绑定" />
            </div>
          ) : null}
          {lines.map((line) => (
            <SetupLineRow
              key={line.offerId}
              line={line}
              sources={sources}
              onSourceChange={(sourceId) => patchLine(line.offerId, { sourceId })}
              onFile={(file) => void prepareLine(line, file)}
            />
          ))}
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="delegate-setup-note">随单备注（给厂家）</Label>
            <Textarea
              id="delegate-setup-note"
              value={note}
              placeholder="选填；会随派发包发给厂家"
              onChange={(event) => setNote(event.target.value)}
            />
          </div>
        </div>
        <div className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-t border-border px-4 py-3">
          <span className="text-compact text-muted-foreground">
            就绪 {readyCount}/{pendingLines.length} 行
            {hasCovered ? ` · ${lines.length - pendingLines.length} 行已在单` : ""}
          </span>
          <div className="flex items-center gap-2">
            <Button size="sm" variant="outline" onClick={onClose}>
              取消
            </Button>
            <Button
              size="sm"
              variant="brand"
              disabled={!allReady || creating}
              onClick={() => void createOrder()}
            >
              {creating ? <Spinner data-icon="inline-start" /> : null}
              {isRest ? "委托剩余行" : "建单"}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}

function SetupLineRow({
  line,
  sources,
  onSourceChange,
  onFile,
}: {
  line: LineSetup
  sources: DelegateSource[]
  onSourceChange: (sourceId: string) => void
  onFile: (file: File) => void
}) {
  const inputRef = useRef<HTMLInputElement>(null)
  const sourceName =
    sources.find((source) => source.source_id === line.sourceId)?.name ?? ""
  return (
    <div className="flex flex-col gap-2 rounded-xl border border-border p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="min-w-0">
          <p className="break-words text-sm">{line.name || line.offerId}</p>
          <p className="font-mono text-meta break-all text-muted-foreground">
            {line.offerId} × {line.quantity}
          </p>
        </div>
        <SetupLineStatus line={line} />
      </div>
      {line.covered ? null : (
        <div className="flex flex-wrap items-center gap-2">
          <Label className="sr-only" htmlFor={`factory-${line.offerId}`}>
            {`厂家 ${line.offerId}`}
          </Label>
          <Select
            value={line.sourceId}
            onValueChange={(next) => onSourceChange(next ?? "")}
            disabled={line.status === "working"}
          >
            <SelectTrigger
              size="sm"
              className="min-w-44"
              aria-label={`选择厂家 ${line.offerId}`}
              id={`factory-${line.offerId}`}
            >
              <SelectValue>{sourceName || "选择厂家"}</SelectValue>
            </SelectTrigger>
            <SelectContent>
              {sources.map((source) => (
                <SelectItem key={source.source_id} value={source.source_id}>
                  {source.name}
                  {source.country ? ` · ${source.country}` : ""}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <input
            ref={inputRef}
            type="file"
            accept={ASSET_ACCEPT}
            className="sr-only"
            aria-label={`上传原图 ${line.offerId}`}
            onChange={(event) => {
              const file = event.target.files?.[0]
              event.target.value = ""
              if (file) onFile(file)
            }}
          />
          <Button
            size="sm"
            variant="outline"
            disabled={line.status === "working" || !line.sourceId}
            onClick={() => inputRef.current?.click()}
          >
            {line.status === "working" ? (
              <Spinner data-icon="inline-start" />
            ) : (
              <UploadCloud />
            )}
            {line.binding ? "换原图" : "上传原图"}
          </Button>
        </div>
      )}
    </div>
  )
}

function SetupLineStatus({ line }: { line: LineSetup }) {
  if (line.covered) {
    return <StateChip status="delegated" tone="good" label="已在单" />
  }
  switch (line.status) {
    case "ready":
      return <StateChip status="verified" tone="good" label="已就绪" />
    case "working":
      return <StateChip status="flight" tone="flight" label="上传中" />
    default:
      return <StateChip status="idle" tone="idle" label="待补齐" />
  }
}

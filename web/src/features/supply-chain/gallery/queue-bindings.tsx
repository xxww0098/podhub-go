/**
 * 清单行的两笔绑定：目标店铺与 PSD 模板。两笔都只改本机草稿（listing-queue
 * 的模块 store，详情/卡片/浮窗读同一份），不产生写请求——所以控件没有失败面，
 * 只有「改了」；导入时由 screen-catalog 把它们落到新卡上。
 */
import { useState } from "react"
import { Check, Store } from "lucide-react"

import type { OzonStoreView } from "@/bindings/commands"
import { renderOpfs } from "@/bindings/render-opfs"
import { Button } from "@/components/ui/button"
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover"
import { Spinner } from "@/components/ui/spinner"
import { commandErrorCode } from "@/lib/error-message"
import { notifyCommandError } from "@/lib/notify"
import { cn } from "@/lib/utils"

import {
  setQueuedPsd,
  setQueuedStore,
  type ListingQueueEntry,
} from "./listing-queue"

export function QueueBindings({
  entry,
  available,
  stores,
  onOpenStores,
}: {
  entry: ListingQueueEntry
  /** 行还在最新货盘里吗？下架的行不给控件——绑定攒了也落不了卡。 */
  available: boolean
  stores: readonly OzonStoreView[]
  onOpenStores?: () => void
}) {
  if (!available) return null
  return (
    <div
      className="flex flex-wrap items-center gap-1.5"
      data-gallery-queue-bindings={entry.productId}
    >
      <QueueStoreBinding
        entry={entry}
        stores={stores}
        onOpenStores={onOpenStores}
      />
      <QueuePsdBinding entry={entry} />
    </div>
  )
}

/** 两个绑定触发钮共享的骨架：虚线待绑 / 品牌底已绑。 */
function bindingTriggerClass(bound: boolean): string {
  return cn(
    "inline-flex h-6 max-w-40 cursor-pointer items-center gap-1 rounded-md text-meta outline-none transition-colors focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-ring",
    bound
      ? "border border-brand/25 bg-brand-soft px-1.5 text-brand-ink"
      : "border border-dashed border-border-strong px-2 text-muted-foreground hover:border-brand/50 hover:text-foreground",
  )
}

/** Popover 里的单行动作/单选项——和触发钮一样是裸按钮，不套基础组件的壳。 */
const bindingItemClass =
  "flex w-full cursor-pointer items-center gap-1.5 rounded-md px-1.5 py-1 text-left text-compact text-foreground outline-none transition-colors hover:bg-muted focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-ring disabled:cursor-not-allowed disabled:opacity-45"

function BindingCheck({ checked }: { checked: boolean }) {
  return (
    <Check
      aria-hidden
      className={cn("size-3.5 shrink-0", checked ? "text-brand" : "opacity-0")}
    />
  )
}

/** 目标店铺触发钮 + 浮层；列表本体在 QueueStoreOptions（浮层走 portal，SSR 读不到）。 */
function QueueStoreBinding({
  entry,
  stores,
  onOpenStores,
}: {
  entry: ListingQueueEntry
  stores: readonly OzonStoreView[]
  onOpenStores?: () => void
}) {
  const [open, setOpen] = useState(false)
  const storeId = entry.storeId ?? ""
  const bound = Boolean(storeId)
  // 店铺被移除/停用也要看得见这笔绑定存在：徽标退回落原始 id。
  const label = stores.find((candidate) => candidate.id === storeId)?.label ?? storeId

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={
          <button
            type="button"
            data-gallery-queue-store=""
            aria-label={bound ? `目标店铺：${label}` : `绑定店铺 ${entry.title}`}
            className={bindingTriggerClass(bound)}
          >
            <Store aria-hidden className="size-3 shrink-0" />
            <span className="truncate">{bound ? label : "绑定店铺"}</span>
          </button>
        }
      />
      <PopoverContent
        side="right"
        align="start"
        sideOffset={4}
        aria-label="绑定店铺"
        className="w-56 p-1"
      >
        <QueueStoreOptions
          entry={entry}
          stores={stores}
          onOpenStores={onOpenStores}
          onPicked={() => setOpen(false)}
        />
      </PopoverContent>
    </Popover>
  )
}

/**
 * 目标店铺单选：「不绑定」+ 工作区可用店铺。选一下就写回清单条目（模块 store
 * 同步到卡片/详情/浮窗）；没有可用店铺时换成「去店铺页添加」的引导。
 */
export function QueueStoreOptions({
  entry,
  stores,
  onOpenStores,
  onPicked,
}: {
  entry: ListingQueueEntry
  stores: readonly OzonStoreView[]
  onOpenStores?: () => void
  /** 选完（含清除）收起浮层；引导出口先用它关掉自己再换屏。 */
  onPicked?: () => void
}) {
  const storeId = entry.storeId ?? ""
  const bound = Boolean(storeId)

  if (!stores.length) {
    return (
      <div className="flex flex-col items-center gap-2 px-2 py-3 text-center">
        <p className="text-meta text-muted-foreground">
          还没有可用店铺，先去「店铺」添加并授权。
        </p>
        {onOpenStores ? (
          <Button
            type="button"
            size="xs"
            variant="outline"
            onClick={() => {
              onPicked?.()
              onOpenStores()
            }}
          >
            去店铺页添加
          </Button>
        ) : null}
      </div>
    )
  }

  return (
    <div role="radiogroup" aria-label="目标店铺" className="flex flex-col">
      <button
        type="button"
        role="radio"
        aria-checked={!bound}
        className={bindingItemClass}
        onClick={() => {
          setQueuedStore(entry.productId, "")
          onPicked?.()
        }}
      >
        <BindingCheck checked={!bound} />
        不绑定
      </button>
      {stores.map((candidate) => (
        <button
          key={candidate.id}
          type="button"
          role="radio"
          aria-checked={storeId === candidate.id}
          className={bindingItemClass}
          onClick={() => {
            setQueuedStore(entry.productId, candidate.id)
            onPicked?.()
          }}
        >
          <BindingCheck checked={storeId === candidate.id} />
          <span className="truncate">{candidate.label}</span>
        </button>
      ))}
    </div>
  )
}

/** PSD 模板触发钮 + 浮层；两个动作在 QueuePsdOptions（浮层走 portal，SSR 读不到）。 */
function QueuePsdBinding({ entry }: { entry: ListingQueueEntry }) {
  const [open, setOpen] = useState(false)
  const [picking, setPicking] = useState(false)
  const psd = entry.psd

  async function pickTemplate() {
    if (picking) return
    setOpen(false)
    setPicking(true)
    try {
      const picked = await renderOpfs.workflowPickTemplatePsd()
      // asset_id 就是摘要，也是卡片的 psdTemplateSha256——原样攒进清单。
      setQueuedPsd(entry.productId, {
        sha256: picked.asset_id,
        fileName: picked.asset.file_name,
      })
    } catch (reason) {
      // 取消选文件不是失败：绑定保持原样，也不弹提示。
      if (commandErrorCode(reason) !== "workflow_template_cancelled") {
        notifyCommandError(reason, "无法保存 PSD 模板，请稍后重试。")
      }
    } finally {
      setPicking(false)
    }
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={
          <button
            type="button"
            data-gallery-queue-psd=""
            aria-label={psd ? `PSD 模板：${psd.fileName}` : `绑定 PSD ${entry.title}`}
            className={bindingTriggerClass(Boolean(psd))}
          >
            {psd ? (
              <span className="truncate font-mono">{psd.fileName || "未命名模板"}</span>
            ) : (
              "绑定 PSD"
            )}
            {picking ? <Spinner className="size-3 shrink-0" aria-hidden /> : null}
          </button>
        }
      />
      <PopoverContent
        side="right"
        align="start"
        sideOffset={4}
        aria-label="绑定 PSD 模板"
        className="w-60 p-1"
      >
        <QueuePsdOptions
          entry={entry}
          picking={picking}
          onPick={() => void pickTemplate()}
          onCleared={() => setOpen(false)}
        />
      </PopoverContent>
    </Popover>
  )
}

/**
 * PSD 浮层的两个动作：选本机模板文件（异步，由触发钮接 renderOpfs），
 * 或恢复商库默认（就地清除覆盖；没绑过就置灰）。
 */
export function QueuePsdOptions({
  entry,
  picking = false,
  onPick,
  onCleared,
}: {
  entry: ListingQueueEntry
  picking?: boolean
  onPick: () => void
  /** 清除后收起浮层。 */
  onCleared?: () => void
}) {
  return (
    <>
      <button
        type="button"
        className={bindingItemClass}
        disabled={picking}
        onClick={onPick}
      >
        选择 PSD 模板…
      </button>
      <button
        type="button"
        className={bindingItemClass}
        disabled={!entry.psd}
        onClick={() => {
          setQueuedPsd(entry.productId, null)
          onCleared?.()
        }}
      >
        恢复商库默认（清除）
      </button>
    </>
  )
}

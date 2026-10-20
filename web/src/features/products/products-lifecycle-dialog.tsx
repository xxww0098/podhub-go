/** 店铺商品表的归档 / 恢复 / 删除确认：同一套分块派发，按各自上限拆块。 */
import { useState } from "react"

import { ConfirmDialog } from "@/components/ui/confirm-dialog"
import { notifyCommandError } from "@/lib/notify"

import type { StoreProductRow } from "./products-api"
import { dispatchChunks, reportOutcome, useOperationIds } from "./products-dispatch"
import { buildLifecycleMutations } from "./products-mutation"

export type LifecycleAction = "archive" | "unarchive" | "delete"

const COPY: Record<LifecycleAction, { title: string; verb: string; note: string }> = {
  archive: {
    title: "归档商品",
    verb: "归档",
    note: "归档后商品退出在售；库存和预留必须已经是 0。",
  },
  unarchive: {
    title: "恢复商品",
    verb: "恢复",
    note: "恢复后商品回到在售流程。Ozon 对自动归档的商品设有每日恢复数量限制。",
  },
  delete: {
    title: "删除商品",
    verb: "删除",
    note: "删除不可撤销：商品会从 Ozon 后台彻底移除，只适用于已归档且从未生成 SKU 的商品。",
  },
}

export function ProductLifecycleDialog({
  action,
  rows,
  storeName,
  onClose,
  onApplied,
}: {
  action: LifecycleAction | null
  rows: StoreProductRow[]
  storeName: string
  onClose: () => void
  /** 成功项的回执 identity（归档/恢复为 product_id，删除为 offer_id）。 */
  onApplied: (action: LifecycleAction, succeeded: Set<string>) => void
}) {
  const [mutating, setMutating] = useState(false)
  const operationIdsFor = useOperationIds(action)
  const copy = action ? COPY[action] : COPY.archive
  const subject =
    rows.length === 1 ? `「${rows[0]?.name ?? rows[0]?.offer_id ?? ""}」` : `${rows.length} 件商品`

  async function confirm() {
    const storeId = rows[0]?.store_id
    if (!action || !storeId || mutating) return
    const requests = buildLifecycleMutations(action, rows)
    setMutating(true)
    try {
      const { items, failure } = await dispatchChunks(storeId, requests, operationIdsFor(requests))
      if (items.length > 0) {
        const succeeded = reportOutcome(items, (count) => `已${copy.verb} ${count} 件商品`)
        onApplied(action, new Set(succeeded))
      }
      if (failure !== undefined) {
        notifyCommandError(failure, `部分商品未${copy.verb}；已提交的不会重复写入，请稍后重试。`)
        return
      }
      onClose()
    } catch (reason) {
      notifyCommandError(reason, `${copy.verb}失败，请稍后重试。`)
    } finally {
      setMutating(false)
    }
  }

  return (
    <ConfirmDialog
      open={action !== null}
      onOpenChange={(open) => !open && !mutating && onClose()}
      title={copy.title}
      description={`${storeName}：将${copy.verb}${subject}。${copy.note}`}
      confirmText={copy.verb}
      variant={action === "delete" ? "destructive" : "default"}
      busy={mutating}
      onConfirm={confirm}
    />
  )
}

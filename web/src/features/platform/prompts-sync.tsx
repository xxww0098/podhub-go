/**
 * 「平台 → 提示词」页的「按类目提示词同步」交互：一次人工触发的批量收口。
 *
 * 从页面里拆出来有两个原因：提示词页已经接近单文件行数上限，而且这些纯函数
 * 是同步结果唯一的展示口径，可以直接测。请求级失败只走 notifyCommandError，
 * 页面里不渲染 errorMessage 原文；结果明细是这次操作的业务数据，可以列出。
 */
import { useState } from "react"

import {
  supplierDbsHttp,
  type SupplierPromptSync,
  type SupplierPromptSyncCounts,
  type SupplierPromptSyncMissReason,
} from "@/bindings/http-supplier-dbs"
import { Button } from "@/components/ui/button"
import { notifyCommandError, notifyError, notifySuccess } from "@/lib/notify"
import { cn } from "@/lib/utils"

/** 结果面板每类最多展示多少条明细。 */
const SYNC_DETAILS_SHOWN = 20

type SyncGroup = {
  key: "updated" | "upToDate" | "unmatched" | "failed"
  title: string
  count: number
  tone: "good" | "muted" | "unknown" | "bad"
  entries: {
    productId: string
    productTitle: string
    promptFileName: string
    note?: string
  }[]
}

const SYNC_TONE_CLASS: Record<SyncGroup["tone"], string> = {
  good: "text-st-good",
  muted: "text-faint-foreground",
  unknown: "text-st-unknown",
  bad: "text-st-bad",
}

export function syncMissReasonLabel(reason: SupplierPromptSyncMissReason): string {
  return reason === "ambiguous" ? "类目里同名文件有多条" : "类目里没有这个文件名"
}

/** 计数是完整总量，明细只展示服务端已返回且前端可见的部分。 */
export function syncUnlistedCount(count: number, entries: readonly unknown[]): number {
  return Math.max(0, count - Math.min(SYNC_DETAILS_SHOWN, entries.length))
}

/** 一句话计数摘要，用于结果通知与面板副标题。 */
export function syncCountsText(counts: SupplierPromptSyncCounts): string {
  return `更新 ${counts.updated}；已是最新 ${counts.upToDate}；无匹配 ${counts.unmatched}；失败 ${counts.failed}`
}

/** 四类明细的展示分组；计数取服务端的精确值，明细只是它的前若干条。 */
export function syncResultGroups(report: SupplierPromptSync): SyncGroup[] {
  const entry = (item: { productId: string; productTitle: string; promptFileName: string }) => ({
    productId: item.productId,
    productTitle: item.productTitle,
    promptFileName: item.promptFileName,
  })
  return [
    {
      key: "updated",
      title: "已更新",
      count: report.counts.updated,
      tone: "good",
      entries: report.updated.map(entry),
    },
    {
      key: "upToDate",
      title: "已是最新",
      count: report.counts.upToDate,
      tone: "muted",
      entries: report.upToDate.map(entry),
    },
    {
      key: "unmatched",
      title: "无匹配",
      count: report.counts.unmatched,
      tone: "unknown",
      entries: report.unmatched.map((item) => ({
        ...entry(item),
        note: syncMissReasonLabel(item.reason),
      })),
    },
    {
      key: "failed",
      title: "失败",
      count: report.counts.failed,
      tone: "bad",
      entries: report.failed.map((item) => ({ ...entry(item), note: item.reason })),
    },
  ]
}

/**
 * 触发一次同步并把四类结果留在页面上：
 * - 请求在途时按钮转菊花并禁用，避免重复提交；
 * - 只要有一件失败就走 notifyError，其余走 notifySuccess；
 * - 请求本身失败走 notifyCommandError，按钮恢复可用即可重试；
 * - onSynced 让宿主页面重读供应商副本列表。
 */
export function useCategoryPromptSync(onSynced: () => void) {
  const [report, setReport] = useState<SupplierPromptSync>()
  const [syncing, setSyncing] = useState(false)

  async function run() {
    if (syncing) return
    setReport(undefined)
    setSyncing(true)
    try {
      const result = await supplierDbsHttp.supplierPromptsSync()
      setReport(result)
      onSynced()
      if (result.counts.failed > 0) {
        notifyError("部分供应商副本同步失败", { description: syncCountsText(result.counts) })
      } else {
        notifySuccess("已按类目提示词同步", { description: syncCountsText(result.counts) })
      }
    } catch (reason) {
      notifyCommandError(reason, "无法按类目提示词同步供应商副本。")
    } finally {
      setSyncing(false)
    }
  }

  return {
    report,
    syncing,
    run,
    dismiss: () => setReport(undefined),
  }
}

/** 结果面板：四类计数 + 有界明细。收起只是隐藏本次结果，不影响已落库的数据。 */
export function SyncReportPanel({
  report,
  onDismiss,
}: {
  report: SupplierPromptSync
  onDismiss: () => void
}) {
  return (
    <section aria-label="按类目提示词同步结果" className="border-b border-border px-4 py-3">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <h2 className="text-sm font-medium">按类目提示词同步结果</h2>
          <p className="mt-0.5 text-xs text-muted-foreground">{syncCountsText(report.counts)}</p>
          {report.detailsTruncated ? (
            <p className="mt-0.5 text-meta text-faint-foreground">
              同步明细已截断，计数仍然精确。
            </p>
          ) : null}
        </div>
        <Button type="button" size="sm" variant="ghost" onClick={onDismiss}>
          收起
        </Button>
      </div>
      <div className="mt-3 grid gap-3 lg:grid-cols-2">
        {syncResultGroups(report).map((group) => {
          const visibleEntries = group.entries.slice(0, SYNC_DETAILS_SHOWN)
          const unlistedCount = syncUnlistedCount(group.count, visibleEntries)
          return (
          <div
            key={group.key}
            className="flex min-w-0 flex-col gap-1.5 rounded-lg border border-border bg-card px-3 py-2.5"
          >
            <div className="flex items-baseline justify-between gap-2">
              <h3 className="text-xs font-medium text-muted-foreground">{group.title}</h3>
              <span className={cn("font-mono text-xs tabular-nums", SYNC_TONE_CLASS[group.tone])}>
                {group.count}
              </span>
            </div>
            {group.count === 0 ? (
              <p className="text-xs text-faint-foreground">无</p>
            ) : (
              <>
                <ul className="flex min-w-0 flex-col gap-1.5">
                  {visibleEntries.map((entry) => (
                    <li key={`${group.key}-${entry.productId}`} className="min-w-0">
                      <p className="truncate text-xs text-foreground">
                        {entry.productTitle || entry.productId}
                      </p>
                      <p className="truncate font-mono text-meta text-faint-foreground">
                        {entry.promptFileName || entry.productId}
                        {entry.note ? ` · ${entry.note}` : ""}
                      </p>
                    </li>
                  ))}
                </ul>
                {unlistedCount > 0 ? (
                  <p className="text-meta text-faint-foreground">
                    另有 {unlistedCount} 条未列出
                  </p>
                ) : null}
              </>
            )}
          </div>
          )
        })}
      </div>
    </section>
  )
}

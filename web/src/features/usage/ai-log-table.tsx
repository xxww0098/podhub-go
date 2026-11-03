import { useCallback, useEffect, useRef, useState } from "react"
import { ChevronLeft, ChevronRight, Download, RefreshCw } from "lucide-react"

import type { components } from "@/api/schema"
import { accountHttp } from "@/bindings/http-account"
import { Button } from "@/components/ui/button"
import { IconButton } from "@/components/ui/icon-button"
import { Skeleton } from "@/components/ui/skeleton"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { formatDateTime } from "@/lib/format"
import { formatYuan } from "@/lib/money"
import { notifyCommandError } from "@/lib/notify"
import { cn } from "@/lib/utils"

type AILogItem = components["schemas"]["AILogItem"]
type AILogPage = components["schemas"]["AILogPageResponse"]

const AI_LOG_PAGE_SIZE = 20
/** `type` of a successful consume row; every other value is a failure or admin record. */
const LOG_TYPE_CONSUME = 2

/**
 * `quota` is this request's exact charge in microfen, including the part the
 * platform absorbed, so `formatYuan` reads it directly.
 */
export function formatLogCost(quota: number): string {
  return formatYuan(quota)
}

function formatLogTime(createdAtSeconds: number): string {
  return formatDateTime(createdAtSeconds * 1000)
}

export function logPageCount(total: number, pageSize: number = AI_LOG_PAGE_SIZE): number {
  return Math.max(1, Math.ceil(total / pageSize))
}

/** Failure text only: a consume row's `content` is just `quota N`. */
export function logFailureText(item: Pick<AILogItem, "type" | "content">): string | null {
  if (item.type === LOG_TYPE_CONSUME) return null
  return item.content.trim() === "" ? "失败" : item.content
}

export type AiLogState =
  | { status: "loading" }
  | { status: "failed" }
  | { status: "ready"; page: AILogPage }

/** The presentational table, split from the read so it renders from a fixture. */
export function AiLogTableView({
  state,
  page,
  exporting = false,
  onPageChange,
  onRetry,
  onExport,
}: {
  state: AiLogState
  page: number
  exporting?: boolean
  onPageChange?: (page: number) => void
  onRetry?: () => void
  onExport?: () => void
}) {
  const pages = state.status === "ready" ? logPageCount(state.page.total, state.page.page_size || AI_LOG_PAGE_SIZE) : page
  return (
    <section aria-label="AI 调用日志" className="flex flex-col gap-2 rounded-xl border border-border bg-card p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-sm font-semibold text-foreground">AI 调用日志</span>
        <div className="flex items-center gap-1">
          {onExport ? (
            <IconButton
              icon={Download}
              label="导出 CSV"
              size="icon-sm"
              disabled={exporting}
              onClick={onExport}
            />
          ) : null}
        </div>
      </div>

      {state.status === "loading" ? (
        <Skeleton className="h-32" />
      ) : state.status === "failed" ? (
        <div role="status" className="flex items-center gap-2 text-compact text-muted-foreground">
          <span>AI 调用日志读取失败。</span>
          {onRetry ? (
            <Button size="xs" variant="outline" onClick={onRetry}>
              <RefreshCw aria-hidden />
              重试
            </Button>
          ) : null}
        </div>
      ) : state.page.items.length === 0 ? (
        <p role="status" className="text-compact text-muted-foreground">暂无调用日志。</p>
      ) : (
        <>
          <Table>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead>时间</TableHead>
                <TableHead>模型</TableHead>
                <TableHead className="text-right">输入 Tokens</TableHead>
                <TableHead className="text-right">输出 Tokens</TableHead>
                <TableHead className="text-right">费用</TableHead>
                <TableHead className="text-right">耗时</TableHead>
                <TableHead>请求 ID</TableHead>
                <TableHead>错误</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {state.page.items.map((item) => {
                const failure = logFailureText(item)
                return (
                  <TableRow key={item.id}>
                    <TableCell className="whitespace-nowrap text-xs text-muted-foreground">
                      {formatLogTime(item.created_at)}
                    </TableCell>
                    <TableCell className="whitespace-nowrap font-mono text-xs">{item.model_name || "—"}</TableCell>
                    <TableCell className="text-right font-mono tabular-nums">
                      {item.prompt_tokens.toLocaleString("zh-CN")}
                    </TableCell>
                    <TableCell className="text-right font-mono tabular-nums">
                      {item.completion_tokens.toLocaleString("zh-CN")}
                    </TableCell>
                    <TableCell className="text-right font-mono tabular-nums">{formatLogCost(item.quota)}</TableCell>
                    <TableCell className="text-right font-mono tabular-nums text-muted-foreground">
                      {item.use_time} s
                    </TableCell>
                    <TableCell className="max-w-40 truncate font-mono text-xs text-muted-foreground" title={item.request_id}>
                      {item.request_id || "—"}
                    </TableCell>
                    <TableCell
                      className={cn("max-w-64 truncate text-xs", failure ? "text-st-bad-ink" : "text-muted-foreground")}
                      title={failure ?? undefined}
                    >
                      {failure ?? "—"}
                    </TableCell>
                  </TableRow>
                )
              })}
            </TableBody>
          </Table>
          <div className="flex items-center justify-end gap-2">
            <span className="font-mono text-meta text-muted-foreground tabular-nums">
              {`第 ${page} / ${pages} 页 · 共 ${state.page.total.toLocaleString("zh-CN")} 条`}
            </span>
            <IconButton
              icon={ChevronLeft}
              label="上一页"
              size="icon-sm"
              disabled={page <= 1}
              onClick={() => onPageChange?.(page - 1)}
            />
            <IconButton
              icon={ChevronRight}
              label="下一页"
              size="icon-sm"
              disabled={page >= pages}
              onClick={() => onPageChange?.(page + 1)}
            />
          </div>
        </>
      )}
    </section>
  )
}

function downloadBytes(filename: string, bytes: Uint8Array<ArrayBuffer>) {
  const url = URL.createObjectURL(new Blob([bytes], { type: "text/csv;charset=utf-8" }))
  const anchor = document.createElement("a")
  anchor.href = url
  anchor.download = filename
  anchor.click()
  URL.revokeObjectURL(url)
}

/**
 * Paginated consume log of the session's active Workspace. The page and the
 * rows belong to one Workspace: a switch remounts the table through `key`, and
 * a reply born before the switch is fenced by the generation counter.
 */
export function AiLogTable({
  workspaceId,
  enabled,
  reloadToken,
}: {
  workspaceId: number
  enabled: boolean
  reloadToken: number
}) {
  const [page, setPage] = useState(1)
  const [state, setState] = useState<AiLogState>({ status: "loading" })
  const [exporting, setExporting] = useState(false)
  const generation = useRef(0)

  const load = useCallback(async (target: number) => {
    const mine = ++generation.current
    setState((current) => (current.status === "ready" ? current : { status: "loading" }))
    try {
      const next = await accountHttp.accountListAiLogs(target, AI_LOG_PAGE_SIZE)
      if (mine === generation.current) setState({ status: "ready", page: next })
    } catch {
      if (mine === generation.current) setState({ status: "failed" })
    }
  }, [])

  useEffect(() => {
    if (!enabled) return
    void load(page)
  }, [enabled, load, page, reloadToken, workspaceId])

  useEffect(() => () => { generation.current += 1 }, [])

  const exportCsv = useCallback(async () => {
    setExporting(true)
    try {
      downloadBytes("ai-logs.csv", await accountHttp.accountExportAiLogs())
    } catch (reason) {
      notifyCommandError(reason, "导出失败，请稍后重试。")
    } finally {
      setExporting(false)
    }
  }, [])

  return (
    <AiLogTableView
      state={state}
      page={page}
      exporting={exporting}
      onPageChange={setPage}
      onRetry={() => void load(page)}
      onExport={() => void exportCsv()}
    />
  )
}

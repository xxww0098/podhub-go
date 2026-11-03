import { Fragment, useCallback, useEffect, useId, useRef, useState } from "react"
import {
  ChartNoAxesColumn,
  ChevronLeft,
  ChevronRight,
  Copy,
  ListFilter,
  RotateCcw,
  ScrollText,
  Trash2,
  TriangleAlert,
} from "lucide-react"

import type {
  AdminErrorLogData,
  AdminErrorLogFilters,
  AdminErrorLogView,
  AdminUsageData,
  AdminUsageFilters,
  AdminUsageRequestView,
  AdminUsageSummaryData,
} from "@/bindings/commands"
import { adminHttp } from "@/bindings/http-admin"
import {
  PlatformAdminEmpty,
  PlatformAdminRefresh,
  PlatformAdminSearch,
  PlatformAdminSurface,
  PlatformAdminTab,
} from "@/components/platform-admin-surface"
import { useScreenActive } from "@/components/screen-pane"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { ConfirmDialog } from "@/components/ui/confirm-dialog"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Skeleton } from "@/components/ui/skeleton"
import {
  Table,
  TableBody,
  TableCell,
  TableExpandedRow,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { IconButton } from "@/components/ui/icon-button"
import { formatUsageNumber } from "@/features/usage/usage-charts"
import { errorMessage } from "@/lib/error-message"
import { formatDateTime } from "@/lib/format"
import { formatYuan } from "@/lib/money"
import {
  clearLive,
  notifyCommandError,
  notifyLive,
  notifySuccess,
} from "@/lib/notify"
import {
  formatGenerationSpeed,
  formatLatency,
  operationLabel,
  UsageSummaryStrip,
} from "./usage-summary"

export { formatGenerationSpeed } from "./usage-summary"

const DEFAULT_PAGE_SIZE = 10
type Period = "24h" | "7d" | "30d"

const ADMIN_USAGE_READ_LIVE = "admin-usage-read"
const ADMIN_ERRORS_READ_LIVE = "admin-errors-read"

export function sinceForPeriod(
  period: Period,
  nowMs = Date.now(),
): string {
  const hours = period === "24h" ? 24 : period === "7d" ? 24 * 7 : 24 * 30
  return new Date(nowMs - hours * 60 * 60 * 1_000).toISOString()
}

function periodLabel(period: Period): string {
  if (period === "24h") return "最近 24 小时"
  if (period === "7d") return "最近 7 天"
  return "最近 30 天"
}

/** Both ledgers pick from the same three windows; one Select keeps them identical. */
function PeriodSelect({
  value,
  onChange,
  ariaLabel,
}: {
  value: Period
  onChange: (period: Period) => void
  ariaLabel: string
}) {
  return (
    <Select
      value={value}
      onValueChange={(next) => onChange((next ?? "30d") as Period)}
    >
      <SelectTrigger size="sm" className="min-w-28 cursor-pointer" aria-label={ariaLabel}>
        <SelectValue>{() => periodLabel(value)}</SelectValue>
      </SelectTrigger>
      <SelectContent>
        <SelectItem value="24h">最近 24 小时</SelectItem>
        <SelectItem value="7d">最近 7 天</SelectItem>
        <SelectItem value="30d">最近 30 天</SelectItem>
      </SelectContent>
    </Select>
  )
}

/** 筛选 + 重置 pair — both ledgers apply a draft server-side, never per keystroke. */
function FilterActions({
  loading,
  dirty,
  onApply,
  onReset,
}: {
  loading: boolean
  dirty: boolean
  onApply: () => void
  onReset: () => void
}) {
  return (
    <>
      <IconButton
        icon={ListFilter}
        label="筛选"
        size="icon-sm"
        variant="secondary"
        disabled={loading}
        onClick={onApply}
      />
      <IconButton
        icon={RotateCcw}
        label="重置"
        size="icon-sm"
        variant="ghost"
        disabled={loading || !dirty}
        onClick={onReset}
      />
    </>
  )
}

function ReadFailure({ stale, onRetry }: { stale: boolean; onRetry: () => void }) {
  return (
    <div role="alert" className="flex flex-wrap items-center gap-2 border-b border-border px-4 py-3 text-compact">
      <TriangleAlert className="size-4 text-destructive" aria-hidden />
      <span>{stale ? "读取失败，当前显示上次读取结果。" : "日志读取失败，请重试。"}</span>
      <Button size="sm" variant="outline" onClick={onRetry}>重试</Button>
    </div>
  )
}

function LogPagination({ page, pageCount, total, pageSize, busy, onPage, onPageSize }: {
  page: number
  pageCount: number
  total: number
  pageSize: number
  busy: boolean
  onPage: (page: number) => void
  onPageSize: (pageSize: number) => void
}) {
  return (
    <div className="flex shrink-0 flex-wrap items-center justify-between gap-3 px-1 py-3 text-sm text-muted-foreground">
      <div className="flex items-center gap-2">
        <span>共 {total.toLocaleString("zh-CN")} 条，每页</span>
        <Select value={String(pageSize)} onValueChange={(value) => { if (value) onPageSize(Number(value)) }}>
          <SelectTrigger size="sm" aria-label="每页日志条数" disabled={busy}><SelectValue>{(value) => `${value} 条`}</SelectValue></SelectTrigger>
          <SelectContent><SelectItem value="10">10 条</SelectItem><SelectItem value="20">20 条</SelectItem><SelectItem value="50">50 条</SelectItem></SelectContent>
        </Select>
      </div>
      <div className="flex items-center gap-2">
        <IconButton icon={ChevronLeft} label="上一页" size="icon-sm" variant="outline" disabled={busy || page <= 1} onClick={() => onPage(page - 1)} />
        <span aria-current="page" className="flex size-9 items-center justify-center rounded-md bg-brand text-sm font-medium text-white">{page}</span>
        {page < pageCount ? <Button variant="outline" size="icon-sm" aria-label={`第 ${page + 1} 页`} disabled={busy} onClick={() => onPage(page + 1)}>{page + 1}</Button> : null}
        <IconButton icon={ChevronRight} label="下一页" size="icon-sm" variant="outline" disabled={busy || page >= pageCount} onClick={() => onPage(page + 1)} />
      </div>
    </div>
  )
}

export function endpointLabel(apiFormat?: string | null): string {
  if (apiFormat === "chat_completions") return "chat/completions"
  if (apiFormat === "responses") return "responses"
  if (apiFormat === "anthropic_messages") return "messages"
  return apiFormat ?? ""
}

function statusMeta(status: string): {
  label: string
  variant: "secondary" | "destructive" | "outline" | "good"
} {
  switch (status) {
    case "settled":
      return {
        label: "正常",
        variant: "good",
      }
    case "failed":
      return { label: "失败", variant: "destructive" }
    case "unbilled_unknown":
      return { label: "未计费待确认", variant: "outline" }
    case "held":
      return { label: "已预留", variant: "secondary" }
    case "dispatching":
      return { label: "处理中", variant: "secondary" }
    default:
      return { label: status, variant: "outline" }
  }
}

/**
 * One staff-ledger row, split from the read so it can be rendered from a
 * fixture. The amount is the charged split — what settlement took out of the
 * balance; rows where a provider billed past the ceiling carry the absorbed
 * relief beside it.
 */
export function RequestRow({ row }: { row: AdminUsageRequestView }) {
  const status = statusMeta(row.status)
  const [expanded, setExpanded] = useState(false)
  const detailsId = useId()
  return (
    <Fragment>
    <TableRow>
      <TableCell className="whitespace-nowrap font-mono text-meta tabular-nums text-muted-foreground">
        {formatDateTime(row.created_at)}
      </TableCell>
      <TableCell className="whitespace-nowrap text-compact text-muted-foreground">
        <Badge variant="outline">{operationLabel(row.operation) || "未知"}</Badge>
      </TableCell>
      <TableCell className="min-w-0">
        <div className="truncate font-medium text-foreground" title={row.model}>{row.model}</div>
        <div className="truncate text-meta text-muted-foreground" title={`${row.workspace_name} / ${row.email}`}>
          {row.workspace_name} · {row.email}
        </div>
      </TableCell>
      <TableCell className="whitespace-nowrap">
        <Badge variant={status.variant}>
          <span className="size-1.5 rounded-full bg-current" aria-hidden />
          {status.label}
        </Badge>
      </TableCell>
      <TableCell className="whitespace-nowrap text-right font-mono tabular-nums">
        {formatLatency(row.latency_ms)}
      </TableCell>
      <TableCell className="font-mono tabular-nums">
        <div className="truncate">{formatUsageNumber(row.input_tokens)} / {formatUsageNumber(row.output_tokens)}</div>
        <div className="truncate text-meta text-muted-foreground" title={row.absorbed_microfen > 0 ? `平台封顶减免 ${formatYuan(row.absorbed_microfen)}` : undefined}>
          {formatYuan(row.charged_microfen)}{row.absorbed_microfen > 0 ? " · 减免" : null}
        </div>
      </TableCell>
      <TableCell>
        <Button variant="ghost" size="sm" aria-expanded={expanded} aria-controls={expanded ? detailsId : undefined} onClick={() => setExpanded(!expanded)}>
          {expanded ? "收起" : "详情"}
          <span className="sr-only">请求 {row.request_id}</span>
        </Button>
      </TableCell>
    </TableRow>
    {expanded ? (
      <TableExpandedRow id={detailsId} colSpan={7}>
        <dl className="grid grid-cols-2 gap-x-6 gap-y-3 px-2 py-3 text-compact sm:grid-cols-3 lg:grid-cols-6">
          {[
            ["请求 ID", row.request_id],
            ["工作空间", row.workspace_name],
            ["用户邮箱", row.email],
            ["费用", formatYuan(row.charged_microfen)],
            ["平台封顶减免", formatYuan(row.absorbed_microfen)],
            ["渠道", row.channel_name || "—"],
            ["思考深度", row.thinking_depth || "—"],
            ["端点", endpointLabel(row.api_format) || "—"],
            ["生成速度", formatGenerationSpeed(row.generation_speed_milli_tps)],
            ["缓存读取", formatUsageNumber(row.cached_input_tokens)],
            ["推理", formatUsageNumber(row.reasoning_output_tokens)],
            ["错误信息", row.error_class || "—"],
          ].map(([label, value]) => (
            <div key={label} className="min-w-0 break-words">
              <dt className="text-muted-foreground">{label}</dt>
              <dd className="mt-1 font-mono">{value}</dd>
            </div>
          ))}
        </dl>
        {row.upstream_error ? (
          <div className="px-2 pb-3">
            <div className="text-compact text-muted-foreground">完整上游错误</div>
            <pre className="mt-1 max-h-80 overflow-auto rounded-md border border-border p-3 text-meta whitespace-pre-wrap text-foreground">{row.upstream_error}</pre>
          </div>
        ) : null}
      </TableExpandedRow>
    ) : null}
    </Fragment>
  )
}

type UsageFilterDraft = Omit<AdminUsageFilters, "since"> & { period: Period }

const EMPTY_USAGE_FILTERS: AdminUsageFilters = {
  query: "",
  status: "",
  api_format: "",
  operation: "",
}
const EMPTY_USAGE_DRAFT: UsageFilterDraft = {
  ...EMPTY_USAGE_FILTERS,
  period: "30d",
}

/**
 * Platform-wide API request log, one row per Cloud AI relay attempt.
 * Read-only; configured request credentials never cross this boundary.
 */
export function AdminUsageScreen() {
  const active = useScreenActive()
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(DEFAULT_PAGE_SIZE)
  const [data, setData] = useState<AdminUsageData | null>(null)
  const [summary, setSummary] = useState<AdminUsageSummaryData | null>(null)
  const [showSummary, setShowSummary] = useState(false)
  const [loading, setLoading] = useState(true)
  const [readFailed, setReadFailed] = useState(false)
  const [draft, setDraft] = useState<UsageFilterDraft>(EMPTY_USAGE_DRAFT)
  const [filters, setFilters] = useState<AdminUsageFilters>(EMPTY_USAGE_FILTERS)
  const generationRef = useRef(0)

  const load = useCallback(
    (targetPage: number) => {
      const generation = ++generationRef.current
      setLoading(true)
      const effectiveFilters = { ...filters, since: filters.since ?? sinceForPeriod("30d") }
      // The page and its aggregate read the same filtered window together, so
      // the strip and the rows can never disagree about what was measured.
      Promise.all([
        adminHttp.adminListAiRequests(targetPage, pageSize, effectiveFilters),
        adminHttp.adminAiUsageSummary(effectiveFilters),
      ])
        .then(([next, nextSummary]) => {
          if (generation !== generationRef.current) return
          clearLive(ADMIN_USAGE_READ_LIVE)
          setReadFailed(false)
          setData(next)
          setSummary(nextSummary)
          // The server clamps a page past the end, so the control reflects the
          // page actually returned rather than the one that was asked for.
          setPage(next.page)
        })
        .catch((reason) => {
          if (generation !== generationRef.current) return
          setReadFailed(true)
          notifyLive({
            id: ADMIN_USAGE_READ_LIVE,
            type: "error",
            reason,
            title: "API 请求日志读取失败",
            description: errorMessage(reason, "无法加载 API 请求日志，请稍后重试。"),
            action: { label: "重试", onClick: () => load(targetPage) },
          })
        })
        .finally(() => {
          if (generation === generationRef.current) setLoading(false)
        })
    },
    [filters, pageSize],
  )

  useEffect(() => {
    if (!active) return
    load(page)
  }, [active, load, page])

  useEffect(() => () => clearLive(ADMIN_USAGE_READ_LIVE), [])

  const pageCount = Math.max(1, data?.total_pages ?? 1)
  const hasFilters = Boolean(
    filters.query || filters.status || filters.api_format || filters.operation || filters.since,
  )
  const hasDraftFilters = Boolean(
    draft.query ||
      draft.status ||
      draft.api_format ||
      draft.operation ||
      draft.period !== "30d",
  )

  function applyFilters() {
    setPage(1)
    setFilters({
      query: draft.query.trim(),
      status: draft.status,
      api_format: draft.api_format,
      operation: draft.operation,
      since: sinceForPeriod(draft.period),
    })
  }

  function resetFilters() {
    setDraft(EMPTY_USAGE_DRAFT)
    setPage(1)
    setFilters(EMPTY_USAGE_FILTERS)
  }

  return (
    <div className="flex min-h-0 min-w-0 w-full flex-1 flex-col gap-3">

      <PlatformAdminSurface
        bodyClassName="flex min-h-0 flex-col overflow-hidden rounded-xl border border-border bg-card"
        toolbar={
          <>
            <PeriodSelect
              value={draft.period}
              onChange={(period) =>
                setDraft((current) => ({ ...current, period }))
              }
              ariaLabel="按访问时间筛选"
            />
            <Select
              value={draft.status || "all"}
              onValueChange={(value) =>
                setDraft((current) => ({
                  ...current,
                  status: value === "all" ? "" : (value ?? ""),
                }))
              }
            >
              <SelectTrigger
                size="sm"
                className="min-w-28 cursor-pointer"
                aria-label="按请求状态筛选"
              >
                <SelectValue>
                  {() =>
                    draft.status ? statusMeta(draft.status).label : "全部状态"
                  }
                </SelectValue>
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">全部状态</SelectItem>
                <SelectItem value="settled">正常</SelectItem>
                <SelectItem value="failed">失败</SelectItem>
                <SelectItem value="dispatching">处理中</SelectItem>
                <SelectItem value="held">已预留</SelectItem>
                <SelectItem value="unbilled_unknown">未计费待确认</SelectItem>
              </SelectContent>
            </Select>
            <Select
              value={draft.api_format || "all"}
              onValueChange={(value) =>
                setDraft((current) => ({
                  ...current,
                  api_format: value === "all" ? "" : (value ?? ""),
                }))
              }
            >
              <SelectTrigger
                size="sm"
                className="min-w-32 cursor-pointer"
                aria-label="按请求端点筛选"
              >
                <SelectValue>
                  {() => endpointLabel(draft.api_format) || "全部端点"}
                </SelectValue>
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">全部端点</SelectItem>
                <SelectItem value="chat_completions">chat/completions</SelectItem>
                <SelectItem value="responses">responses</SelectItem>
                <SelectItem value="anthropic_messages">messages</SelectItem>
              </SelectContent>
            </Select>
            <Select
              value={draft.operation || "all"}
              onValueChange={(value) =>
                setDraft((current) => ({
                  ...current,
                  operation: value === "all" ? "" : (value ?? ""),
                }))
              }
            >
              <SelectTrigger
                size="sm"
                className="min-w-24 cursor-pointer"
                aria-label="按请求操作筛选"
              >
                <SelectValue>
                  {() => operationLabel(draft.operation) || "全部操作"}
                </SelectValue>
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">全部操作</SelectItem>
                <SelectItem value="ocr">识图</SelectItem>
                <SelectItem value="ai_token">Chat</SelectItem>
              </SelectContent>
            </Select>
            <PlatformAdminSearch
              value={draft.query}
              onChange={(query) =>
                setDraft((current) => ({ ...current, query }))
              }
              onSubmit={applyFilters}
              label="搜索 API 请求日志"
              placeholder="搜索 Workspace、邮箱、模型或请求 ID"
            />
            <FilterActions
              loading={loading}
              dirty={hasFilters || hasDraftFilters}
              onApply={applyFilters}
              onReset={resetFilters}
            />
            <Button variant="outline" size="sm" aria-expanded={showSummary} onClick={() => setShowSummary((open) => !open)}>
              <ChartNoAxesColumn data-icon="inline-start" />统计
            </Button>
            <span className="ml-auto">
              <PlatformAdminRefresh
                busy={loading}
                onClick={() => load(page)}
                label="刷新 API 请求日志"
              />
            </span>
          </>
        }
      >
        {readFailed && !loading ? <ReadFailure stale={data !== null} onRetry={() => load(page)} /> : null}
        {loading && data ? <div role="status" className="border-b border-border px-4 py-2 text-compact text-muted-foreground">正在读取，当前显示上次读取结果。</div> : null}
        {summary && showSummary ? <UsageSummaryStrip data={summary} /> : null}
        <div className="flex min-h-0 flex-1 flex-col overflow-auto">
          <Table
            containerClassName="shrink-0 overflow-visible"
            className="min-w-[48rem] table-fixed"
            variant="directory"
            aria-busy={loading}
          >
            <TableHeader className="sticky top-0 z-10 bg-popover">
              <TableRow>
                <TableHead className="w-36">时间</TableHead>
                <TableHead className="w-20">类型</TableHead>
                <TableHead>请求名称</TableHead>
                <TableHead className="w-24">状态</TableHead>
                <TableHead className="w-20 text-right">耗时</TableHead>
                <TableHead className="w-32">输入 / 输出 · 费用</TableHead>
                <TableHead className="w-20">操作</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data?.rows.map((row) => (
                <RequestRow key={row.request_id} row={row} />
              ))}
            </TableBody>
          </Table>
        {loading && !data ? (
          <div className="p-4">
            <Skeleton className="h-80 w-full" />
          </div>
        ) : data && data.rows.length === 0 ? (
          <PlatformAdminEmpty
            icon={ScrollText}
            className="min-h-80 flex-1"
            title={loading || readFailed ? "上次读取结果为空。" : hasFilters ? "没有符合当前筛选条件的请求。" : "暂无 API 请求日志。"}
          />
        ) : null}
        </div>

        {data ? (
        <LogPagination
          page={data.page}
          pageCount={pageCount}
          total={data.total_rows}
          pageSize={pageSize}
          busy={loading || readFailed}
          onPage={setPage}
          onPageSize={(size) => { setPage(1); setPageSize(size) }}
        />
        ) : null}
      </PlatformAdminSurface>
    </div>
  )
}

export function sourceLabel(source?: string | null): string {
  switch (source) {
    case "workbench":
      return "工作台"
    case "host_uncaught":
      return "Host 未捕获"
    case "host_panic":
      return "Host 崩溃"
    case "host_command":
      return "Host 命令"
    case "renderer_uncaught":
      return "界面未捕获"
    case "renderer_rejection":
      return "界面未处理拒绝"
    case "child_process_gone":
      return "子进程退出"
    default:
      return source ?? ""
  }
}

export function severityLabel(severity?: string | null): string {
  if (severity === "blocking") return "阻断"
  if (severity === "degraded") return "降级"
  return severity ?? ""
}

/**
 * `desktop_error_log.v2` replaces free text with a whitelisted params object;
 * v1 rows have a message instead. One row never carries both.
 */
export function detailLabel(
  row: Pick<AdminErrorLogView, "message" | "params">,
): string {
  if (row.message) return row.message
  if (!row.params) return ""
  try {
    return Object.entries(JSON.parse(row.params) as Record<string, unknown>)
      .map(([key, value]) => `${key}=${String(value)}`)
      .join(" · ")
  } catch {
    return row.params
  }
}

function cleanCell(value: string): string {
  return value.replace(/[\t\r\n]+/g, " ").trim()
}

export function errorLogsTsv(rows: AdminErrorLogView[]): string {
  const header = [
    "接收时间",
    "Workspace",
    "用户邮箱",
    "来源",
    "错误码",
    "级别",
    "详情",
    "指纹",
    "设备",
    "版本",
    "系统",
  ]
  return [
    header,
    ...rows.map((row) => [
      row.received_at,
      row.workspace_name,
      row.email,
      sourceLabel(row.source),
      row.code,
      severityLabel(row.severity),
      detailLabel(row),
      row.fingerprint,
      row.device_uid,
      row.app_version,
      row.os,
    ]),
  ]
    .map((cells) => cells.map(cleanCell).join("\t"))
    .join("\n")
}

function rowKey(row: Pick<AdminErrorLogView, "event_id" | "device_uid">): string {
  return JSON.stringify([row.device_uid, row.event_id])
}

function ErrorRow({
  row,
  selected,
  disabled,
  onSelectedChange,
  onCopy,
}: {
  row: AdminErrorLogView
  selected: boolean
  disabled: boolean
  onSelectedChange: (selected: boolean) => void
  onCopy: () => void
}) {
  const [detailOpen, setDetailOpen] = useState(false)
  const detail = detailLabel(row)
  const detailId = useId()
  return (
    <Fragment>
    <TableRow data-state={selected ? "selected" : undefined}>
      <TableCell>
        <div className="flex items-center gap-1">
        <Checkbox
          checked={selected}
          disabled={disabled}
          aria-label={`选择错误日志 ${row.code}`}
          onCheckedChange={(checked) => onSelectedChange(checked === true)}
        />
        <IconButton
          icon={Copy}
          label={`复制错误日志 ${row.code}`}
          tip="复制此条"
          size="icon-xs"
          tooltipSide="top"
          disabled={disabled}
          onClick={onCopy}
        />
        </div>
      </TableCell>
      <TableCell className="whitespace-nowrap font-mono text-meta tabular-nums text-muted-foreground">
        {formatDateTime(row.received_at)}
      </TableCell>
      <TableCell className="min-w-0">
        <div className="truncate" title={row.workspace_name}>{row.workspace_name}</div>
        <div className="truncate text-meta text-muted-foreground" title={row.email}>{row.email}</div>
      </TableCell>
      <TableCell className="min-w-0">
        <Badge variant="outline" className="max-w-full"><span className="truncate" title={sourceLabel(row.source)}>{sourceLabel(row.source)}</span></Badge>
      </TableCell>
      <TableCell className="min-w-0">
        <div className="flex flex-col items-start gap-1">
          <span className="max-w-full truncate font-mono text-compact" title={row.code}>{row.code}</span>
          {row.severity ? (
            <Badge
              variant={
                row.severity === "blocking" ? "destructive" : "secondary"
              }
            >
              {severityLabel(row.severity)}
            </Badge>
          ) : null}
        </div>
      </TableCell>
      <TableCell className="min-w-0 whitespace-normal">
        <p className="line-clamp-2 break-all">{detail || "—"}</p>
      </TableCell>
      <TableCell>
        <Button variant="ghost" size="sm" aria-expanded={detailOpen} aria-controls={detailOpen ? detailId : undefined} aria-label={`${detailOpen ? "收起" : "展开"}错误详情 ${row.code}`} onClick={() => setDetailOpen((open) => !open)}>
          {detailOpen ? "收起" : "详情"}
        </Button>
      </TableCell>
    </TableRow>
    {detailOpen ? (
      <TableExpandedRow id={detailId} colSpan={7}>
        <div className="px-2 py-3 text-compact">
          <p className="break-all">{detail || "—"}</p>
          <dl className="mt-3 grid grid-cols-2 gap-x-6 gap-y-3 sm:grid-cols-4">
            {[["工作空间", row.workspace_name], ["用户邮箱", row.email], ["来源", sourceLabel(row.source)], ["错误码", row.code], ["指纹", row.fingerprint], ["设备", row.device_uid], ["版本", row.app_version], ["系统", row.os]].map(([label, value]) => (
              <div key={label} className="min-w-0 break-all"><dt className="text-muted-foreground">{label}</dt><dd>{value || "—"}</dd></div>
            ))}
          </dl>
        </div>
      </TableExpandedRow>
    ) : null}
    </Fragment>
  )
}

type ErrorFilterDraft = Omit<AdminErrorLogFilters, "since"> & {
  period: Period
}

const EMPTY_ERROR_FILTERS: AdminErrorLogFilters = { query: "", source: "" }
const EMPTY_ERROR_DRAFT: ErrorFilterDraft = {
  ...EMPTY_ERROR_FILTERS,
  period: "30d",
}

/**
 * Platform-wide inbox errors, including leftover workbench rows posted as
 * `desktop_error_log` v1 and v2. v2 carries no free text, so the ledger
 * reads code + severity; message only shows on leftover v1 rows.
 */
export function AdminErrorsScreen() {
  const active = useScreenActive()
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(DEFAULT_PAGE_SIZE)
  const [data, setData] = useState<AdminErrorLogData | null>(null)
  const [loading, setLoading] = useState(true)
  const [readFailed, setReadFailed] = useState(false)
  const [draft, setDraft] = useState<ErrorFilterDraft>(EMPTY_ERROR_DRAFT)
  const [filters, setFilters] = useState<AdminErrorLogFilters>(EMPTY_ERROR_FILTERS)
  const [selectedKeys, setSelectedKeys] = useState<Set<string>>(new Set())
  const [deleteOpen, setDeleteOpen] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const generationRef = useRef(0)

  const load = useCallback(
    (targetPage: number) => {
      const generation = ++generationRef.current
      setLoading(true)
      setSelectedKeys(new Set())
      setDeleteOpen(false)
      const effectiveFilters = { ...filters, since: filters.since ?? sinceForPeriod("30d") }
      adminHttp
        .adminListErrorLogs(targetPage, pageSize, effectiveFilters)
        .then((next) => {
          if (generation !== generationRef.current) return
          clearLive(ADMIN_ERRORS_READ_LIVE)
          setReadFailed(false)
          setData(next)
          setPage(next.page)
          setSelectedKeys(new Set())
        })
        .catch((reason) => {
          if (generation !== generationRef.current) return
          setReadFailed(true)
          notifyLive({
            id: ADMIN_ERRORS_READ_LIVE,
            type: "error",
            reason,
            title: "错误日志读取失败",
            description: errorMessage(reason, "无法加载错误日志，请稍后重试。"),
            action: { label: "重试", onClick: () => load(targetPage) },
          })
        })
        .finally(() => {
          if (generation === generationRef.current) setLoading(false)
        })
    },
    [filters, pageSize],
  )

  useEffect(() => {
    if (!active) return
    load(page)
  }, [active, load, page])

  useEffect(() => () => clearLive(ADMIN_ERRORS_READ_LIVE), [])

  const pageCount = Math.max(1, data?.total_pages ?? 1)
  const hasFilters = Boolean(filters.query || filters.source || filters.since)
  const hasDraftFilters = Boolean(
    draft.query || draft.source || draft.period !== "30d",
  )
  const rows = data?.rows ?? []
  const selectedRows = rows.filter((row) => selectedKeys.has(rowKey(row)))
  const allSelected = rows.length > 0 && selectedRows.length === rows.length
  const someSelected = selectedRows.length > 0 && !allSelected

  async function copyRows(rowsToCopy: AdminErrorLogView[]) {
    try {
      await navigator.clipboard.writeText(errorLogsTsv(rowsToCopy))
      notifySuccess(`已复制 ${rowsToCopy.length} 条错误日志`)
    } catch (reason) {
      notifyCommandError(reason, "复制失败，请稍后重试。")
    }
  }

  async function deleteSelected() {
    if (selectedRows.length === 0 || loading || readFailed) return
    setDeleting(true)
    try {
      const result = await adminHttp.adminDeleteErrorLogs(
        selectedRows.map((row) => ({
          event_id: row.event_id,
          device_uid: row.device_uid,
        })),
      )
      notifySuccess(`已删除 ${result.deleted_count} 条错误日志`)
      setDeleteOpen(false)
      load(page)
    } catch (reason) {
      notifyCommandError(reason, "删除错误日志失败，请稍后重试。")
    } finally {
      setDeleting(false)
    }
  }

  function applyFilters() {
    setPage(1)
    setFilters({
      query: draft.query.trim(),
      source: draft.source,
      since: sinceForPeriod(draft.period),
    })
  }

  function resetFilters() {
    setDraft(EMPTY_ERROR_DRAFT)
    setPage(1)
    setFilters(EMPTY_ERROR_FILTERS)
  }

  return (
    <div className="flex min-h-0 min-w-0 w-full flex-1 flex-col gap-3">

      <PlatformAdminSurface
        bodyClassName="flex min-h-0 flex-col overflow-hidden rounded-xl border border-border bg-card"
        toolbar={
          <>
            <PeriodSelect
              value={draft.period}
              onChange={(period) =>
                setDraft((current) => ({ ...current, period }))
              }
              ariaLabel="按接收时间筛选"
            />
            <Select
              value={draft.source || "all"}
              onValueChange={(value) =>
                setDraft((current) => ({
                  ...current,
                  source: value === "all" ? "" : (value ?? ""),
                }))
              }
            >
              <SelectTrigger
                size="sm"
                className="min-w-32 cursor-pointer"
                aria-label="按错误来源筛选"
              >
                <SelectValue>
                  {() => sourceLabel(draft.source) || "全部来源"}
                </SelectValue>
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">全部来源</SelectItem>
                <SelectItem value="workbench">工作台</SelectItem>
                <SelectItem value="host_uncaught">Host 未捕获</SelectItem>
                <SelectItem value="host_panic">Host 崩溃</SelectItem>
                <SelectItem value="host_command">Host 命令</SelectItem>
                <SelectItem value="renderer_uncaught">界面未捕获</SelectItem>
                <SelectItem value="renderer_rejection">
                  界面未处理拒绝
                </SelectItem>
                <SelectItem value="child_process_gone">子进程退出</SelectItem>
              </SelectContent>
            </Select>
            <PlatformAdminSearch
              value={draft.query}
              onChange={(query) =>
                setDraft((current) => ({ ...current, query }))
              }
              onSubmit={applyFilters}
              label="搜索错误日志"
              placeholder="搜索编号、Workspace、邮箱、错误码或消息"
            />
            <FilterActions
              loading={loading}
              dirty={hasFilters || hasDraftFilters}
              onApply={applyFilters}
              onReset={resetFilters}
            />
            <span className="ml-auto">
              <PlatformAdminRefresh
                busy={loading}
                onClick={() => load(page)}
                label="刷新错误日志"
              />
            </span>
          </>
        }
      >
        {readFailed && !loading ? <ReadFailure stale={data !== null} onRetry={() => load(page)} /> : null}
        {loading && data ? <div role="status" className="border-b border-border px-4 py-2 text-compact text-muted-foreground">正在读取，当前显示上次读取结果。</div> : null}
        {selectedRows.length > 0 ? (
          <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border bg-brand-soft/40 px-4 py-2">
            <span className="text-compact font-medium">
              已选择 {selectedRows.length} 条
            </span>
            <div className="flex flex-wrap items-center gap-2">
              <Button
                size="sm"
                variant="outline"
                disabled={deleting || loading || readFailed}
                onClick={() => void copyRows(selectedRows)}
              >
                <Copy aria-hidden />
                复制 {selectedRows.length} 条
              </Button>
              <Button
                size="sm"
                variant="destructive"
                disabled={deleting || loading || readFailed}
                onClick={() => setDeleteOpen(true)}
              >
                <Trash2 aria-hidden />
                删除 {selectedRows.length} 条
              </Button>
            </div>
          </div>
        ) : null}

        <div className="flex min-h-0 flex-1 flex-col overflow-auto">
          <Table
            containerClassName="shrink-0 overflow-visible"
            className="min-w-[52rem] table-fixed"
            variant="directory"
            aria-busy={loading}
          >
            <TableHeader className="sticky top-0 z-10 bg-popover">
              <TableRow>
                <TableHead className="w-20 pr-0">
                  <Checkbox
                    checked={allSelected}
                    disabled={loading || readFailed || deleting || rows.length === 0}
                    indeterminate={someSelected}
                    aria-label="选择本页错误日志"
                    onCheckedChange={() =>
                      setSelectedKeys(
                        allSelected
                          ? new Set()
                          : new Set(rows.map((row) => rowKey(row))),
                      )
                    }
                  />
                </TableHead>
                <TableHead className="w-36">接收时间</TableHead>
                <TableHead className="w-40">Workspace / 用户邮箱</TableHead>
                <TableHead className="w-28">来源</TableHead>
                <TableHead className="w-36">错误码</TableHead>
                <TableHead>详情</TableHead>
                <TableHead className="w-20">操作</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data?.rows.map((row) => (
                <ErrorRow
                  key={rowKey(row)}
                  row={row}
                  selected={selectedKeys.has(rowKey(row))}
                  disabled={loading || readFailed || deleting}
                  onSelectedChange={(selected) =>
                    setSelectedKeys((current) => {
                      const next = new Set(current)
                      if (selected) next.add(rowKey(row))
                      else next.delete(rowKey(row))
                      return next
                    })
                  }
                  onCopy={() => void copyRows([row])}
                />
              ))}
            </TableBody>
          </Table>
        {loading && !data ? (
          <div className="p-4">
            <Skeleton className="h-80 w-full" />
          </div>
        ) : data && data.rows.length === 0 ? (
          <PlatformAdminEmpty
            icon={TriangleAlert}
            className="min-h-80 flex-1"
            title={loading || readFailed ? "上次读取结果为空。" : hasFilters ? "没有符合当前筛选条件的错误。" : "暂无错误日志。"}
          />
        ) : null}
        </div>

        {data ? (
        <LogPagination
          page={data.page}
          pageCount={pageCount}
          total={data.total_rows}
          pageSize={pageSize}
          busy={loading || readFailed}
          onPage={setPage}
          onPageSize={(size) => { setPage(1); setPageSize(size) }}
        />
        ) : null}
      </PlatformAdminSurface>
      <ConfirmDialog
        open={deleteOpen}
        onOpenChange={setDeleteOpen}
        title={`删除 ${selectedRows.length} 条错误日志？`}
        description="删除后不可恢复。"
        confirmText="确认删除"
        busy={deleting || loading || readFailed}
        icon={<Trash2 aria-hidden />}
        onConfirm={deleteSelected}
      />
    </div>
  )
}

type LogTab = "requests" | "errors"

const LOG_TABS: { id: LogTab; label: string }[] = [
  { id: "requests", label: "API 请求" },
  { id: "errors", label: "异常记录" },
]

/**
 * 平台管理 · 日志. One ledger surface for the two platform-side feeds —
 * API 请求 and 错误 — switched by underline tabs. A pane mounts on first
 * visit and stays alive so its filters and page position survive switching.
 */
export function AdminLogsScreen() {
  const [tab, setTab] = useState<LogTab>("requests")
  const [visited, setVisited] = useState<ReadonlySet<LogTab>>(
    () => new Set<LogTab>(["requests"]),
  )

  function select(next: LogTab) {
    setTab(next)
    setVisited((current) =>
      current.has(next) ? current : new Set(current).add(next),
    )
  }

  return (
    <div className="flex min-h-0 min-w-0 w-full flex-1 flex-col gap-3">
      <div
        role="tablist"
        aria-label="日志类型"
        className="flex shrink-0 items-center gap-1 border-b border-border [&_[role=tab]]:h-12 [&_[role=tab]]:px-4 [&_[role=tab]]:text-base [&_[role=tab][data-active]]:text-brand"
      >
        {LOG_TABS.map((item) => (
          <PlatformAdminTab
            key={item.id}
            active={tab === item.id}
            onClick={() => select(item.id)}
          >
            {item.label}
          </PlatformAdminTab>
        ))}
      </div>
      {visited.has("requests") ? (
        <div hidden={tab !== "requests"} className={tab === "requests" ? "flex min-h-0 flex-1" : undefined}>
          <AdminUsageScreen />
        </div>
      ) : null}
      {visited.has("errors") ? (
        <div hidden={tab !== "errors"} className={tab === "errors" ? "flex min-h-0 flex-1" : undefined}>
          <AdminErrorsScreen />
        </div>
      ) : null}
    </div>
  )
}

import { useCallback, useEffect, useRef, useState } from "react"
import {
  Copy,
  ScrollText,
  SlidersHorizontal,
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
  PlatformAdminPagination,
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
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
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

const PAGE_SIZE = 50
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
      <Button
        size="sm"
        variant="secondary"
        className="cursor-pointer"
        disabled={loading}
        onClick={onApply}
      >
        <SlidersHorizontal className="size-3.5" aria-hidden />
        筛选
      </Button>
      <Button
        size="sm"
        variant="ghost"
        className="cursor-pointer"
        disabled={loading || !dirty}
        onClick={onReset}
      >
        重置
      </Button>
    </>
  )
}

export function endpointLabel(apiFormat?: string | null): string {
  if (apiFormat === "chat_completions") return "chat/completions"
  if (apiFormat === "responses") return "responses"
  if (apiFormat === "anthropic_messages") return "messages"
  return ""
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
  return (
    <TableRow>
      <TableCell className="whitespace-nowrap text-compact text-muted-foreground">
        {formatDateTime(row.created_at)}
      </TableCell>
      <TableCell
        className="max-w-48 truncate font-medium text-foreground"
        title={row.workspace_name}
      >
        {row.workspace_name}
      </TableCell>
      <TableCell className="whitespace-nowrap text-foreground">
        {row.email}
      </TableCell>
      <TableCell className="min-w-40">
        <div className="text-compact text-foreground">{row.model}</div>
        <div
          className="mt-0.5 max-w-40 truncate font-mono text-meta text-faint-foreground"
          title={row.request_id}
        >
          {row.request_id}
        </div>
      </TableCell>
      <TableCell className="whitespace-nowrap text-foreground">
        {row.channel_name ?? ""}
      </TableCell>
      <TableCell className="font-mono text-compact text-muted-foreground">
        {row.thinking_depth ?? ""}
      </TableCell>
      <TableCell className="whitespace-nowrap">
        <Badge variant={status.variant}>
          <span className="size-1.5 rounded-full bg-current" aria-hidden />
          {status.label}
        </Badge>
      </TableCell>
      <TableCell className="whitespace-nowrap font-mono text-compact text-muted-foreground">
        {endpointLabel(row.api_format)}
      </TableCell>
      <TableCell className="whitespace-nowrap text-compact text-muted-foreground">
        {operationLabel(row.operation)}
      </TableCell>
      <TableCell className="text-right font-mono tabular-nums">
        {formatLatency(row.latency_ms)}
      </TableCell>
      <TableCell className="text-right font-mono tabular-nums">
        {formatGenerationSpeed(row.generation_speed_milli_tps)}
      </TableCell>
      <TableCell className="text-right font-mono tabular-nums">
        {formatUsageNumber(row.input_tokens)}
      </TableCell>
      <TableCell className="text-right font-mono tabular-nums">
        {formatUsageNumber(row.cached_input_tokens)}
      </TableCell>
      <TableCell className="text-right font-mono tabular-nums">
        {formatUsageNumber(row.output_tokens)}
      </TableCell>
      <TableCell className="text-right font-mono tabular-nums">
        {formatUsageNumber(row.reasoning_output_tokens)}
      </TableCell>
      <TableCell className="text-right font-mono tabular-nums">
        <div className="flex items-center justify-end gap-1.5">
          {formatYuan(row.charged_microfen)}
          {row.absorbed_microfen > 0 ? (
            <Badge
              variant="secondary"
              title={`平台封顶减免 ${formatYuan(row.absorbed_microfen)}`}
            >
              减免 {formatYuan(row.absorbed_microfen)}
            </Badge>
          ) : null}
        </div>
      </TableCell>
      <TableCell className="max-w-96 text-compact text-muted-foreground">
        <div title={row.error_class ?? undefined}>{row.error_class ?? "—"}</div>
        {row.upstream_error ? (
          <details className="mt-1">
            <summary className="cursor-pointer text-foreground">
              完整上游错误
            </summary>
            <pre className="mt-2 max-h-80 max-w-2xl overflow-auto rounded-md border border-border p-3 text-meta whitespace-pre-wrap text-foreground">
              {row.upstream_error}
            </pre>
          </details>
        ) : null}
      </TableCell>
    </TableRow>
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
  const [data, setData] = useState<AdminUsageData | null>(null)
  const [summary, setSummary] = useState<AdminUsageSummaryData | null>(null)
  const [loading, setLoading] = useState(false)
  const [draft, setDraft] = useState<UsageFilterDraft>(EMPTY_USAGE_DRAFT)
  const [filters, setFilters] = useState<AdminUsageFilters>(EMPTY_USAGE_FILTERS)
  const generationRef = useRef(0)

  const load = useCallback(
    (targetPage: number) => {
      const generation = ++generationRef.current
      setLoading(true)
      // The page and its aggregate read the same filtered window together, so
      // the strip and the rows can never disagree about what was measured.
      Promise.all([
        adminHttp.adminListAiRequests(targetPage, PAGE_SIZE, filters),
        adminHttp.adminAiUsageSummary(filters),
      ])
        .then(([next, nextSummary]) => {
          if (generation !== generationRef.current) return
          clearLive(ADMIN_USAGE_READ_LIVE)
          setData(next)
          setSummary(nextSummary)
          // The server clamps a page past the end, so the control reflects the
          // page actually returned rather than the one that was asked for.
          setPage(next.page)
        })
        .catch((reason) => {
          if (generation !== generationRef.current) return
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
    [filters],
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
      since: draft.period === "30d" ? undefined : sinceForPeriod(draft.period),
    })
  }

  function resetFilters() {
    setDraft(EMPTY_USAGE_DRAFT)
    setPage(1)
    setFilters(EMPTY_USAGE_FILTERS)
  }

  return (
    <div className="flex min-w-0 w-full flex-col gap-4">

      <PlatformAdminSurface
        toolbar={
          <>
            <PlatformAdminSearch
              value={draft.query}
              onChange={(query) =>
                setDraft((current) => ({ ...current, query }))
              }
              onSubmit={applyFilters}
              label="搜索 API 请求日志"
              placeholder="搜索 Workspace、邮箱、模型或请求 ID"
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
            <PeriodSelect
              value={draft.period}
              onChange={(period) =>
                setDraft((current) => ({ ...current, period }))
              }
              ariaLabel="按访问时间筛选"
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
                label="刷新 API 请求日志"
              />
            </span>
          </>
        }
      >
        {summary ? <UsageSummaryStrip data={summary} /> : null}
        {data && data.rows.length > 0 ? (
          <Table containerClassName="max-h-[40rem]" aria-busy={loading}>
            <TableHeader className="sticky top-0 z-10 bg-popover">
              <TableRow>
                <TableHead>访问时间</TableHead>
                <TableHead>Workspace</TableHead>
                <TableHead>用户邮箱</TableHead>
                <TableHead>模型 / 请求</TableHead>
                <TableHead>渠道</TableHead>
                <TableHead>思考深度</TableHead>
                <TableHead>状态</TableHead>
                <TableHead>端点</TableHead>
                <TableHead>操作</TableHead>
                <TableHead className="text-right">总延迟</TableHead>
                <TableHead className="text-right">生成速度</TableHead>
                <TableHead className="text-right">输入</TableHead>
                <TableHead className="text-right">缓存读取</TableHead>
                <TableHead className="text-right">输出</TableHead>
                <TableHead className="text-right">推理</TableHead>
                <TableHead className="text-right">费用</TableHead>
                <TableHead>错误信息</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.rows.map((row) => (
                <RequestRow key={row.request_id} row={row} />
              ))}
            </TableBody>
          </Table>
        ) : loading ? (
          <div className="p-4">
            <Skeleton className="h-80 w-full" />
          </div>
        ) : (
          <PlatformAdminEmpty
            icon={ScrollText}
            title={hasFilters ? "没有符合当前筛选条件的请求。" : "暂无 API 请求日志。"}
          />
        )}

        <PlatformAdminPagination
          page={page}
          pageCount={pageCount}
          total={data?.total_rows ?? 0}
          pageSize={PAGE_SIZE}
          busy={loading}
          onPage={setPage}
        />
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
  onSelectedChange,
  onCopy,
}: {
  row: AdminErrorLogView
  selected: boolean
  onSelectedChange: (selected: boolean) => void
  onCopy: () => void
}) {
  return (
    <TableRow data-state={selected ? "selected" : undefined}>
      <TableCell className="w-10 pr-0">
        <Checkbox
          checked={selected}
          aria-label={`选择错误日志 ${row.code}`}
          onCheckedChange={(checked) => onSelectedChange(checked === true)}
        />
      </TableCell>
      <TableCell className="w-12 px-2">
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                type="button"
                size="icon-xs"
                variant="ghost"
                aria-label={`复制错误日志 ${row.code}`}
                onClick={onCopy}
              />
            }
          >
            <Copy aria-hidden />
          </TooltipTrigger>
          <TooltipContent>复制此条</TooltipContent>
        </Tooltip>
      </TableCell>
      <TableCell className="whitespace-nowrap text-compact text-muted-foreground">
        {formatDateTime(row.received_at)}
      </TableCell>
      <TableCell className="whitespace-nowrap">{row.workspace_name}</TableCell>
      <TableCell className="whitespace-nowrap">{row.email}</TableCell>
      <TableCell className="whitespace-nowrap">
        <Badge variant="outline">{sourceLabel(row.source)}</Badge>
      </TableCell>
      <TableCell className="whitespace-nowrap">
        <div className="flex items-center gap-2">
          <span className="font-mono text-compact">{row.code}</span>
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
      <TableCell className="max-w-md whitespace-normal">
        {detailLabel(row)}
      </TableCell>
      <TableCell className="whitespace-nowrap">
        {row.fingerprint ? (
          <Badge variant="code" title={row.fingerprint}>
            {row.fingerprint.slice(0, 12)}
          </Badge>
        ) : null}
      </TableCell>
      <TableCell className="whitespace-nowrap">
        <Badge variant="code" title={row.device_uid}>
          {row.device_uid.slice(0, 8)}
        </Badge>
      </TableCell>
      <TableCell className="whitespace-nowrap text-compact text-muted-foreground">
        {row.app_version}
      </TableCell>
      <TableCell className="whitespace-nowrap text-compact text-muted-foreground">
        {row.os}
      </TableCell>
    </TableRow>
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
  const [data, setData] = useState<AdminErrorLogData | null>(null)
  const [loading, setLoading] = useState(false)
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
      adminHttp
        .adminListErrorLogs(targetPage, PAGE_SIZE, filters)
        .then((next) => {
          if (generation !== generationRef.current) return
          clearLive(ADMIN_ERRORS_READ_LIVE)
          setData(next)
          setPage(next.page)
          setSelectedKeys(new Set())
        })
        .catch((reason) => {
          if (generation !== generationRef.current) return
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
    [filters],
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
    if (selectedRows.length === 0) return
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
      since: draft.period === "30d" ? undefined : sinceForPeriod(draft.period),
    })
  }

  function resetFilters() {
    setDraft(EMPTY_ERROR_DRAFT)
    setPage(1)
    setFilters(EMPTY_ERROR_FILTERS)
  }

  return (
    <div className="flex min-w-0 w-full flex-col gap-4">

      <PlatformAdminSurface
        toolbar={
          <>
            <PlatformAdminSearch
              value={draft.query}
              onChange={(query) =>
                setDraft((current) => ({ ...current, query }))
              }
              onSubmit={applyFilters}
              label="搜索错误日志"
              placeholder="搜索 Workspace、邮箱、错误码或消息"
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
            <PeriodSelect
              value={draft.period}
              onChange={(period) =>
                setDraft((current) => ({ ...current, period }))
              }
              ariaLabel="按接收时间筛选"
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
        {selectedRows.length > 0 ? (
          <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-2.5 py-2">
            <span className="text-compact font-medium">
              已选择 {selectedRows.length} 条
            </span>
            <div className="flex flex-wrap items-center gap-2">
              <Button
                size="sm"
                variant="outline"
                disabled={deleting}
                onClick={() => void copyRows(selectedRows)}
              >
                <Copy aria-hidden />
                复制 {selectedRows.length} 条
              </Button>
              <Button
                size="sm"
                variant="destructive"
                disabled={deleting}
                onClick={() => setDeleteOpen(true)}
              >
                <Trash2 aria-hidden />
                删除 {selectedRows.length} 条
              </Button>
            </div>
          </div>
        ) : null}

        {data && data.rows.length > 0 ? (
          <Table containerClassName="max-h-[40rem]" aria-busy={loading}>
            <TableHeader className="sticky top-0 z-10 bg-popover">
              <TableRow>
                <TableHead className="w-10 pr-0">
                  <Checkbox
                    checked={allSelected}
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
                <TableHead className="w-12 px-2">
                  <span className="sr-only">复制</span>
                </TableHead>
                <TableHead>接收时间</TableHead>
                <TableHead>Workspace</TableHead>
                <TableHead>用户邮箱</TableHead>
                <TableHead>来源</TableHead>
                <TableHead>错误码</TableHead>
                <TableHead>详情</TableHead>
                <TableHead>指纹</TableHead>
                <TableHead>设备</TableHead>
                <TableHead>版本</TableHead>
                <TableHead>系统</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.rows.map((row) => (
                <ErrorRow
                  key={rowKey(row)}
                  row={row}
                  selected={selectedKeys.has(rowKey(row))}
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
        ) : loading ? (
          <div className="p-4">
            <Skeleton className="h-80 w-full" />
          </div>
        ) : (
          <PlatformAdminEmpty
            icon={TriangleAlert}
            title={hasFilters ? "没有符合当前筛选条件的错误。" : "暂无错误日志。"}
          />
        )}

        <PlatformAdminPagination
          page={page}
          pageCount={pageCount}
          total={data?.total_rows ?? 0}
          pageSize={PAGE_SIZE}
          busy={loading}
          onPage={setPage}
        />
      </PlatformAdminSurface>
      <ConfirmDialog
        open={deleteOpen}
        onOpenChange={setDeleteOpen}
        title={`删除 ${selectedRows.length} 条错误日志？`}
        description="删除后不可恢复。"
        confirmText="确认删除"
        busy={deleting}
        icon={<Trash2 aria-hidden />}
        onConfirm={deleteSelected}
      />
    </div>
  )
}

type LogTab = "requests" | "errors"

const LOG_TABS: { id: LogTab; label: string }[] = [
  { id: "requests", label: "API 请求" },
  { id: "errors", label: "错误" },
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
    <div className="flex min-w-0 w-full flex-col gap-4">
      <div
        role="tablist"
        aria-label="日志类型"
        className="flex shrink-0 items-center gap-1"
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
        <div hidden={tab !== "requests"}>
          <AdminUsageScreen />
        </div>
      ) : null}
      {visited.has("errors") ? (
        <div hidden={tab !== "errors"}>
          <AdminErrorsScreen />
        </div>
      ) : null}
    </div>
  )
}

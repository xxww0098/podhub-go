import { useEffect, useState } from "react"
import { ArrowLeft, ArrowRight, ExternalLink, RefreshCw } from "lucide-react"
import { loadTaskRecords, type TaskRecord, type TaskRecordQuery, type TaskRecordsPage } from "@/bindings/http-task-records"
import { PageToolbar } from "@/components/page-toolbar"
import { useScreenActive } from "@/components/screen-pane"
import { Button } from "@/components/ui/button"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet"
import { Spinner } from "@/components/ui/spinner"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { loadStoreRoster, useStoreRoster } from "@/features/stores/store-roster-cache"
import { errorMessage } from "@/lib/error-message"
import { formatDateTimeYearMinute } from "@/lib/format"

const KIND_LABELS = { listing: "商品上架", product_sync: "商品同步", media: "素材准备" } as const
const STATUS_LABELS = { active: "进行中", attention: "需处理", finished: "已处理", cancelled: "已取消" } as const
const STATE_LABELS: Record<string, string> = {
  queued: "排队中", submitting: "正在提交", running: "执行中", retry_wait: "等待重试",
  unknown: "待核对", uncertain: "待核对", accepted: "平台已受理", rejected: "已拒绝",
  failed: "执行失败", succeeded: "执行完成", cancelled: "已取消", reconciled: "已核对",
  conflict: "存在冲突", operator_attested: "人工已确认", superseded: "已释放",
}
const ERROR_LABELS: Record<string, string> = {
  OZON_RATE_LIMITED: "平台限流，等待重试",
  OZON_WRITES_DISABLED: "平台写入已关闭",
  OZON_STORE_PAUSED: "店铺已暂停",
  STORE_DAILY_CAP_REACHED: "已达店铺今日上架上限",
  STORE_MIN_SEND_GAP: "等待店铺发送间隔",
  OZON_RECONCILE_STILL_UNKNOWN: "平台结果仍未知，请打开原任务核对",
  OZON_ROW_REJECTED: "平台拒绝处理，请查看商品问题",
  STORE_CREDENTIAL_EXPIRED: "店铺授权已过期",
  STORE_CREDENTIAL_MISSING: "店铺尚未配置授权",
  OZON_CREDENTIAL_INVALID: "店铺授权无效",
}

export function taskStateLabel(state: string): string { return STATE_LABELS[state] ?? state }
function errorLabel(code: string): string { return ERROR_LABELS[code] ?? (code ? "任务有异常，请打开原任务核对" : "") }
function dateLabel(at: string | null): string {
  if (!at) return "—"
  const date = new Date(at)
  return Number.isFinite(date.getTime()) ? formatDateTimeYearMinute(date) : "时间未知"
}

export function TaskRecordsTable({ items, onInspect }: { items: readonly TaskRecord[]; onInspect: (item: TaskRecord) => void }) {
  return <Table aria-label="跨店任务记录">
    <TableHeader><TableRow>
      <TableHead>任务</TableHead><TableHead className="hidden sm:table-cell">店铺</TableHead><TableHead>状态</TableHead>
      <TableHead className="hidden lg:table-cell">最近更新</TableHead><TableHead className="text-right">操作</TableHead>
    </TableRow></TableHeader>
    <TableBody>{items.map((item) => <TableRow key={`${item.kind}:${item.id}`}>
      <TableCell className="min-w-28 max-w-80 whitespace-normal">
        <div className="break-words font-medium">{item.title}</div>
        <div className="text-xs text-muted-foreground">{KIND_LABELS[item.kind]}</div>
        <div className="text-xs text-muted-foreground sm:hidden">{item.store_name || "未绑定店铺"}</div>
        {item.error_code ? <p className="mt-1 text-xs text-destructive">{errorLabel(item.error_code)}</p> : null}
      </TableCell>
      <TableCell className="hidden max-w-48 whitespace-normal break-words sm:table-cell">{item.store_name || "未绑定店铺"}</TableCell>
      <TableCell className="whitespace-nowrap">{taskStateLabel(item.state)}</TableCell>
      <TableCell className="hidden text-xs tabular-nums lg:table-cell">{dateLabel(item.updated_at)}</TableCell>
      <TableCell className="text-right"><Button size="sm" variant="ghost" onClick={() => onInspect(item)} aria-label={`查看${item.title}的任务记录`}>查看</Button></TableCell>
    </TableRow>)}</TableBody>
  </Table>
}

export function TaskRecordsScreen({ workspaceId, onOpenListingCard, onOpenProducts }: {
  workspaceId?: number
  onOpenListingCard: (cardId: string) => void
  onOpenProducts: () => void
}) {
  const active = useScreenActive()
  const roster = useStoreRoster(workspaceId)
  const [filters, setFilters] = useState<TaskRecordQuery>({})
  const [cursors, setCursors] = useState<string[]>([])
  const [page, setPage] = useState<TaskRecordsPage | null>(null)
  const [loading, setLoading] = useState(true)
  const [failure, setFailure] = useState("")
  const [rosterFailure, setRosterFailure] = useState("")
  const [refresh, setRefresh] = useState(0)
  const [selected, setSelected] = useState<TaskRecord | null>(null)
  const cursor = cursors.at(-1)

  useEffect(() => {
    if (!active) return
    let cancelled = false
    void loadStoreRoster({ workspaceId }).then(() => {
      if (!cancelled) setRosterFailure("")
    }).catch((reason) => { if (!cancelled) setRosterFailure(errorMessage(reason, "店铺列表读取失败")) })
    return () => { cancelled = true }
  }, [workspaceId, active, refresh])

  useEffect(() => {
    if (!active) return
    const controller = new AbortController()
    setLoading(true)
    setFailure("")
    void loadTaskRecords({ ...filters, cursor }, controller.signal).then((next) => {
      if (!controller.signal.aborted) setPage(next)
    }).catch((reason) => {
      if (!controller.signal.aborted) setFailure(errorMessage(reason, "任务记录读取失败，请重试"))
    }).finally(() => { if (!controller.signal.aborted) setLoading(false) })
    return () => controller.abort()
  }, [workspaceId, active, filters, cursor, refresh])

  const changeFilter = (next: TaskRecordQuery) => {
    setFilters(next)
    setCursors([])
    setPage(null)
    setSelected(null)
  }
  const stores = roster?.overview.stores ?? []
  return <div className="flex min-h-0 flex-1 flex-col gap-2 p-3">
    <h1 className="sr-only">任务记录</h1>
    <PageToolbar primary={<>
      <Select value={filters.storeId ?? "all"} onValueChange={(value) => changeFilter({ ...filters, storeId: value && value !== "all" ? value : undefined })}>
        <SelectTrigger size="sm" className="min-w-44" aria-label="任务店铺"><SelectValue>{() => stores.find((store) => store.cloud_store_uuid === filters.storeId)?.label ?? "全部店铺"}</SelectValue></SelectTrigger>
        <SelectContent><SelectItem value="all">全部店铺</SelectItem>{stores.filter((store) => store.cloud_store_uuid).map((store) => <SelectItem key={store.cloud_store_uuid} value={store.cloud_store_uuid!}>{store.label || "未命名店铺"}</SelectItem>)}</SelectContent>
      </Select>
      <Select value={filters.kind ?? "all"} onValueChange={(value) => changeFilter({ ...filters, kind: value && value !== "all" ? value as TaskRecordQuery["kind"] : undefined })}>
        <SelectTrigger size="sm" className="min-w-32" aria-label="任务类型"><SelectValue>{() => filters.kind ? KIND_LABELS[filters.kind] : "全部类型"}</SelectValue></SelectTrigger>
        <SelectContent><SelectItem value="all">全部类型</SelectItem>{Object.entries(KIND_LABELS).map(([value, label]) => <SelectItem key={value} value={value}>{label}</SelectItem>)}</SelectContent>
      </Select>
      <Select value={filters.status ?? "all"} onValueChange={(value) => changeFilter({ ...filters, status: value && value !== "all" ? value as TaskRecordQuery["status"] : undefined })}>
        <SelectTrigger size="sm" className="min-w-32" aria-label="任务状态"><SelectValue>{() => filters.status ? STATUS_LABELS[filters.status] : "全部状态"}</SelectValue></SelectTrigger>
        <SelectContent><SelectItem value="all">全部状态</SelectItem>{Object.entries(STATUS_LABELS).map(([value, label]) => <SelectItem key={value} value={value}>{label}</SelectItem>)}</SelectContent>
      </Select>
      <Button size="sm" variant="outline" disabled={loading} onClick={() => setRefresh((value) => value + 1)}><RefreshCw aria-hidden />刷新</Button>
    </>} />
    {failure || rosterFailure ? <div role="alert" className="flex flex-wrap items-center gap-2 text-sm text-destructive">
      {failure || rosterFailure}{page && failure ? "，显示上次读取结果" : ""}
      <Button size="sm" variant="outline" onClick={() => setRefresh((value) => value + 1)}>重试</Button>
    </div> : null}
    <div className="min-h-0 flex-1 overflow-auto" aria-busy={loading}>
      {page?.items.length ? <TaskRecordsTable items={page.items} onInspect={setSelected} />
        : loading ? <div className="flex min-h-40 items-center justify-center gap-2 text-sm text-muted-foreground"><Spinner aria-label="正在读取任务记录" />正在读取…</div>
          : !failure ? <p className="p-6 text-sm text-muted-foreground">没有符合条件的任务记录</p> : null}
    </div>
    <div className="flex flex-wrap items-center justify-end gap-2">
      <span className="text-sm text-muted-foreground" aria-live="polite">第 {cursors.length + 1} 页{page ? ` · ${page.items.length} 条` : ""}</span>
      <Button size="sm" variant="outline" disabled={loading || cursors.length === 0} onClick={() => { setCursors((values) => values.slice(0, -1)); setSelected(null) }}><ArrowLeft aria-hidden />上一页</Button>
      <Button size="sm" variant="outline" disabled={loading || !!failure || !page?.next_cursor} onClick={() => { if (page?.next_cursor) setCursors((values) => [...values, page.next_cursor!]); setSelected(null) }}>下一页<ArrowRight aria-hidden /></Button>
    </div>
    <Sheet open={active && selected !== null} onOpenChange={(open) => { if (!open) setSelected(null) }}>
      <SheetContent size="detail" aria-label="任务记录详情">
        <SheetHeader><SheetTitle>{selected?.title ?? "任务记录"}</SheetTitle></SheetHeader>
        {selected ? <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-auto px-4 pb-4">
          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-3 text-sm">
            <dt className="text-muted-foreground">类型</dt><dd>{KIND_LABELS[selected.kind]}</dd>
            <dt className="text-muted-foreground">店铺</dt><dd>{selected.store_name || "未绑定店铺"}</dd>
            <dt className="text-muted-foreground">状态</dt><dd>{taskStateLabel(selected.state)}</dd>
            <dt className="text-muted-foreground">创建</dt><dd>{dateLabel(selected.created_at)}</dd>
            <dt className="text-muted-foreground">更新</dt><dd>{dateLabel(selected.updated_at)}</dd>
            {selected.next_attempt_at ? <><dt className="text-muted-foreground">下次检查</dt><dd>{dateLabel(selected.next_attempt_at)}</dd></> : null}
            {selected.external_task_id ? <><dt className="text-muted-foreground">平台任务</dt><dd className="break-all">{selected.external_task_id}</dd></> : null}
          </dl>
          {selected.error_code ? <p className="text-sm text-destructive">{errorLabel(selected.error_code)}<span className="mt-1 block break-all text-xs">{selected.error_code}</span></p> : null}
          {selected.kind === "listing" ? <p className="text-sm text-muted-foreground">平台受理后仍需核对审核与商品状态。结果未知时，先核对再决定下一步。</p> : null}
          {selected.card_id ? <Button onClick={() => { setSelected(null); onOpenListingCard(selected.card_id!); }}><ExternalLink aria-hidden />打开上架方案</Button>
            : selected.kind === "product_sync" ? <Button onClick={() => { setSelected(null); onOpenProducts(); }}><ExternalLink aria-hidden />查看店铺商品</Button>
              : <p className="text-sm text-muted-foreground">原上架方案已不可用，保留任务记录供核对。</p>}
        </div> : null}
      </SheetContent>
    </Sheet>
  </div>
}

import { useEffect, useId, useState, type ReactNode } from "react"
import { ArrowDown, ArrowUp, CircleHelp, Eye, EyeOff, Plus, RefreshCw, RotateCcw, Save, Trash2 } from "lucide-react"

import {
  adminHttp,
  type CatalogFetchConfigData,
  type CatalogFetchConfigWriteRequest,
} from "@/bindings/http-admin"
import { StateChip } from "@/components/state-chip"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { IconButton } from "@/components/ui/icon-button"
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { InputGroup, InputGroupAddon, InputGroupButton, InputGroupInput } from "@/components/ui/input-group"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Spinner } from "@/components/ui/spinner"
import { Switch } from "@/components/ui/switch"
import { clearLive, notifyCommandError, notifyLive, notifySuccess } from "@/lib/notify"
import type { StateTone } from "@/lib/receipt-state"
import { cn } from "@/lib/utils"

/**
 * SuperAdmin-only 平台管理 → 类目 pane: Ozon's ordered Seller keys and daily
 * schedule.
 *
 * Three facts shape the whole screen. The Api-Key is write-only — Cloud answers
 * `apiKeyConfigured` per key and never the key itself — so an empty field means
 * "keep the stored one for this Client-Id", and the placeholder is the only
 * place that can say so. The schedule is wall-clock *in the configured offset*:
 * every instant is rendered through that offset, never through the browser's
 * zone, because 03:00 has to mean 03:00 where the operator is rather than where
 * this tab happens to be. And the list order is the failover order: the first
 * key that downloads the tree ends the run. Cloud is the authority for all
 * three; this pane only states them.
 */

type ConfigView = CatalogFetchConfigData
type ConfigRequest = CatalogFetchConfigWriteRequest

const CONFIG_LIVE = "catalog-fetch-config"

/**
 * A claimed run outlives any request: the POST only starts it, and the pane
 * polls the config view until `running` clears. Three seconds is cheap enough
 * for a read the pane would make anyway, and the interval's own lifetime is
 * bounded by the run's 5-minute lease.
 */
const RUN_POLL_MS = 3_000

/** The failover ceiling, matching the server's bound and the table's CHECK. */
const MAX_KEYS = 8


/** A time field and a minute-of-day are two spellings of the same value. */
export function minuteOfDayFromTimeInput(value: string): number | null {
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(value.trim())
  if (!match) return null
  return Number(match[1]) * 60 + Number(match[2])
}

export function timeInputFromMinuteOfDay(minute: number): string {
  const bounded = Math.min(1439, Math.max(0, Math.round(minute)))
  const hours = String(Math.floor(bounded / 60)).padStart(2, "0")
  const minutes = String(bounded % 60).padStart(2, "0")
  return hours + ":" + minutes
}

/** "UTC+8" / "UTC-5:30": the label every rendered instant carries. */
export function formatOffset(utcOffsetMinutes: number): string {
  const sign = utcOffsetMinutes < 0 ? "-" : "+"
  const absolute = Math.abs(utcOffsetMinutes)
  const hours = Math.floor(absolute / 60)
  const minutes = absolute % 60
  if (minutes === 0) return "UTC" + sign + hours
  return "UTC" + sign + hours + ":" + String(minutes).padStart(2, "0")
}

/**
 * One instant as the wall clock of the configured offset.
 *
 * The shift-then-read-as-UTC is the point: formatting the instant in the
 * browser's own zone would move a 03:00 run to whatever this machine believes
 * local time is.
 */
export function formatLocalDateTime(ms: number, utcOffsetMinutes: number): string {
  const wallClock = new Intl.DateTimeFormat("zh-CN", {
    timeZone: "UTC",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date(ms + utcOffsetMinutes * 60_000))
  return wallClock.replace(/\//g, "-") + " " + formatOffset(utcOffsetMinutes)
}

/** One editable key row. `apiKey` is always a fresh draft, never a stored value. */
export type CategoryFetchKeyDraft = {
  clientId: string
  apiKey: string
  /**
   * Cloud retired this credential after Ozon refused it. Display-only — the
   * write request never carries it, and a freshly typed Api-Key re-enables.
   */
  disabled: boolean
}

/** The editable form. `keys` order is the failover order. */
export type CategoryFetchDraft = {
  enabled: boolean
  scheduleMode: ConfigView["schedule_mode"]
  atMinute: string
  windowStartMinute: string
  windowEndMinute: string
  utcOffsetMinutes: number
  keys: CategoryFetchKeyDraft[]
}

/** An empty configuration offers the first key without adding it until edited. */
export function updateCategoryKey(draft: CategoryFetchDraft, index: number, patch: Partial<CategoryFetchKeyDraft>): CategoryFetchDraft {
  if (draft.keys.length === 0 && index === 0) {
    return { ...draft, keys: [{ clientId: "", apiKey: "", disabled: false, ...patch }] }
  }
  return { ...draft, keys: draft.keys.map((key, at) => (at === index ? { ...key, ...patch } : key)) }
}

/** The Client-Ids the server already holds a sealed Api-Key for. */
export function configuredClientIds(view: ConfigView): ReadonlySet<string> {
  return new Set(view.keys.filter((key) => key.api_key_configured).map((key) => key.client_id))
}

export function draftFromView(view: ConfigView): CategoryFetchDraft {
  return {
    enabled: view.enabled,
    scheduleMode: view.schedule_mode,
    atMinute: timeInputFromMinuteOfDay(view.at_minute),
    windowStartMinute: timeInputFromMinuteOfDay(view.window_start_minute),
    windowEndMinute: timeInputFromMinuteOfDay(view.window_end_minute),
    utcOffsetMinutes: view.utc_offset_minutes,
    keys: view.keys.map((key) => ({
      clientId: key.client_id,
      apiKey: "",
      disabled: key.disabled,
    })),
  }
}

/**
 * The write request, or null when a time field is not a real time.
 *
 * A cleared time input must never be submitted as 00:00 by accident, so the
 * refusal lives here rather than in each caller: the save button reads the same
 * function, and Cloud re-validates every bound anyway.
 */
export function requestFromDraft(draft: CategoryFetchDraft): ConfigRequest | null {
  const atMinute = minuteOfDayFromTimeInput(draft.atMinute)
  const windowStartMinute = minuteOfDayFromTimeInput(draft.windowStartMinute)
  const windowEndMinute = minuteOfDayFromTimeInput(draft.windowEndMinute)
  if (atMinute === null || windowStartMinute === null || windowEndMinute === null) {
    return null
  }
  return {
    enabled: draft.enabled,
    schedule_mode: draft.scheduleMode,
    at_minute: atMinute,
    window_start_minute: windowStartMinute,
    window_end_minute: windowEndMinute,
    utc_offset_minutes: draft.utcOffsetMinutes,
    keys: draft.keys.map((key) => ({
      client_id: key.clientId.trim(),
      api_key: key.apiKey.trim(),
    })),
  }
}

/**
 * Whether the draft may be submitted. The same rules Cloud enforces, so the
 * button explains itself instead of collecting a 400: a real time in both
 * modes, an advancing window, and at most [MAX_KEYS] unique, usable rows.
 * Even a paused configuration must supply a secret for each new Client-Id.
 * An enabled schedule also needs at least one non-retired credential.
 */
export function draftError(
  draft: CategoryFetchDraft,
  view: ConfigView,
): string | null {
  const request = requestFromDraft(draft)
  if (!request) return "请填写有效的执行时间。"
  if (request.window_end_minute <= request.window_start_minute) {
    return "随机时间窗口的结束时间须晚于开始时间。"
  }
  if (draft.keys.length > MAX_KEYS) return `最多配置 ${MAX_KEYS} 把密钥。`
  const saved = new Map(view.keys.map((key) => [key.client_id, key]))
  const seen = new Set<string>()
  let activeKeys = 0
  for (const key of draft.keys) {
    const clientId = key.clientId.trim()
    const apiKey = key.apiKey.trim()
    if (clientId.length === 0) return "请填写每把密钥的 Client-Id。"
    if (clientId.length > 256 || apiKey.length > 8192) return "Client-Id 或 Api-Key 超出长度限制。"
    if (seen.has(clientId)) return "Client-Id 不能重复。"
    seen.add(clientId)
    const stored = saved.get(clientId)
    if (!apiKey && !stored?.api_key_configured) return "新 Client-Id 必须填写 Api-Key。"
    if (apiKey || (stored?.api_key_configured && !stored.disabled)) activeKeys++
  }
  if (draft.enabled && activeKeys === 0) return "启用每日抓取前，请填写至少一把可用密钥。"
  return null
}

export function draftIsSubmittable(draft: CategoryFetchDraft, view: ConfigView): boolean {
  return draftError(draft, view) === null
}

const OFFSETS = [
  { value: "480", label: "UTC+8 北京" },
  { value: "540", label: "UTC+9 东京" },
  { value: "420", label: "UTC+7 曼谷" },
  { value: "0", label: "UTC+0" },
  { value: "-300", label: "UTC-5 纽约" },
  { value: "-480", label: "UTC-8 洛杉矶" },
] as const

type RunState = { tone: StateTone; label: string }

function hasUsableKey(view: ConfigView): boolean {
  return view.keys.some((key) => key.api_key_configured && !key.disabled)
}

/** The one-line state the pane leads with, before any control. */
function stateOf(view: ConfigView): RunState {
  if (view.running) return { tone: "flight", label: "抓取中" }
  if (view.keys.length === 0) return { tone: "attest", label: "待配置密钥" }
  if (!hasUsableKey(view)) return { tone: "bad", label: "无可用密钥" }
  if (view.last_status === "failed") return { tone: "bad", label: "上次抓取失败" }
  if (view.enabled) return { tone: "good", label: "每日抓取已启用" }
  return { tone: "idle", label: "仅手动抓取" }
}

/** Which key the last run ended on: the one that served it, or the last tried. */
function lastKeyFact(view: ConfigView): string {
  if (!view.last_run_at_ms) return "—"
  if (view.last_status === "failed") return `已试 ${view.last_key_attempts} 把`
  return view.last_key_client_id ?? "—"
}

/**
 * 坐标时效汇总 → 摘要徽标。前端只渲染后端计数，不重算年龄——24h/72h 阈值
 * 的唯一出口是 `catalog_freshness`（口径 8）。旧版 Cloud 未带
 * `coordinateFreshness` 字段时不显示；没有引用坐标（total=0）时也没有
 * 可汇总的对象，同样不显示。
 */
export function coordinateFreshnessBadge(
  freshness: ConfigView["coordinate_freshness"] | undefined,
): { tone: StateTone; label: string } | null {
  if (!freshness || freshness.total <= 0) return null
  if (freshness.stale + freshness.expired + freshness.missing > 0) {
    // expired/missing 的行当前就过不了上架门（fail-closed），比「该刷了」更重。
    const tone: StateTone =
      freshness.expired > 0 || freshness.missing > 0 ? "bad" : "attest"
    return {
      tone,
      label: `${freshness.stale} 个类目超过 24h 未刷新，${freshness.expired} 个已过期，${freshness.missing} 个缺失`,
    }
  }
  return { tone: "good", label: `类目数据新鲜（${freshness.total} 个）` }
}

/** The verdict of a run the poll watched record, told once. */
function reportRunResult(view: ConfigView) {
  if (view.last_status === "failed") {
    notifyCommandError(undefined, "类目抓取失败，请检查平台密钥后重试。")
  } else if (view.last_status === "ok") {
    notifySuccess(`类目抓取成功 · Client-Id ${view.last_key_client_id ?? "未知"}`, {
      description: `共尝试 ${view.last_key_attempts} 把密钥，抓取 ${view.last_root_nodes ?? "未知"} 个一级类目，用时 ${view.last_duration_ms ?? "未知"} ms。`,
    })
  } else {
    notifyCommandError(undefined, "抓取结果未确认，请刷新后核对。")
  }
}
/** One bordered surface with a muted header strip: the shape every block in this pane shares. */
function Section({
  title,
  description,
  aside,
  inset = false,
  children,
}: {
  title: string
  description?: string
  aside?: ReactNode
  inset?: boolean
  children: ReactNode
}) {
  const headingId = useId()
  return (
    <section aria-labelledby={headingId} className={cn("min-w-0", inset ? "border-b border-border" : "overflow-hidden rounded-xl border border-border bg-card")}>
      <header className={cn("flex flex-wrap items-center justify-between gap-x-3 gap-y-1.5 px-5 py-2.5", !inset && "border-b border-border bg-muted/40")}>
        <div className="min-w-0 flex-1 basis-56">
          <h3 id={headingId} className="text-compact font-medium text-foreground">{title}</h3>
          {description ? <p className="mt-0.5 text-meta text-muted-foreground">{description}</p> : null}
        </div>
        {aside}
      </header>
      {children}
    </section>
  )
}

/** A label above a value, for the status grid. */
function Fact({ label, mono = false, children }: { label: string; mono?: boolean; children: ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="text-meta text-muted-foreground">{label}</dt>
      <dd className={cn("mt-0.5 truncate text-compact font-medium tabular-nums text-foreground", mono && "font-mono")}>
        {children}
      </dd>
    </div>
  )
}

/** One schedule line: wording left, control right, wrapping under it when narrow. */
function ConfigRow({
  label,
  htmlFor,
  hint,
  controlClassName,
  children,
}: {
  label: string
  htmlFor?: string
  hint?: string
  controlClassName?: string
  children: ReactNode
}) {
  return (
    <div className="grid gap-x-4 gap-y-2 px-5 py-3 sm:grid-cols-[10rem_minmax(0,1fr)] sm:items-start">
      <div className="min-w-0 sm:pt-2">
        {htmlFor ? (
          <FieldLabel htmlFor={htmlFor}>
            {label}
          </FieldLabel>
        ) : (
          <p className="text-compact font-medium text-foreground">{label}</p>
        )}
      </div>
      <div className={cn("min-w-0", controlClassName)}>
        {children}
        {hint ? <p className="mt-1 text-meta text-muted-foreground">{hint}</p> : null}
      </div>
    </div>
  )
}

/** The run's standing: lead state, counts, and the last run's verdict. */
function RunStatus({ view, state }: { view: ConfigView; state: RunState }) {
  const freshness = coordinateFreshnessBadge(view.coordinate_freshness)
  const disabledKeys = view.keys.filter((key) => key.disabled).length
  const at = (ms: number | null | undefined) =>
    ms ? formatLocalDateTime(ms, view.utc_offset_minutes) : "—"
  return (
    <header className="flex flex-wrap items-center gap-2 px-5 py-3">
      <h3 className="mr-auto text-base font-semibold text-foreground">类目抓取配置</h3>
      <span className="text-meta text-muted-foreground">当前状态</span>
      <StateChip tone={state.tone} label={state.label} status={state.tone} />
      {freshness ? (
        <StateChip tone={freshness.tone} label={freshness.label} status={freshness.tone} className="h-auto min-h-5.5 whitespace-normal py-0.5" />
      ) : null}
      {view.failure_streak > 0 ? (
        <Badge variant="destructive">连续失败 {view.failure_streak} 次</Badge>
      ) : null}
      <details className="relative">
        <summary aria-label="查看抓取状态" className="flex size-8 cursor-pointer list-none items-center justify-center rounded-md text-muted-foreground hover:bg-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring [&::-webkit-details-marker]:hidden">
          <CircleHelp aria-hidden className="size-4" />
        </summary>
        <div className="absolute right-0 z-20 mt-1 w-80 max-w-[80vw] rounded-lg border border-border bg-card p-4 shadow-lg">
          <dl className="grid grid-cols-2 gap-x-4 gap-y-3">
            <Fact label="平台密钥" mono>
              {view.keys.length} 把
              {disabledKeys > 0 ? (
                <span className="ml-2 font-sans font-normal text-st-bad">已禁用 {disabledKeys} 把</span>
              ) : null}
            </Fact>
            <Fact label="下次抓取" mono>{at(view.next_run_at_ms)}</Fact>
            <Fact label="上次抓取" mono>{at(view.last_run_at_ms)}</Fact>
            <Fact label="上次使用密钥" mono={view.last_status !== "failed"}>{lastKeyFact(view)}</Fact>
          </dl>
          <div className="mt-3 flex flex-wrap items-center gap-x-5 gap-y-2 border-t border-border pt-3 text-compact text-muted-foreground">
            {view.last_run_at_ms ? (
              <>
                {view.last_status === "failed" ? (
                  <Badge variant="destructive">失败</Badge>
                ) : view.last_status === "ok" ? (
                  <Badge variant="good">成功</Badge>
                ) : null}
                <span>上次耗时 <span className="font-mono tabular-nums text-foreground">{view.last_duration_ms ?? "—"} ms</span></span>
                <span>一级类目 <span className="font-mono tabular-nums text-foreground">{view.last_root_nodes ?? "—"}</span></span>
                <span className="tabular-nums">尝试 {view.last_key_attempts} 把</span>
              </>
            ) : (
              <span>还没有执行过抓取。保存密钥后可以「立即抓取」，或启用每日自动抓取。</span>
            )}
          </div>
        </div>
      </details>
    </header>
  )
}


export function PlatformCategoryFetchScreen({
  initialConfig,
}: {
  /** Test seam, the same one 对象存储 uses: paint a known row without a fetch. */
  initialConfig?: ConfigView
} = {}) {
  const [view, setView] = useState<ConfigView | undefined>(initialConfig)
  const [draft, setDraft] = useState<CategoryFetchDraft | undefined>(
    initialConfig ? draftFromView(initialConfig) : undefined,
  )
  const [visibleKey, setVisibleKey] = useState<number | null>(null)
  const [busy, setBusy] = useState(false)
  const [loadFailed, setLoadFailed] = useState(false)

  async function load() {
    clearLive(CONFIG_LIVE)
    setLoadFailed(false)
    try {
      const next = await adminHttp.catalogFetchConfig()
      setView(next)
      setDraft(draftFromView(next))
      setVisibleKey(null)
    } catch (reason) {
      setLoadFailed(true)
      notifyLive({
        id: CONFIG_LIVE,
        type: "error",
        reason,
        title: "无法读取类目抓取配置，请稍后重试。",
        action: { label: "重试", onClick: () => void load() },
      })
    }
  }

  useEffect(() => {
    // Mount-only: the retry action re-runs `load` itself, and a test seam that
    // already carries a row must not fetch over it.
    if (!initialConfig) void load()
    return () => clearLive(CONFIG_LIVE)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const running = view?.running ?? false

  useEffect(() => {
    if (!running) return
    // The run the pane may have opened onto is not necessarily the one it
    // started: `lastRunAtMs` is the baseline a *new* record has to advance.
    const baseline = view?.last_run_at_ms
    const timer = setInterval(async () => {
      try {
        const next = await adminHttp.catalogFetchConfig()
        setView(next)
        if (!next.running) {
          if (next.last_run_at_ms !== baseline) reportRunResult(next)
          else notifyCommandError(undefined, "抓取未上报结果，请稍后重试。")
        }
      } catch {
        // A failed read is not the run's verdict; the next tick asks again.
      }
    }, RUN_POLL_MS)
    return () => clearInterval(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [running])

  function update(patch: Partial<CategoryFetchDraft>) {
    setDraft((current) => (current ? { ...current, ...patch } : current))
  }

  function updateKey(index: number, patch: Partial<CategoryFetchKeyDraft>) {
    setDraft((current) => current ? updateCategoryKey(current, index, patch) : current)
  }

  function addKey() {
    setDraft((current) =>
      current && current.keys.length < MAX_KEYS
        ? { ...current, keys: [...current.keys, { clientId: "", apiKey: "", disabled: false }] }
        : current,
    )
  }

  function removeKey(index: number) {
    setVisibleKey(null)
    setDraft((current) =>
      current ? { ...current, keys: current.keys.filter((_, at) => at !== index) } : current,
    )
  }

  /** One step toward the front of the failover list. */
  function moveKey(index: number, delta: -1 | 1) {
    setVisibleKey(null)
    setDraft((current) => {
      if (!current) return current
      const target = index + delta
      if (target < 0 || target >= current.keys.length) return current
      const keys = [...current.keys]
      const [moved] = keys.splice(index, 1)
      keys.splice(target, 0, moved)
      return { ...current, keys }
    })
  }

  async function save() {
    if (!draft) return
    const request = requestFromDraft(draft)
    if (!request) return
    setBusy(true)
    try {
      const next = await adminHttp.saveCatalogFetchConfig(request)
      setView(next)
      setDraft(draftFromView(next))
      setVisibleKey(null)
      notifySuccess("类目抓取配置已保存", {
        description: next.enabled
          ? `下一次抓取：${next.next_run_at_ms ? formatLocalDateTime(next.next_run_at_ms, next.utc_offset_minutes) : "待安排"}`
          : "每日自动抓取已停止。",
      })
    } catch (reason) {
      notifyCommandError(reason, "无法保存类目抓取配置，请稍后重试。")
    } finally {
      setBusy(false)
    }
  }

  async function run() {
    setBusy(true)
    try {
      const next = await adminHttp.runCatalogFetch()
      setView(next)
      // A pre-poll Cloud still answered with the finished run; a claimed one
      // reports through the poll below instead. A claim that cleared without
      // advancing `lastRunAtMs` never reported at all.
      if (!next.running) {
        if (next.last_run_at_ms !== view?.last_run_at_ms) reportRunResult(next)
        else notifyCommandError(undefined, "抓取未上报结果，请稍后重试。")
      }
    } catch (reason) {
      notifyCommandError(reason, "立即抓取失败，请稍后重试。")
    } finally {
      setBusy(false)
    }
  }

  const state = view ? stateOf(view) : undefined
  const validationError = draft && view ? draftError(draft, view) : null
  const submittable = draft && view ? draftIsSubmittable(draft, view) : false
  return (
    <div className="flex w-full flex-col gap-3">
          {loadFailed && (!view || !draft) ? (
            <div className="flex min-h-48 items-center justify-center rounded-xl border border-border bg-card">
              <IconButton icon={RotateCcw} label="重试" variant="outline" onClick={() => void load()} />
            </div>
          ) : !view || !draft ? (
            <div className="grid min-h-48 place-items-center rounded-xl border border-border bg-card">
              <Spinner aria-label="正在读取类目抓取配置" />
            </div>
          ) : (
            <div className="min-w-0 overflow-hidden rounded-xl border border-border bg-card">
              {state ? <div className="border-b border-border"><RunStatus view={view} state={state} /></div> : null}

              <div className="min-w-0">
                <div className="min-w-0">
                  <Section
                    title="平台密钥"
                    description="按顺位依次尝试，成功即停止；被 Ozon 拒绝的密钥会自动禁用。"
                    inset
                    aside={
                      <Badge variant="code">
                        {draft.keys.length} / {MAX_KEYS}
                      </Badge>
                    }
                  >
                    <div className="px-5 pt-2">
                      <div className="min-w-0">
                        <div className="divide-y divide-border">
                          {(draft.keys.length ? draft.keys : [{ clientId: "", apiKey: "", disabled: false }]).map((key, index) => {
                            const stored = view.keys.find((item) => item.client_id === key.clientId.trim())
                            const configured = stored?.api_key_configured ?? false
                            const disabled = stored?.disabled ?? false
                            return (
                              <div
                                key={index}
                                data-disabled={disabled || undefined}
                                className={cn(
                                  "flex flex-col gap-3 py-3",
                                  disabled && "bg-muted/30 opacity-70",
                                )}
                              >
                                {draft.keys.length > 0 ? (
                                  <div className="flex flex-wrap items-center justify-between gap-2">
                                    <span className="flex flex-wrap items-center gap-2 text-compact font-medium text-foreground">
                                      第 {index + 1} 顺位
                                      {disabled ? (
                                        <StateChip tone="idle" status="disabled" label="已禁用" />
                                      ) : null}
                                    {configured ? (
                                      <Badge variant="good">Api-Key 已保存</Badge>
                                    ) : (
                                      <Badge variant="outline">Api-Key 未保存</Badge>
                                    )}
                                  </span>
                                  <div className="flex items-center gap-0.5">
                                    <IconButton
                                      icon={ArrowUp}
                                      label={`上移第 ${index + 1} 把密钥`}
                                      size="icon-sm"
                                      disabled={busy || index === 0}
                                      onClick={() => moveKey(index, -1)}
                                    />
                                    <IconButton
                                      icon={ArrowDown}
                                      label={`下移第 ${index + 1} 把密钥`}
                                      size="icon-sm"
                                      disabled={busy || index === draft.keys.length - 1}
                                      onClick={() => moveKey(index, 1)}
                                    />
                                    <IconButton
                                      icon={Trash2}
                                      label={`删除第 ${index + 1} 把密钥`}
                                      size="icon-sm"
                                      disabled={busy}
                                      onClick={() => removeKey(index)}
                                    />
                                  </div>
                                </div>
                                ) : null}
                                <div className="grid gap-3 sm:grid-cols-2">
                                  <Field>
                                    <FieldLabel htmlFor={`catalog-key-client-${index}`}>
                                      Client-Id
                                    </FieldLabel>
                                    <Input
                                      id={`catalog-key-client-${index}`}
                                      autoComplete="off"
                                      value={key.clientId}
                                      disabled={busy}
                                      placeholder="填写 Ozon Seller Client-Id"
                                      onChange={(event) =>
                                        updateKey(index, {
                                          clientId: event.target.value,
                                        })
                                      }
                                    />
                                  </Field>
                                  <Field>
                                    <FieldLabel htmlFor={`catalog-key-secret-${index}`}>
                                      Api-Key
                                    </FieldLabel>
                                    <InputGroup className="h-9">
                                      <InputGroupInput
                                        id={`catalog-key-secret-${index}`}
                                        type={visibleKey === index ? "text" : "password"}
                                        autoComplete="new-password"
                                        value={key.apiKey}
                                        disabled={busy}
                                        placeholder={configured ? "已保存，留空表示不修改" : "填写 Ozon Seller Api-Key"}
                                        onChange={(event) => updateKey(index, { apiKey: event.target.value })}
                                      />
                                      <InputGroupAddon align="inline-end">
                                        <InputGroupButton
                                          size="icon-xs"
                                          aria-label={`${visibleKey === index ? "隐藏" : "显示"}第 ${index + 1} 把 Api-Key`}
                                          aria-pressed={visibleKey === index}
                                          disabled={busy}
                                          onClick={() => setVisibleKey((current) => current === index ? null : index)}
                                        >
                                          {visibleKey === index ? <EyeOff aria-hidden /> : <Eye aria-hidden />}
                                        </InputGroupButton>
                                      </InputGroupAddon>
                                    </InputGroup>
                                  </Field>
                                  {disabled ? (
                                    <FieldDescription className="sm:col-span-2">
                                      已被 Ozon 拒绝，抓取时跳过；重新填写 Api-Key 并保存后重新启用。
                                    </FieldDescription>
                                  ) : null}
                                </div>
                              </div>
                            )
                          })}
                        </div>
                        <div
                          className={cn(
                            "flex flex-wrap items-center justify-between gap-x-4 gap-y-2 py-3",
                            draft.keys.length > 0 && "border-t border-border",
                          )}
                        >
                          <p className="min-w-0 flex-1 basis-56 text-meta text-muted-foreground">
                            {draft.keys.length === 0
                              ? "还没有配置平台密钥。添加后可手动抓取或启用每日计划。"
                              : "密钥只保存在服务端，读取时不会回显；重新填写即覆盖该 Client-Id 的密钥。"}
                          </p>
                          {draft.keys.length > 0 ? (
                            <Button
                              type="button"
                              variant="outline"
                              disabled={busy || draft.keys.length >= MAX_KEYS}
                              onClick={addKey}
                            >
                              <Plus data-icon="inline-start" aria-hidden />
                              添加密钥（最多 {MAX_KEYS} 把）
                            </Button>
                          ) : null}
                        </div>
                      </div>
                    </div>
                  </Section>
                </div>

                <div className="min-w-0">
                  <Section title="抓取计划" description="每天按所选时区执行，无需保持页面打开。" inset>
                    <div>
                      <ConfigRow label="时区" htmlFor="catalog-offset">
                        <Select
                          items={OFFSETS}
                          value={String(draft.utcOffsetMinutes)}
                          onValueChange={(next) => {
                            const offset = Number(next)
                            if (Number.isFinite(offset)) update({ utcOffsetMinutes: offset })
                          }}
                        >
                          <SelectTrigger id="catalog-offset" className="w-full">
                            <SelectValue placeholder="选择时区" />
                          </SelectTrigger>
                          <SelectContent>
                            {OFFSETS.map((row) => (
                              <SelectItem key={row.value} value={row.value}>
                                {row.label}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </ConfigRow>
                      <ConfigRow
                        label="每日自动抓取"
                        htmlFor="catalog-enabled"
                      >
                        <div className="flex items-center gap-2"><Switch
                          id="catalog-enabled"
                          checked={draft.enabled}
                          disabled={busy}
                          onCheckedChange={(enabled) => update({ enabled })}
                        /><span className="text-sm text-muted-foreground">{draft.enabled ? "开启" : "关闭"}</span></div>
                      </ConfigRow>
                      <ConfigRow
                        label="模式"
                        hint={
                          draft.scheduleMode === "fixed"
                            ? "每天在指定时间抓取。"
                            : "每天在时间窗口内随机执行，分散请求。"
                        }
                      >
                        <div className="grid max-w-sm grid-cols-2 gap-2" role="group" aria-label="抓取模式">
                          <Button
                            type="button"
                            variant={draft.scheduleMode === "fixed" ? "brand" : "outline"}
                            aria-pressed={draft.scheduleMode === "fixed"}
                            disabled={busy}
                            onClick={() => update({ scheduleMode: "fixed" })}
                          >
                            固定时间
                          </Button>
                          <Button
                            type="button"
                            variant={draft.scheduleMode === "random" ? "brand" : "outline"}
                            aria-pressed={draft.scheduleMode === "random"}
                            disabled={busy}
                            onClick={() => update({ scheduleMode: "random" })}
                          >
                            随机时间
                          </Button>
                        </div>
                      </ConfigRow>
                      {draft.scheduleMode === "fixed" ? (
                        <ConfigRow label="执行时间" htmlFor="catalog-at" controlClassName="max-w-60">
                          <Input
                            id="catalog-at"
                            type="time"
                            value={draft.atMinute}
                            disabled={busy}
                            aria-invalid={
                              minuteOfDayFromTimeInput(draft.atMinute) === null || undefined
                            }
                            onChange={(event) => update({ atMinute: event.target.value })}
                          />
                        </ConfigRow>
                      ) : (
                        <>
                          <ConfigRow label="窗口开始" htmlFor="catalog-window-start" controlClassName="max-w-60">
                            <Input
                              id="catalog-window-start"
                              type="time"
                              value={draft.windowStartMinute}
                              disabled={busy}
                              aria-invalid={
                                minuteOfDayFromTimeInput(draft.windowStartMinute) === null ||
                                undefined
                              }
                              onChange={(event) =>
                                update({
                                  windowStartMinute: event.target.value,
                                })
                              }
                            />
                          </ConfigRow>
                          <ConfigRow label="窗口结束" htmlFor="catalog-window-end" controlClassName="max-w-60">
                            <Input
                              id="catalog-window-end"
                              type="time"
                              value={draft.windowEndMinute}
                              disabled={busy}
                              aria-invalid={
                                minuteOfDayFromTimeInput(draft.windowEndMinute) === null ||
                                undefined
                              }
                              onChange={(event) =>
                                update({
                                  windowEndMinute: event.target.value,
                                })
                              }
                            />
                          </ConfigRow>
                        </>
                      )}
                    </div>
                  </Section>
                </div>
              </div>

              <div className="px-5 py-4">
                <h3 className="text-base font-semibold text-foreground">手动抓取</h3>
                <p className="mt-1 text-meta text-muted-foreground">配置密钥后，可手动抓取最新类目数据。</p>
                <div className="mt-3 flex flex-wrap items-center gap-2">
                  {validationError || !hasUsableKey(view) ? (
                    <p className="basis-full text-meta text-muted-foreground">
                      {validationError ?? "保存可用密钥后可立即抓取。"}
                    </p>
                  ) : null}
                  <Button
                    type="button"
                    variant="outline"
                    disabled={busy || running || !hasUsableKey(view)}
                    onClick={() => void run()}
                  >
                    <RefreshCw
                      data-icon="inline-start"
                      aria-hidden
                      className={running ? "animate-spin" : undefined}
                    />
                    {running ? "抓取中…" : "立即抓取"}
                  </Button>
                  <Button variant="brand" disabled={busy || !submittable} onClick={() => void save()}>
                    <Save data-icon="inline-start" aria-hidden />
                    保存配置
                  </Button>
                </div>
              </div>
            </div>
          )}
    </div>
  )
}

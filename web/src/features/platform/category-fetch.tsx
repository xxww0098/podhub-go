import { useEffect, useState } from "react"
import { ArrowDown, ArrowUp, Plus, RefreshCw, Save, Trash2 } from "lucide-react"

import {
  adminHttp,
  type CatalogFetchConfigData,
  type CatalogFetchConfigWriteRequest,
} from "@/bindings/http-admin"
import { PlatformAdminFact, PlatformAdminSurface } from "@/components/platform-admin-surface"
import { StateChip } from "@/components/state-chip"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Field, FieldDescription, FieldGroup, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Spinner } from "@/components/ui/spinner"
import { Switch } from "@/components/ui/switch"
import { Tabs, TabsContent, TabsIndicator, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { clearLive, notifyCommandError, notifyLive, notifySuccess } from "@/lib/notify"
import type { StateTone } from "@/lib/receipt-state"

/**
 * SuperAdmin-only 平台管理 → 类目 pane: Ozon's ordered Seller keys and daily
 * schedule, plus the platform-shared write-only WB Content API Token.
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
type PlatformTab = "ozon" | "wb"

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
  language: ConfigView["language"]
  keys: CategoryFetchKeyDraft[]
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
    language: view.language,
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
    language: draft.language,
    keys: draft.keys.map((key) => ({
      client_id: key.clientId.trim(),
      api_key: key.apiKey.trim(),
    })),
  }
}

/**
 * Whether the draft may be submitted. The same rules Cloud enforces, so the
 * button explains itself instead of collecting a 400: a real time in both
 * modes, an advancing window for `random`, at most [MAX_KEYS] rows whose
 * Client-Ids are non-empty and unique — and, only when the daily run is
 * switched on, at least one key that is either already stored or carries a
 * freshly typed Api-Key.
 */
export function draftIsSubmittable(
  draft: CategoryFetchDraft,
  configured: ReadonlySet<string>,
): boolean {
  const request = requestFromDraft(draft)
  if (!request) return false
  if (draft.scheduleMode === "random" && request.window_end_minute <= request.window_start_minute) {
    return false
  }
  if (draft.keys.length > MAX_KEYS) return false
  const seen = new Set<string>()
  for (const key of draft.keys) {
    const clientId = key.clientId.trim()
    if (clientId.length === 0 || seen.has(clientId)) return false
    seen.add(clientId)
  }
  if (!draft.enabled) return true
  if (draft.keys.length === 0) return false
  return draft.keys.every(
    (key) => configured.has(key.clientId.trim()) || key.apiKey.trim().length > 0,
  )
}

const OFFSETS = [
  { value: "480", label: "UTC+8 北京" },
  { value: "540", label: "UTC+9 东京" },
  { value: "420", label: "UTC+7 曼谷" },
  { value: "0", label: "UTC+0" },
  { value: "-300", label: "UTC-5 纽约" },
  { value: "-480", label: "UTC-8 洛杉矶" },
] as const

const LANGUAGES = [
  { value: "zh_hans", label: "中文" },
  { value: "ru", label: "俄文" },
  { value: "en", label: "英文" },
  { value: "tr", label: "土耳其文" },
  { value: "default", label: "默认（俄文）" },
] as const

/** The one-line state the pane leads with, before any control. */
function stateOf(view: ConfigView): {
  tone: StateTone
  label: string
} {
  if (view.running) return { tone: "flight", label: "抓取中" }
  if (view.keys.length === 0) return { tone: "idle", label: "待配置密钥" }
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
  } else {
    notifySuccess(`类目抓取成功 · Client-Id ${view.last_key_client_id ?? "未知"}`, {
      description: `共尝试 ${view.last_key_attempts} 把密钥，抓取 ${view.last_root_nodes ?? 0} 个一级类目，用时 ${view.last_duration_ms ?? 0} ms。`,
    })
  }
}

export function PlatformCategoryFetchScreen({
  initialConfig,
  initialTab = "ozon",
}: {
  /** Test seam, the same one 对象存储 uses: paint a known row without a fetch. */
  initialConfig?: ConfigView
  initialTab?: PlatformTab
} = {}) {
  const [view, setView] = useState<ConfigView | undefined>(initialConfig)
  const [draft, setDraft] = useState<CategoryFetchDraft | undefined>(
    initialConfig ? draftFromView(initialConfig) : undefined,
  )
  const [tab, setTab] = useState<PlatformTab>(initialTab)
  const [wbToken, setWbToken] = useState("")
  const [busy, setBusy] = useState(false)
  // Keep the settings pane usable while Cloud and the SPA roll out separately.
  const wbCredential = view?.wb_credential ?? {
    configured: false,
    credential_revision: 0,
    last_verified_at_ms: null,
  }

  async function load() {
    clearLive(CONFIG_LIVE)
    try {
      const next = await adminHttp.catalogFetchConfig()
      setView(next)
      setDraft(draftFromView(next))
      setWbToken("")
    } catch (reason) {
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
    setDraft((current) => {
      if (!current) return current
      return {
        ...current,
        keys: current.keys.map((key, at) => (at === index ? { ...key, ...patch } : key)),
      }
    })
  }

  function addKey() {
    setDraft((current) =>
      current && current.keys.length < MAX_KEYS
        ? { ...current, keys: [...current.keys, { clientId: "", apiKey: "", disabled: false }] }
        : current,
    )
  }

  function removeKey(index: number) {
    setDraft((current) =>
      current ? { ...current, keys: current.keys.filter((_, at) => at !== index) } : current,
    )
  }

  /** One step toward the front of the failover list. */
  function moveKey(index: number, delta: -1 | 1) {
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

  async function saveWbCredential() {
    if (!view) return
    const token = wbToken.trim()
    if (token.length === 0) return
    setBusy(true)
    try {
      const savedCredential = await adminHttp.saveCatalogFetchWbCredential({
        token,
        expected_credential_revision: wbCredential.credential_revision,
      })
      setView((current) => (current ? { ...current, wbCredential: savedCredential } : current))
      setWbToken("")
      notifySuccess("WB Content API Token 已验证并保存")
    } catch (reason) {
      notifyCommandError(reason, "WB Content API Token 验证或保存失败，请检查后重试。")
    } finally {
      setBusy(false)
    }
  }

  const state = view ? stateOf(view) : undefined
  const freshnessBadge = view
    ? coordinateFreshnessBadge(view.coordinate_freshness)
    : null
  const submittable = draft
    ? draftIsSubmittable(draft, view ? configuredClientIds(view) : new Set())
    : false
  const summary =
    tab === "ozon" && view && state ? (
      <div className="flex w-full flex-wrap items-center gap-x-4 gap-y-1">
        <span className="flex items-center gap-1.5">
          平台密钥：
          <strong className="font-mono text-foreground">{view.keys.length} 把</strong>
        </span>
        {view.keys.some((key) => key.disabled) ? (
          <span className="text-st-bad">
            已禁用 {view.keys.filter((key) => key.disabled).length} 把
          </span>
        ) : null}
        <StateChip tone={state.tone} label={state.label} status={state.tone} />
        <PlatformAdminFact
          label="下次抓取"
          value={
            view.next_run_at_ms ? formatLocalDateTime(view.next_run_at_ms, view.utc_offset_minutes) : "—"
          }
        />
        <PlatformAdminFact
          label="上次抓取"
          value={
            view.last_run_at_ms ? formatLocalDateTime(view.last_run_at_ms, view.utc_offset_minutes) : "—"
          }
        />
        <PlatformAdminFact label="上次使用密钥" value={lastKeyFact(view)} />
        {freshnessBadge ? (
          <StateChip
            tone={freshnessBadge.tone}
            label={freshnessBadge.label}
            status={freshnessBadge.tone}
          />
        ) : null}
        {view.failure_streak > 0 ? (
          <span className="text-st-bad">连续失败 {view.failure_streak} 次</span>
        ) : null}
      </div>
    ) : tab === "wb" && view ? (
      <div className="flex w-full flex-wrap items-center gap-x-4 gap-y-1">
        <span>WB Content API Token</span>
        <StateChip
          tone={wbCredential.configured ? "good" : "idle"}
          label={wbCredential.configured ? "已托管" : "未配置"}
          status={wbCredential.configured ? "configured" : "unconfigured"}
        />
        <PlatformAdminFact
          label="最近验证"
          value={
            wbCredential.last_verified_at_ms != null
              ? formatLocalDateTime(wbCredential.last_verified_at_ms, view.utc_offset_minutes)
              : "—"
          }
        />
      </div>
    ) : undefined

  return (
    <div className="flex w-full flex-col gap-4">
      <Tabs
        value={tab}
        onValueChange={(value) => setTab(value as PlatformTab)}
        className="w-full gap-4"
      >
        <TabsList variant="line" aria-label="类目抓取平台" className="w-fit">
          <TabsIndicator variant="line" />
          <TabsTrigger value="ozon" variant="line">
            Ozon
          </TabsTrigger>
          <TabsTrigger value="wb" variant="line">
            WB
          </TabsTrigger>
        </TabsList>
        <TabsContent value={tab} className="min-w-0">
          <PlatformAdminSurface summary={summary}>
            {!view || !draft ? (
              <div className="grid min-h-48 place-items-center">
                <Spinner aria-label="正在读取类目抓取配置" />
              </div>
            ) : tab === "ozon" ? (
              <>
                <div className="grid items-start gap-4 p-4 xl:grid-cols-2">
                  <Card>
                    <CardHeader>
                      <CardTitle>平台密钥</CardTitle>
                      <CardDescription>
                        按顺位依次尝试，成功即停止；被 Ozon 拒绝的密钥会自动禁用。
                      </CardDescription>
                    </CardHeader>
                    <CardContent>
                      <FieldGroup>
                        {draft.keys.map((key, index) => {
                          const configured = configuredClientIds(view).has(key.clientId.trim())
                          return (
                            <div
                              key={index}
                              data-disabled={key.disabled || undefined}
                              className={
                                key.disabled
                                  ? "flex flex-col gap-2 rounded-lg border border-dashed border-border p-3 opacity-70"
                                  : "flex flex-col gap-2 rounded-lg border border-border p-3"
                              }
                            >
                              <div className="flex items-center justify-between gap-2">
                                <span className="flex items-center gap-2 text-meta text-muted-foreground">
                                  第 {index + 1} 顺位
                                  {key.disabled ? (
                                    <StateChip tone="idle" status="disabled" label="已禁用" />
                                  ) : null}
                                </span>
                                <div className="flex items-center gap-0.5">
                                  <Button
                                    type="button"
                                    variant="ghost"
                                    size="icon-sm"
                                    aria-label={`上移第 ${index + 1} 把密钥`}
                                    disabled={busy || index === 0}
                                    onClick={() => moveKey(index, -1)}
                                  >
                                    <ArrowUp aria-hidden />
                                  </Button>
                                  <Button
                                    type="button"
                                    variant="ghost"
                                    size="icon-sm"
                                    aria-label={`下移第 ${index + 1} 把密钥`}
                                    disabled={busy || index === draft.keys.length - 1}
                                    onClick={() => moveKey(index, 1)}
                                  >
                                    <ArrowDown aria-hidden />
                                  </Button>
                                  <Button
                                    type="button"
                                    variant="ghost"
                                    size="icon-sm"
                                    aria-label={`删除第 ${index + 1} 把密钥`}
                                    disabled={busy}
                                    onClick={() => removeKey(index)}
                                  >
                                    <Trash2 aria-hidden />
                                  </Button>
                                </div>
                              </div>
                              <Field>
                                <FieldLabel htmlFor={`catalog-key-client-${index}`}>
                                  Client-Id
                                </FieldLabel>
                                <Input
                                  id={`catalog-key-client-${index}`}
                                  autoComplete="off"
                                  value={key.clientId}
                                  disabled={busy}
                                  aria-invalid={
                                    draft.enabled && key.clientId.trim().length === 0
                                      ? true
                                      : undefined
                                  }
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
                                <Input
                                  id={`catalog-key-secret-${index}`}
                                  type="password"
                                  autoComplete="new-password"
                                  value={key.apiKey}
                                  disabled={busy}
                                  placeholder={
                                    configured
                                      ? "已保存，留空表示不修改"
                                      : "填写 Ozon Seller Api-Key"
                                  }
                                  onChange={(event) =>
                                    updateKey(index, {
                                      apiKey: event.target.value,
                                    })
                                  }
                                />
                                {key.disabled ? (
                                  <FieldDescription>
                                    已被 Ozon 拒绝，抓取时跳过；重新填写 Api-Key 并保存后重新启用。
                                  </FieldDescription>
                                ) : null}
                              </Field>
                            </div>
                          )
                        })}
                        {draft.keys.length === 0 ? (
                          <FieldDescription>
                            还没有配置平台密钥。添加后可手动抓取或启用每日计划。
                          </FieldDescription>
                        ) : (
                          <FieldDescription>
                            密钥只保存在服务端，读取时不会回显；重新填写即覆盖该 Client-Id 的密钥。
                          </FieldDescription>
                        )}
                        <Button
                          type="button"
                          variant="outline"
                          disabled={busy || draft.keys.length >= MAX_KEYS}
                          onClick={addKey}
                        >
                          <Plus data-icon="inline-start" aria-hidden />
                          添加密钥（最多 {MAX_KEYS} 把）
                        </Button>
                      </FieldGroup>
                    </CardContent>
                  </Card>

                  <Card>
                    <CardHeader>
                      <CardTitle>抓取计划</CardTitle>
                      <CardDescription>
                        每天按所选时区执行，无需保持页面打开。
                      </CardDescription>
                    </CardHeader>
                    <CardContent>
                      <FieldGroup>
                        <Field orientation="horizontal">
                          <FieldLabel htmlFor="catalog-enabled">启用每日自动抓取</FieldLabel>
                          <Switch
                            id="catalog-enabled"
                            checked={draft.enabled}
                            disabled={busy}
                            onCheckedChange={(enabled) => update({ enabled })}
                          />
                        </Field>
                        <Field>
                          <FieldLabel>模式</FieldLabel>
                          <div className="flex flex-wrap gap-2" role="group" aria-label="抓取模式">
                            <Button
                              type="button"
                              variant={draft.scheduleMode === "fixed" ? "default" : "outline"}
                              aria-pressed={draft.scheduleMode === "fixed"}
                              disabled={busy}
                              onClick={() => update({ scheduleMode: "fixed" })}
                            >
                              固定时间
                            </Button>
                            <Button
                              type="button"
                              variant={draft.scheduleMode === "random" ? "default" : "outline"}
                              aria-pressed={draft.scheduleMode === "random"}
                              disabled={busy}
                              onClick={() => update({ scheduleMode: "random" })}
                            >
                              随机时间
                            </Button>
                          </div>
                          <FieldDescription>
                            {draft.scheduleMode === "fixed"
                              ? "每天在指定时间抓取。"
                              : "每天在时间窗口内随机执行，分散请求。"}
                          </FieldDescription>
                        </Field>
                        {draft.scheduleMode === "fixed" ? (
                          <Field>
                            <FieldLabel htmlFor="catalog-at">执行时间</FieldLabel>
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
                          </Field>
                        ) : (
                          <div className="grid gap-3 sm:grid-cols-2">
                            <Field>
                              <FieldLabel htmlFor="catalog-window-start">窗口开始</FieldLabel>
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
                            </Field>
                            <Field>
                              <FieldLabel htmlFor="catalog-window-end">窗口结束</FieldLabel>
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
                            </Field>
                          </div>
                        )}
                        <Field>
                          <FieldLabel htmlFor="catalog-language">抓取语言</FieldLabel>
                          <Select
                            items={LANGUAGES}
                            value={draft.language}
                            onValueChange={(next) => {
                              const picked = LANGUAGES.find((row) => row.value === next)
                              if (picked) update({ language: picked.value })
                            }}
                          >
                            <SelectTrigger id="catalog-language">
                              <SelectValue placeholder="选择语言" />
                            </SelectTrigger>
                            <SelectContent>
                              {LANGUAGES.map((row) => (
                                <SelectItem key={row.value} value={row.value}>
                                  {row.label}
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                          <FieldDescription>缓存的语言版本，工作台读取的是中文。</FieldDescription>
                        </Field>
                        <Field>
                          <FieldLabel htmlFor="catalog-offset">时区</FieldLabel>
                          <Select
                            items={OFFSETS}
                            value={String(draft.utcOffsetMinutes)}
                            onValueChange={(next) => {
                              const offset = Number(next)
                              if (Number.isFinite(offset)) update({ utcOffsetMinutes: offset })
                            }}
                          >
                            <SelectTrigger id="catalog-offset">
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
                        </Field>
                      </FieldGroup>
                    </CardContent>
                  </Card>
                </div>

                <div className="border-t border-border px-5 py-3 text-compact text-muted-foreground">
                  {view.last_run_at_ms ? (
                    <>
                      <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
                        <span>上次耗时 {view.last_duration_ms ?? "—"} ms</span>
                        <span>一级类目 {view.last_root_nodes ?? "—"}</span>
                        <span>尝试 {view.last_key_attempts} 把</span>
                      </div>
                    </>
                  ) : (
                    <span>还没有执行过抓取。保存密钥后可以「立即抓取」，或启用每日自动抓取。</span>
                  )}
                </div>

                <div className="flex flex-wrap items-center justify-end gap-2 border-t border-border px-5 py-4">
                  <Button
                    type="button"
                    variant="outline"
                    disabled={busy || running || view.keys.length === 0}
                    onClick={() => void run()}
                  >
                    <RefreshCw
                      data-icon="inline-start"
                      aria-hidden
                      className={running ? "animate-spin" : undefined}
                    />
                    {running ? "抓取中…" : "立即抓取"}
                  </Button>
                  <Button disabled={busy || !submittable} onClick={() => void save()}>
                    <Save data-icon="inline-start" aria-hidden />
                    保存配置
                  </Button>
                </div>
              </>
            ) : (
              <>
                <div className="p-5">
                  <Card>
                    <CardHeader>
                      <CardTitle>WB Content API Token</CardTitle>
                      <CardDescription>
                        平台共享凭证，仅超级管理员可配置；保存前会先向 WB 验证。
                      </CardDescription>
                    </CardHeader>
                    <CardContent className="flex flex-col gap-4">
                      <FieldGroup className="max-w-2xl">
                        <Field>
                          <FieldLabel htmlFor="wb-content-api-token">Content API Token</FieldLabel>
                          <Input
                            id="wb-content-api-token"
                            type="password"
                            autoComplete="new-password"
                            value={wbToken}
                            disabled={busy}
                            placeholder={
                              wbCredential.configured
                                ? "已托管，输入新 Token 以更换"
                                : "填写 WB Content API Token"
                            }
                            onChange={(event) => setWbToken(event.target.value)}
                          />
                          <FieldDescription>
                            输入 Token 后可验证并保存。Token 只写入服务端且永不回显。
                          </FieldDescription>
                        </Field>
                      </FieldGroup>
                      <Button
                        className="self-end"
                        disabled={busy || wbToken.trim().length === 0}
                        onClick={() => void saveWbCredential()}
                      >
                        <Save data-icon="inline-start" aria-hidden />
                        {wbCredential.configured ? "验证并更换" : "验证并保存"}
                      </Button>
                    </CardContent>
                  </Card>
                </div>
              </>
            )}
          </PlatformAdminSurface>
        </TabsContent>
      </Tabs>
    </div>
  )
}

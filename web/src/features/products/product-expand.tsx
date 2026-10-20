/**
 * 一行展开后的经营读数，平铺在折叠抽屉里，不再套一层卡片。
 *
 * 左列是漏斗：浏览 → 加购 → 出单 三级条形，条宽按窗口最大值归一，条上标值；
 * 条尾只写这一级独有、别处不再重复的口径（人均浏览次数 / Ozon 加购率 / 浏览→出单），
 * 两条之间插一行步间损耗——塌在哪一步不用心算。右列是成交读数块：标价 / 件单价 /
 * 销售额（主数 + 出单件数副行），差额用一句话说清。
 *
 * 销售额是 Ozon 的卢布原值，换算口径归 analyticsRevenue；件单价由换算后的金额推出，
 * 差额句只在标价与销售额同币种时才成立——不同币种比出来的百分比是假的。
 *
 * 两个时间分开写：漏斗页的 `fetchedAtMs`（这一页什么时候落的）与这一行自己的
 * `refreshedAtMs`（最近一次单行读，核实走的就是这条）不是一回事，混成一个会看不清
 * 哪个数更旧。窗口没有逐日序列，所以不画曲线；写入留在列上，不进这个抽屉。
 */
import { Fragment } from "react"

import { formatCount, formatPercentPoint, formatStoreMoney } from "@/lib/format"

import { analyticsRevenue } from "./analytics-money"
import type { StoreProductMetrics, StoreProductRow } from "./products-api"
import { fmtWindowStamp } from "./products-status"

const RATIO = new Intl.NumberFormat("zh-CN", { maximumFractionDigits: 1 })

export function ProductExpand({
  row,
  currency,
}: {
  row: StoreProductRow
  currency: string | null
}) {
  const metrics = row.metrics
  return (
    <section className="grid gap-x-8 gap-y-4 py-3 sm:grid-cols-2">
      <div className="grid content-start gap-2">
        <header className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5">
          <h3 className="text-sm font-medium">销售漏斗</h3>
          {metrics ? (
            <p className="text-xs text-muted-foreground">
              近 {metrics.period_days} 天 · 至 {metrics.through_day.slice(5, 10).replace("-", "/")}
            </p>
          ) : null}
          {metrics ? <Verdict metrics={metrics} /> : null}
        </header>
        {metrics ? <FunnelChart metrics={metrics} /> : <NoWindow row={row} />}
        <WindowTimes row={row} metrics={metrics} />
      </div>
      <SaleReading row={row} metrics={metrics} currency={currency} />
    </section>
  )
}

/** 窗口卡在哪一步。有结论时才说，三步都有数时不另下判断。 */
function Verdict({ metrics }: { metrics: StoreProductMetrics }) {
  const copy = verdictCopy(metrics)
  if (!copy) return null
  return <p className="ml-auto text-xs text-st-attest-ink">{copy}</p>
}

/**
 * 判定句不得与旁边的数字冲突：加购为 0 但有出单是真实存在的一类行（买家直接下单，
 * 或加购没被计入这个窗口），先认出单再认加购。
 */
export function verdictCopy(metrics: StoreProductMetrics): string | null {
  if (!(metrics.hits_view > 0)) return "这个窗口没有浏览"
  if (!(metrics.hits_tocart > 0)) {
    if (metrics.ordered_units > 0) {
      return `没有加购记录，却出了 ${formatCount(metrics.ordered_units)} 件`
    }
    return "有浏览，没有加购，也没有出单"
  }
  if (!(metrics.ordered_units > 0)) return "有加购，没有出单"
  return null
}

function FunnelChart({ metrics }: { metrics: StoreProductMetrics }) {
  const viewsPerVisitor = metrics.session_view > 0 ? metrics.hits_view / metrics.session_view : null
  const viewToOrder = ratioPercent(metrics.ordered_units, metrics.hits_view)
  const steps = [
    {
      label: "浏览",
      value: metrics.hits_view,
      // 人均浏览次数是浏览这一级独有的口径；访客数在它没有意义时才顶上。
      note:
        viewsPerVisitor == null
          ? `${formatCount(metrics.session_view)} 访客`
          : `人均 ${RATIO.format(viewsPerVisitor)} 次`,
      tone: "bg-brand/80",
    },
    {
      label: "加购",
      value: metrics.hits_tocart,
      // Ozon 自报的 conv_tocart 与「加购 ÷ 浏览」不是同一个数，这里给前者；
      // 后者已经由上一行步间损耗写在脸上。
      note: `Ozon 口径 ${formatPercentPoint(metrics.conv_tocart)}`,
      tone: "bg-brand/50",
    },
    {
      label: "出单",
      value: metrics.ordered_units,
      // 出单率（出单 ÷ 加购）是上一行步间损耗的事，这里给横跨窗口的浏览→出单。
      note: viewToOrder == null ? "—" : `浏览→出单 ${formatPercentPoint(viewToOrder)}`,
      tone: "bg-st-good",
    },
  ]
  const peak = Math.max(...steps.map((step) => step.value), 1)
  return (
    <ol className="grid gap-1" role="list" aria-label="浏览加购出单漏斗">
      {steps.map((step, index) => (
        <Fragment key={step.label}>
          {index > 0 ? <FunnelStepLoss from={steps[index - 1]!} to={step} /> : null}
          <li className="flex items-center gap-2.5">
            <span className="w-8 shrink-0 text-xs text-muted-foreground">{step.label}</span>
            <div className="relative h-6 min-w-0 flex-1 rounded-md bg-muted/50">
              <div
                className={`h-full rounded-md ${step.tone}`}
                style={{ width: `${Math.max(2.5, (step.value / peak) * 100)}%` }}
                role="img"
                aria-label={`${step.label} ${step.value}`}
              />
              <span className="absolute inset-y-0 left-2 flex items-center font-mono text-xs font-semibold tabular-nums text-foreground">
                {formatCount(step.value)}
              </span>
            </div>
            <span className="w-24 shrink-0 text-right font-mono text-xs tabular-nums text-muted-foreground">
              {step.note}
            </span>
          </li>
        </Fragment>
      ))}
    </ol>
  )
}

/** 两步之间留下多少、掉了多少。上一步没有量时只说无从计算，不编一个百分比。 */
function FunnelStepLoss({
  from,
  to,
}: {
  from: { label: string; value: number }
  to: { label: string; value: number }
}) {
  const kept = ratioPercent(to.value, from.value)
  // 两端不给「留下 0%，掉 100%」这种同义反复：一步没留下、全部留下都直说。
  const text =
    kept == null
      ? `没有${from.label}，这一步无从计算`
      : kept === 0
        ? `一步没留下：${to.label} ${formatCount(to.value)} 次`
        : kept >= 100
          ? `全部留下：${to.label} ${formatCount(to.value)} 次`
          : `留下 ${formatPercentPoint(kept)}，掉 ${formatPercentPoint(100 - kept)}：${to.label} ${formatCount(to.value)} 次`
  return (
    <li className="flex items-center gap-2.5">
      <span aria-hidden className="w-8 shrink-0" />
      <span className="flex min-w-0 flex-1 items-center gap-2 text-xs text-muted-foreground">
        <span aria-hidden className="h-px flex-1 bg-border" />
        <span className="whitespace-nowrap">{text}</span>
      </span>
    </li>
  )
}

/** 这件商品为什么没有读数。没有漏斗不等于审核失败，别把假设写死。 */
function NoWindow({ row }: { row: StoreProductRow }) {
  const hint =
    row.state === "moderation_failed"
      ? "它当前卡在审核，先处理审核。"
      : row.state === "archived"
        ? "它已归档，恢复上架后才会有读数。"
        : row.gone
          ? "它在 Ozon 已经下架。"
          : "Ozon 还没有给出它的漏斗读数。"
  return <p className="text-sm text-muted-foreground">这件商品还没有销售窗口：{hint}</p>
}

/** 两个时间分开写：漏斗页什么时候落的，以及这一行自己最近一次被单独读。 */
function WindowTimes({
  row,
  metrics,
}: {
  row: StoreProductRow
  metrics: StoreProductMetrics | null | undefined
}) {
  const fetched = metrics ? stampLabel(metrics.fetched_at_ms) : null
  const read = stampLabel(row.refreshed_at_ms)
  const line = [
    fetched ? `漏斗拉取于 ${fetched}` : null,
    read ? `本行最近一次单行读 ${read}` : "本行未单独读过",
  ]
    .filter(Boolean)
    .join(" · ")
  return <p className="text-xs text-muted-foreground">{line}</p>
}

function SaleReading({
  row,
  metrics,
  currency,
}: {
  row: StoreProductRow
  metrics: StoreProductMetrics | null | undefined
  currency: string | null
}) {
  if (!metrics) {
    // 没有窗口时只给标价这一个确凿的数；销售额写 —，不写 0。
    return (
      <div className="grid content-start gap-2">
        <h3 className="text-sm font-medium">成交</h3>
        <dl className="grid grid-cols-2 gap-x-6 gap-y-2">
          <Stat label="标价" value={formatStoreMoney(row.price, currency)} />
          <Stat label="销售额" value="—" />
        </dl>
        <p className="text-xs text-muted-foreground">
          这件商品还没有销售窗口，成交读数要等 Ozon 第一次给出漏斗。
        </p>
      </div>
    )
  }
  const sale = analyticsRevenue(metrics, currency)
  // 件单价必须由换算后的金额推出，否则与销售额不同币种，差额句就是假的。
  const unitPrice = metrics.ordered_units > 0 ? sale.amount / metrics.ordered_units : null
  const list = Number(row.price)
  const listCode = currency?.trim().toUpperCase() ?? ""
  const gap =
    listCode && listCode === sale.currency
      ? priceGap(Number.isFinite(list) ? list : null, unitPrice)
      : null
  return (
    <div className="grid content-start gap-2">
      <h3 className="text-sm font-medium">成交</h3>
      <dl className="grid grid-cols-2 gap-x-6 gap-y-2">
        <Stat label="标价" value={formatStoreMoney(row.price, currency)} />
        <Stat
          label="件单价"
          value={unitPrice == null ? "—" : formatStoreMoney(unitPrice, sale.currency)}
        />
        <div className="grid gap-0.5">
          <dt className="text-xs text-muted-foreground">销售额</dt>
          <dd
            className="font-mono text-base font-semibold tabular-nums"
            title={sale.title ?? undefined}
          >
            {sale.text}
          </dd>
          <span className="text-meta text-muted-foreground">
            出单 {formatCount(metrics.ordered_units)} 件
          </span>
        </div>
      </dl>
      {gap ? <p className="text-xs text-muted-foreground">{gap}</p> : null}
    </div>
  )
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="grid gap-0.5">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="font-mono text-base font-semibold tabular-nums">{value}</dd>
    </div>
  )
}

function priceGap(list: number | null, unit: number | null): string | null {
  if (list == null || unit == null || !(list > 0)) return null
  const pct = Math.round((1 - unit / list) * 100)
  if (pct === 0) return "件单价与标价持平"
  if (pct > 0) return `件单价比标价低 ${pct}%`
  return `件单价比标价高 ${Math.abs(pct)}%`
}

/** 比值百分比；分母为 0 时不是 0%，是无从计算。 */
function ratioPercent(part: number, whole: number): number | null {
  if (!(whole > 0) || !Number.isFinite(part)) return null
  return (part / whole) * 100
}

function stampLabel(ms: number | null | undefined): string | null {
  if (ms == null || !Number.isFinite(ms) || ms <= 0) return null
  // 超出 Date 表示范围的有限值（TimeClip 之外）也是无效时间，同按无读数处理。
  const date = new Date(ms)
  return Number.isNaN(date.getTime()) ? null : fmtWindowStamp(ms)
}

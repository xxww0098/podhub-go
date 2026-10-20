import type { ReactNode } from "react"
import { BadgeCheck, Check, Minus } from "lucide-react"

import type { PaymentOrderView, SeatCatalogData } from "@/bindings/commands"
import { StateChip } from "@/components/state-chip"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import {
  PLAN_CATALOG,
  bytesLabel,
  planByKey,
  seatCatalogTier,
  yuanLabel,
  type PaidTier,
  type PlanDef,
  type PlanKey,
} from "./plan-catalog"

/** Per-Store monthly S3 upload — `s3_bytes_for_stores(1)` from the Cloud
 * price book, mirrored for the compare copy (display only). */
const STORE_MONTHLY_UPLOAD_BYTES = (29 * 1024 ** 3) / 2

type FeatureRow = {
  label: string
  /** A fact about the tier — drawn from the seat catalog, not a per-plan
   * local bundle. `lite` keeps its free floor from the same catalog. */
  value: (plan: PlanDef, catalog?: SeatCatalogData) => string | boolean
}

const FEATURES: FeatureRow[] = [
  {
    label: "成员名额",
    value: (plan, catalog) =>
      plan.key === "lite"
        ? "1 名成员"
        : catalog
          ? `${catalog.min_seats_per_purchase}–${catalog.max_seats_per_workspace} 名成员`
          : "按席位计费",
  },
  {
    label: "店铺位",
    value: (plan, catalog) =>
      plan.key === "lite"
        ? catalog
          ? `${catalog.free_stores} 家店铺`
          : "1 家店铺"
        : catalog
          ? `每名成员 ${catalog.stores_per_seat} 家店铺`
          : "按席位计",
  },
  {
    label: "每月上行配额",
    value: (plan, catalog) =>
      plan.key === "lite"
        ? bytesLabel(
            (catalog?.free_stores ?? 1) * STORE_MONTHLY_UPLOAD_BYTES,
          )
        : catalog
          ? `每名成员 ${bytesLabel(catalog.stores_per_seat * STORE_MONTHLY_UPLOAD_BYTES)}`
          : "按席位计",
  },
  {
    label: "官方 MCP",
    value: (plan, catalog) =>
      plan.key === "lite"
        ? false
        : seatCatalogTier(catalog, plan.key)?.official_mcp ?? false,
  },
  { label: "OCR 图片解析", value: () => true },
  { label: "字段包", value: () => true },
  { label: "AI 中转", value: () => true },
  { label: "批量上架", value: () => true },
]

function seatPriceLabel(plan: PlanDef, catalog?: SeatCatalogData): string {
  if (plan.key === "lite") return "¥0"
  const cents = seatCatalogTier(catalog, plan.key)?.list_unit_month_cents
  return cents === undefined ? "—" : yuanLabel(cents)
}

/**
 * Notion's pricing compare: the current plan pinned as a full-width card,
 * then the whole catalog as columns. Prices and tier facts read the seat
 * catalog — Cloud's `billing::seats` projection — never a local table.
 */
export function PlanCompare({
  current,
  catalog,
  disabledReason,
  seatLimit,
  pendingOrder,
  onPick,
  action,
}: {
  /** Trailing control on the current-plan strip (the purchase history). */
  action?: ReactNode
  current: PlanKey
  catalog?: SeatCatalogData
  disabledReason?: string
  seatLimit?: number
  pendingOrder?: PaymentOrderView
  onPick?: (plan: PaidTier) => void
}) {
  const currentPlan = planByKey(current)
  const currentPrice = seatPriceLabel(currentPlan, catalog)
  const yearDiscount = catalog?.terms.find((term) => term.key === "year")
  const yearDiscountLabel =
    yearDiscount && yearDiscount.discount_percent < 100
      ? `年付 ${yearDiscount.discount_percent / 10} 折`
      : undefined

  return (
    <div className="flex flex-col gap-4">
      {/* Current plan: one strip, not a second hero — the column below
          carries the full facts and its own 当前 chip. */}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-xl border border-border bg-card px-4 py-3">
        <BadgeCheck aria-hidden className="size-4 shrink-0 text-brand" />
        <span className="text-compact text-muted-foreground">当前方案</span>
        <span className="text-sm font-semibold text-foreground">{currentPlan.name}</span>
        <span className="font-mono text-compact tabular-nums text-muted-foreground">
          {currentPrice}
          {currentPlan.key !== "lite" ? " / 成员 / 月" : ""}
        </span>
        <span className="min-w-0 text-compact text-muted-foreground">
          {currentPlan.tagline}
          {seatLimit !== undefined ? ` · 当前 ${seatLimit} 个成员名额` : ""}
        </span>
        <div className="ml-auto flex items-center gap-2">
          {yearDiscountLabel ? (
            <Badge variant="outline">{yearDiscountLabel}</Badge>
          ) : null}
          {action}
        </div>
      </div>

      {/* Plan columns. Columns stack on narrow screens. */}
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {PLAN_CATALOG.map((plan) => {
          const isCurrent = plan.key === current
          const paid = plan.key !== "lite"
          const purchasable = paid && catalog !== undefined
          const blocked = disabledReason !== undefined || (paid && !purchasable)
          return (
            <div
              key={plan.key}
              className={cn(
                "relative flex min-w-0 flex-col rounded-xl border bg-card p-4",
                isCurrent ? "border-brand/50" : "border-border",
              )}
            >
              <div className="flex items-center justify-between gap-2">
                <span className="text-sm font-semibold text-foreground">
                  {plan.name}
                </span>
                {isCurrent ? (
                  <StateChip status="current" label="当前" tone="good" />
                ) : null}
              </div>
              <div className="mt-2.5 flex items-baseline gap-1.5">
                <span className="font-mono text-2xl font-bold tabular-nums tracking-tight text-foreground">
                  {seatPriceLabel(plan, catalog)}
                </span>
                {paid ? (
                  <span className="text-xs text-muted-foreground">/ 成员 / 月</span>
                ) : null}
              </div>
              <ul className="mt-4 flex flex-col gap-2.5">
                {FEATURES.map((feature) => {
                  const value = feature.value(plan, catalog)
                  return (
                    <li
                      key={feature.label}
                      className="flex items-start justify-between gap-3 text-xs"
                    >
                      <span className="text-muted-foreground">
                        {feature.label}
                      </span>
                      {typeof value === "boolean" ? (
                        value ? (
                          <Check
                            className="size-3.5 shrink-0 text-foreground"
                            aria-label={`${feature.label}：包含`}
                          />
                        ) : (
                          <Minus
                            className="size-3.5 shrink-0 text-muted-foreground/50"
                            aria-label={`${feature.label}：不包含`}
                          />
                        )
                      ) : (
                        <span className="text-right font-medium tabular-nums text-foreground">
                          {value}
                        </span>
                      )}
                    </li>
                  )
                })}
              </ul>
              <div className="mt-auto pt-5">
                {pendingOrder ? (
                  <Button
                    type="button"
                    variant="default"
                    className="w-full"
                    onClick={() => {
                      if (plan.key !== "lite") onPick?.(plan.key)
                    }}
                  >
                    继续支付
                  </Button>
                ) : (
                  <Button
                    type="button"
                    variant={isCurrent ? "outline" : "default"}
                    disabled={isCurrent || !paid || blocked}
                    className="w-full"
                    onClick={() => {
                      if (plan.key !== "lite") onPick?.(plan.key)
                    }}
                  >
                    {isCurrent
                      ? "当前方案"
                      : plan.key === "ultra"
                        ? "联系我们 / 升级"
                        : "升级"}
                  </Button>
                )}
                {disabledReason && !isCurrent && !pendingOrder ? (
                  <p className="mt-2 text-center text-meta leading-4 text-muted-foreground">
                    {disabledReason}
                  </p>
                ) : null}
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}

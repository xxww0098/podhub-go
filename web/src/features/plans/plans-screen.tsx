import { useEffect, useId, useRef, useState, type FormEvent } from "react"
import {
  Minus,
  Plus,
  RefreshCcw,
} from "lucide-react"

import type {
  AccountOverview,
  MemberSeatLotView,
  PaymentMethodsData,
  PaymentOrderView,
  SeatCatalogData,
  SeatUpgradeCreditView,
  WorkspaceBillingOverviewData,
} from "@/bindings/commands"
import { accountHttp } from "@/bindings/http-account"
import { StateChip } from "@/components/state-chip"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { ConfirmDialog } from "@/components/ui/confirm-dialog"
import { Input } from "@/components/ui/input"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Spinner } from "@/components/ui/spinner"
import { useAccountOverview } from "@/features/account/account-overview-cache"
import {
  commandErrorCode,
  errorMessage,
  WORKSPACE_MISMATCH_CODE,
} from "@/lib/error-message"
import { clearLive, notifyCommandError, notifyLive, notifySuccess } from "@/lib/notify"
import { useVisiblePolling } from "@/lib/visible-polling"
import { cn } from "@/lib/utils"
import { AlipayQr } from "./alipay-qr"
import {
  PaymentChannelList,
  paymentMethodKeys,
  paymentOrderPresentation,
  paymentProviderLabel,
} from "./payment-channels"
import { PlanCompare } from "./plan-compare"
import { RedeemCodeDialog } from "./redeem-code-dialog"
import { PurchaseAgreementHistory } from "./purchase-agreement-history"

export { redeemSuccessNotice } from "./redeem-code-dialog"
export { paymentOrderPresentation } from "./payment-channels"
import {
  DEFAULT_BADGE,
  MAX_MEMBER_SEATS_PER_WORKSPACE,
  SEAT_QUICK_QUANTITIES,
  normalizePlanKey,
  planByKey,
  planDisplayName,
  planRank,
  seatCatalogTerm,
  seatCatalogTier,
  seatTermLabel,
  seatUnitMonthCents,
  yuanLabel,
  type PaidTier,
  type PlanKey,
} from "./plan-catalog"

const PLANS_CATALOG_LIVE = "plans-seat-catalog-load"
const PLANS_BILLING_LIVE = "plans-billing-overview-load"

/** A lot's `expires_at`/`starts_at` wire timestamp → `YYYY-MM-DD`. */
function lotDay(value: string): string {
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? value : date.toLocaleDateString()
}

/** Purchased member seats the billing overview reports; falls back to the
 * entitlement limit's approximation while the projection loads. */
function purchasedSeats(
  billing: WorkspaceBillingOverviewData | undefined,
  current: PlanKey,
  fallbackSeats: number,
): number {
  if (billing) return billing.purchased_seats
  return current === "lite" ? 0 : fallbackSeats
}

export function PlansScreen({
  overview: overviewProp,
  onOverviewChange,
  catalog: catalogPreset,
  billingOverview: billingPreset,
}: {
  overview?: AccountOverview
  onOverviewChange?: (overview: AccountOverview) => void
  /** Test/SSR injection — when set, the catalog is not fetched. */
  catalog?: SeatCatalogData
  /** Test/SSR injection — when set, the billing overview is not fetched. */
  billingOverview?: WorkspaceBillingOverviewData
}) {
  const overview = useAccountOverview() ?? overviewProp
  const current =
    normalizePlanKey(overview?.active_workspace?.plan) ??
    normalizePlanKey(overview?.entitlement?.plan) ??
    DEFAULT_BADGE
  const seats = overview?.entitlement?.limits.seats ?? 1
  const workspaceRole = overview?.active_workspace?.role
  const workspaceUuid = overview?.active_workspace?.uuid
  const canRedeem = workspaceRole === "owner"
  const canPurchase =
    workspaceRole === "owner" && overview?.active_workspace?.is_owned === true

  // The purchasable catalog and the per-lot billing overview are Cloud reads —
  // nothing on this page keeps its own price book (B6).
  const [catalogFetch, setCatalogFetch] = useState<SeatCatalogData>()
  const [billingFetch, setBillingFetch] = useState<WorkspaceBillingOverviewData>()
  const [billingReload, setBillingReload] = useState(0)
  const catalog = catalogPreset ?? catalogFetch
  const billing = billingPreset ?? billingFetch
  useEffect(() => {
    if (catalogPreset) return
    let cancelled = false
    const load = () =>
      accountHttp.accountGetSeatCatalog().then(
        (next) => {
          if (cancelled) return
          setCatalogFetch(next)
          clearLive(PLANS_CATALOG_LIVE)
        },
        (reason) => {
          if (cancelled) return
          notifyLive({
            id: PLANS_CATALOG_LIVE,
            type: "error",
            reason,
            title: "套餐目录读取失败",
            description: errorMessage(reason, "价格与档位信息来自云端目录，请重试。"),
            action: { label: "重试", onClick: () => void load() },
          })
        },
      )
    void load()
    return () => {
      cancelled = true
    }
  }, [catalogPreset])

  useEffect(() => {
    if (billingPreset || !workspaceUuid) return
    let cancelled = false
    accountHttp.accountGetBillingOverview().then(
      (next) => {
        if (cancelled) return
        setBillingFetch(next)
        clearLive(PLANS_BILLING_LIVE)
      },
      (reason) => {
        if (cancelled) return
        notifyLive({
          id: PLANS_BILLING_LIVE,
          type: "error",
          reason,
          title: "权益概览读取失败",
          description: errorMessage(reason, "席位批次与下次变化暂不可读，请重试。"),
          action: {
            label: "重试",
            onClick: () => setBillingReload((value) => value + 1),
          },
        })
      },
    )
    return () => {
      cancelled = true
    }
  }, [billingPreset, billingReload, workspaceUuid])

  const handleOverviewChange = (next: AccountOverview) => {
    onOverviewChange?.(next)
    setBillingReload((value) => value + 1)
  }

  // Headroom approximates purchased lots; the billing overview's
  // `purchased_seats` is exact once loaded, and the server remains
  // authoritative — it rechecks `max_seats_in_window` at write time.
  const heldSeats = purchasedSeats(billing, current, seats)
  const maxSeats = catalog?.max_seats_per_workspace ?? MAX_MEMBER_SEATS_PER_WORKSPACE
  const remainingSeats = Math.max(0, maxSeats - heldSeats)
  const workspaceFull = remainingSeats < (catalog?.min_seats_per_purchase ?? 1)
  const [upgrade, setUpgrade] = useState<{ tier: PaidTier; renewal?: MemberSeatLotView }>()
  const [pendingOrder, setPendingOrder] = useState<PaymentOrderView>()
  const [redeemOpen, setRedeemOpen] = useState(false)

  const purchaseBlockedReason = !canPurchase
    ? "只有自有 Workspace 的所有者可以加购。"
    : workspaceFull
      ? `该工作空间已有 ${heldSeats} 个成员名额，上限 ${maxSeats} 个。`
      : undefined

  /** A renewal targets one lot's frozen tier/seats; pick it from the catalog. */
  function openRenewal(lot: MemberSeatLotView) {
    const tier = normalizePlanKey(lot.tier)
    if (!tier || tier === "lite") return
    setUpgrade({ tier, renewal: lot })
  }

  return (
    <div className="flex w-full flex-col gap-6">
      <h1 className="sr-only">升级方案</h1>
      {/* Plan page: current-plan strip, then the comparison columns. Picking
          a tier opens the upgrade dialog. */}
      <PlanCompare
        action={
          canPurchase && workspaceUuid ? (
            <PurchaseAgreementHistory key={workspaceUuid} workspaceUuid={workspaceUuid} />
          ) : undefined
        }
        current={current}
        catalog={catalog}
        disabledReason={purchaseBlockedReason}
        pendingOrder={pendingOrder}
        onPick={(picked) => setUpgrade({ tier: picked })}
      />

      {/* 权益概览: per-lot truth — what was bought, what applies, and when it
          flips. Every unexpired lot carries its own 续费 action. */}
      {billing ? (
        <section className="flex flex-col gap-2 border-t border-border pt-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h3 className="text-compact font-semibold text-foreground">成员席位批次</h3>
            <p className="text-xs text-muted-foreground">
              已购 {billing.purchased_seats} 席
              {billing.member_seats.override_value != null
                ? ` · 管理员覆盖 ${billing.member_seats.override_value}`
                : ""}
              {" · 有效 "}
              {billing.member_seats.effective} · 已用 {billing.member_seats.used}
              {billing.member_seats.suspended > 0
                ? ` · 暂停 ${billing.member_seats.suspended}`
                : ""}
              {" · 店铺 "}
              {billing.store_slots.used}/{billing.store_slots.effective}
              {billing.store_slots.suspended > 0
                ? ` · 暂停 ${billing.store_slots.suspended}`
                : ""}
            </p>
          </div>

          {billing.lots.length > 0 ? (
            <ul className="flex flex-col divide-y divide-border/60">
              {billing.lots.map((lot) => (
                <li
                  key={lot.id}
                  className="flex flex-wrap items-center justify-between gap-2 py-2.5 text-xs"
                >
                  <div className="flex min-w-0 items-center gap-2">
                    <StateChip
                      status={lot.active ? "active" : "scheduled"}
                      label={lot.active ? "生效中" : "待生效"}
                      tone={lot.active ? "good" : "flight"}
                    />
                    <span className="font-medium text-foreground">
                      {planDisplayName(lot.tier)} · {lot.seats} 席
                    </span>
                    <span className="text-muted-foreground">
                      {lotDay(lot.starts_at)} – {lotDay(lot.expires_at)}
                    </span>
                    {lot.upgrade_credit_cents > 0 ? (
                      <span className="text-muted-foreground">
                        可折 {yuanLabel(lot.upgrade_credit_cents)}
                      </span>
                    ) : null}
                  </div>
                  {canPurchase && lot.renewable ? (
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      className="h-7 shrink-0 text-xs"
                      onClick={() => openRenewal(lot)}
                    >
                      <RefreshCcw className="size-3" data-icon="inline-start" />
                      续费
                    </Button>
                  ) : lot.renewable ? null : (
                    <span className="shrink-0 text-muted-foreground">已续期</span>
                  )}
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-xs text-muted-foreground">
              暂无付费席位批次；免费版含 1 名成员 · 1 家店铺。
            </p>
          )}

          {billing.next_change ? (
            <p className="text-xs leading-5 text-muted-foreground">
              下次变化 {lotDay(billing.next_change.at)}：届时{" "}
              {planDisplayName(billing.next_change.plan)} ·{" "}
              {billing.next_change.effective_seats} 名成员 ·{" "}
              {billing.next_change.effective_stores} 家店铺
              {billing.next_change.suspended_members > 0 ||
              billing.next_change.suspended_stores > 0
                ? `，届时 ${billing.next_change.suspended_members} 名成员 / ${billing.next_change.suspended_stores} 家店铺将暂停`
                : ""}
              。
              {billing.plan_expires_at
                ? ` 最晚到期 ${lotDay(billing.plan_expires_at)}（未过期批次的最后到期时间）。`
                : ""}
            </p>
          ) : null}
        </section>
      ) : null}

      {/* 计费说明 — a footnote list under a hairline, not a third card.
          兑换码 lives on the Workspace menu's 兑换码 dialog. */}
      {catalog ? (
        <section className="flex flex-col gap-2 border-t border-border pt-4 text-xs leading-relaxed text-muted-foreground">
          <h3 className="text-compact font-semibold text-foreground">计费说明</h3>
          <ul className="flex list-disc flex-col gap-1.5 pl-4">
                <li>
                  每名成员含 {catalog.stores_per_seat} 个店铺位，随时可加购到{" "}
                  {catalog.max_seats_per_workspace} 名成员（
                  {catalog.max_stores_per_workspace} 家店铺）。每一批按购买时间独立计时（
                  {catalog.terms.map((term) => `${term.days} 天`).join(" / ")}，非按月份大小计算），到期后该批名额失效。
                </li>
                <li>
                  {catalog.terms
                    .map((term) =>
                      term.discount_percent < 100
                        ? `${seatTermLabel(term.key)} ${term.discount_percent / 10} 折`
                        : `${seatTermLabel(term.key)}按标价计费`,
                    )
                    .join("，")}
                  ；按购买时间计时，非按月份大小计算。每次至少购买{" "}
                  {catalog.min_seats_per_purchase} 个成员名额，一个工作空间最多{" "}
                  {catalog.max_seats_per_workspace} 个。实付以下单后订单回显为准。
                </li>
                <li>识图按钱包扣费，不限次数。本月计数只作用量展示，用尽钱包才会拒绝下一次识图。</li>
          </ul>
        </section>
      ) : null}

      <UpgradePlanDialog
        key={overview?.active_workspace?.uuid ?? "no-workspace"}
        open={upgrade !== undefined}
        onOpenChange={(next) => {
          if (!next) setUpgrade(undefined)
        }}
        tier={upgrade?.tier ?? "pro"}
        renewal={upgrade?.renewal}
        catalog={catalog}
        canPurchase={canPurchase}
        heldSeats={heldSeats}
        seatOverride={billing?.member_seats.override_value ?? null}
        upgradeCredits={billing?.upgrade_credits}
        lots={billing?.lots ?? []}
        workspaceName={overview?.active_workspace?.name}
        workspaceUuid={workspaceUuid}
        onOverviewChange={handleOverviewChange}
        onOrderChange={setPendingOrder}
        onOpenRedeem={() => setRedeemOpen(true)}
      />
      <RedeemCodeDialog
        open={redeemOpen}
        onOpenChange={setRedeemOpen}
        canRedeem={canRedeem}
        workspaceUuid={workspaceUuid}
        onOverviewChange={handleOverviewChange}
      />
    </div>
  )
}

/**
 * "Plus ¥100 / 商业 ¥150 / 企业 ¥200 / 成员 / 月；年付 8 折" — read off the
 * seat catalog, not a local price table.
 */
export function seatTierSummary(catalog: SeatCatalogData | undefined): string {
  const priced = (catalog?.tiers ?? [])
    .map(
      (tier) =>
        `${planDisplayName(tier.key)} ${yuanLabel(tier.list_unit_month_cents)} / 成员 / 月`,
    )
    .join("；")
  const yearly = catalog?.terms.find((term) => term.key === "year")
  const discount =
    yearly && yearly.discount_percent < 100
      ? `；年付 ${yearly.discount_percent / 10} 折`
      : ""
  return `${priced}${discount}`
}

export function pendingPaymentOrder(orders: PaymentOrderView[]) {
  return orders.find((order) => order.status === "pending")
}

const PLANS_PAYMENT_METHODS_LIVE = "plans-payment-methods-load"
const PLANS_ORDERS_LIVE = "plans-orders-load"
const PLANS_OVERVIEW_LIVE = "plans-overview-sync"
const PLANS_WORKSPACE_SWITCHED_LIVE = "plans-workspace-switched"
const PLANS_ENTRY_CONFIRMING_LIVE = "plans-entry-confirming"

/** Cloud's 409 code for a pending member-seat order. */
const PENDING_ORDER_EXISTS_CODE = "cloud_pending_order_exists"

/**
 * A provider-create refusal names the pending order it already committed
 * (`pendingOrderId` in the client's refusal shape) so the attempt can resume
 * that order instead of minting a second one.
 */
function refusedPendingOrderId(reason: unknown): string | undefined {
  if (typeof reason === "object" && reason !== null && "pendingOrderId" in reason) {
    const value = (reason as { pendingOrderId?: unknown }).pendingOrderId
    return typeof value === "string" && value.length > 0 ? value : undefined
  }
  return undefined
}

/**
 * Notion's 升级到商业版 checkout, mapped onto member seats: a wide two-column
 * dialog — seat count and payment channel on the left, billing-term radio
 * cards and the 确认升级 summary (price, fine print, one primary CTA) on the
 * right. With `renewal` set the same flow extends one lot instead — tier and
 * seats are frozen by the lot and the intent posts `renews_lot_id` (B7).
 * Once an order exists the body swaps to the QR / status view.
 * Stays mounted while closed so a pending order is detected and reported via
 * `onOrderChange` (the compare cards then read 继续支付).
 */
function UpgradePlanDialog({
  open,
  onOpenChange,
  tier,
  renewal,
  catalog,
  canPurchase,
  heldSeats,
  seatOverride,
  upgradeCredits,
  lots = [],
  workspaceUuid,
  workspaceName,
  onOverviewChange,
  onOrderChange,
  onOpenRedeem,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  tier: PaidTier
  /** Set to extend this lot instead of minting a fresh purchase. */
  renewal?: MemberSeatLotView
  catalog?: SeatCatalogData
  canPurchase: boolean
  /** Purchased seats — the additive base of the 购买后总席位 equation. */
  heldSeats: number
  /** The admin's persisted `member_seat_limit_override`, when one applies. */
  seatOverride?: number | null
  /** Per-tier upgrade credit preview from the billing overview (server money). */
  upgradeCredits?: SeatUpgradeCreditView[]
  /** The Workspace's unexpired lots — for the "will be terminated" note only. */
  lots?: MemberSeatLotView[]
  workspaceUuid?: string
  workspaceName?: string
  onOverviewChange?: (overview: AccountOverview) => void
  onOrderChange?: (order?: PaymentOrderView) => void
  onOpenRedeem?: () => void
}) {
  const plan = planByKey(tier)
  const catalogTier = seatCatalogTier(catalog, tier)
  const listUnitMonthCents = catalogTier?.list_unit_month_cents
  const maxSeats = catalog?.max_seats_per_workspace ?? MAX_MEMBER_SEATS_PER_WORKSPACE
  const remainingSeats = Math.max(0, maxSeats - heldSeats)
  const purchaseMax = Math.min(
    catalog?.max_seats_per_purchase ?? maxSeats,
    remainingSeats,
  )
  const minSeats = catalog?.min_seats_per_purchase ?? 1
  const workspaceFull = remainingSeats < minSeats

  const [quantity, setQuantity] = useState(minSeats)
  const [term, setTerm] = useState("year")
  const [provider, setProvider] = useState("")
  const [methods, setMethods] = useState<PaymentMethodsData>()
  const [methodsError, setMethodsError] = useState(false)
  const [methodsLoading, setMethodsLoading] = useState(false)
  const [methodsReload, setMethodsReload] = useState(0)
  const [busy, setBusy] = useState(false)
  const [order, setOrder] = useState<PaymentOrderView>()
  const orderRef = useRef<PaymentOrderView | undefined>(undefined)
  const [lockedWorkspace, setLockedWorkspace] = useState<{ uuid: string; name: string }>()
  const [ordersLoading, setOrdersLoading] = useState(canPurchase)
  const [ordersError, setOrdersError] = useState(false)
  const [ordersReason, setOrdersReason] = useState<unknown>()
  const [ordersReload, setOrdersReload] = useState(0)
  const [autoRefreshFailed, setAutoRefreshFailed] = useState(false)
  const [overviewError, setOverviewError] = useState(false)
  const [overviewReason, setOverviewReason] = useState<unknown>()
  const [overviewSyncing, setOverviewSyncing] = useState(false)
  const overviewSyncingRef = useRef(false)
  const [cancelOpen, setCancelOpen] = useState(false)
  const refreshInFlight = useRef(false)
  // One attempt's operation_id. A transient failure keeps it so the retry
  // resumes the pending order this attempt already committed; changing the
  // chosen content or provider rotates it, and a successful create rotates it.
  const [operationId, setOperationId] = useState(() => crypto.randomUUID())
  const agreementId = useId()
  const agreementLinkRef = useRef<HTMLButtonElement>(null)
  const agreementContentRef = useRef<HTMLDivElement>(null)
  const [readingAgreement, setReadingAgreement] =
    useState<NonNullable<PaymentMethodsData["purchase_agreement"]>>()
  const [readAgreementVersion, setReadAgreementVersion] = useState<string>()
  const [acceptedPurchase, setAcceptedPurchase] = useState<string>()
  const workspaceSwitched = Boolean(
    lockedWorkspace && workspaceUuid && lockedWorkspace.uuid !== workspaceUuid,
  )

  function clampQuantity(value: number) {
    if (!Number.isFinite(value) || purchaseMax < minSeats) {
      return minSeats
    }
    return Math.min(purchaseMax, Math.max(minSeats, Math.round(value)))
  }

  // A renewal keeps the lot's seats; a purchase adds to the purchased count.
  const quantityClamped = renewal ? renewal.seats : clampQuantity(quantity)
  const seatCount = quantityClamped
  const nextSeats = heldSeats + quantityClamped
  const storesPerSeat = catalog?.stores_per_seat ?? 0
  const nextStores = Math.min(
    catalog?.max_stores_per_workspace ?? 0,
    nextSeats * storesPerSeat,
  )
  const activeTerm = seatCatalogTerm(catalog, term)
  const unitMonthCents = seatUnitMonthCents(catalog, tier, term)
  const amountCents =
    unitMonthCents !== undefined && activeTerm
      ? unitMonthCents * seatCount * activeTerm.months
      : undefined
  const listAmountCents =
    listUnitMonthCents !== undefined && activeTerm
      ? listUnitMonthCents * seatCount * activeTerm.months
      : undefined
  const hasDiscount =
    amountCents !== undefined && listAmountCents !== undefined
      ? amountCents < listAmountCents
      : false
  const discountPercent = activeTerm?.discount_percent ?? 100
  const discountLabel =
    discountPercent < 100 ? `${discountPercent / 10} 折` : undefined

  // Upgrade credit preview: per-tier totals from the overview, never recomputed
  // here. A renewal extends one lot and is never credited.
  const creditCents = renewal
    ? 0
    : (upgradeCredits?.find((row) => row.tier === tier)?.credit_cents ?? 0)
  const payableCents =
    amountCents === undefined ? undefined : Math.max(0, amountCents - creditCents)
  const forfeitedCents =
    amountCents === undefined ? 0 : Math.max(0, creditCents - amountCents)
  const fullyCredited =
    amountCents !== undefined && amountCents > 0 && payableCents === 0
  const appliedCreditCents = Math.min(creditCents, amountCents ?? 0)
  const supersededLots = renewal
    ? []
    : lots.filter((lot) => planRank(lot.tier) < planRank(tier))
  const supersededSeats = supersededLots.reduce((sum, lot) => sum + lot.seats, 0)
  const agreement = methods?.purchase_agreement
  const agreementAvailable = Boolean(agreement?.version && agreement.content.trim())
  const purchaseKey = JSON.stringify([
    workspaceUuid, tier, renewal?.id, quantityClamped, term, agreement?.version,
  ])
  const agreementAccepted = agreementAvailable && acceptedPurchase === purchaseKey

  useEffect(() => {
    setAcceptedPurchase(undefined)
  }, [open, purchaseKey])

  useEffect(() => {
    setReadingAgreement(undefined)
    setReadAgreementVersion(undefined)
  }, [open, workspaceUuid])

  useEffect(() => {
    if (readingAgreement) agreementContentRef.current?.focus()
  }, [readingAgreement])

  useEffect(() => {
    const id = "plans-purchase-agreement-load"
    if (open && methods && !agreementAvailable && !order) {
      notifyLive({
        id,
        type: "error",
        title: "采购同意书暂不可用，请重新读取。",
        action: { label: "重试", onClick: () => setMethodsReload((value) => value + 1) },
      })
    } else {
      clearLive(id)
    }
    return () => clearLive(id)
  }, [open, methods, agreementAvailable, order])

  // Changing the chosen content or provider starts a new attempt: the old
  // operation_id must not resurrect an order for different seats/term/channel.
  useEffect(() => {
    setOperationId(crypto.randomUUID())
  }, [renewal?.id, tier, quantityClamped, term, provider])

  // Payment methods load lazily on open; failures ride the live toast.
  useEffect(() => {
    if (!open) return
    let cancelled = false
    setMethods(undefined)
    setMethodsError(false)
    setMethodsLoading(true)
    clearLive(PLANS_PAYMENT_METHODS_LIVE)
    accountHttp
      .accountGetPaymentMethods()
      .then(
        (next) => {
          if (cancelled) return
          setMethods(next)
          const keys = paymentMethodKeys(next)
          setProvider(
            (prev) =>
              prev || (keys.find((k) => k.includes("alipay")) ?? keys[0] ?? ""),
          )
        },
        (reason) => {
          if (cancelled) return
          setMethodsError(true)
          notifyLive({
            id: PLANS_PAYMENT_METHODS_LIVE,
            type: "error",
            reason,
            title: errorMessage(reason, "支付方式读取失败，请重新读取。"),
            action: {
              label: "重试",
              onClick: () => setMethodsReload((value) => value + 1),
            },
          })
        },
      )
      .finally(() => {
        if (!cancelled) setMethodsLoading(false)
      })
    return () => {
      cancelled = true
      clearLive(PLANS_PAYMENT_METHODS_LIVE)
    }
  }, [open, methodsReload])

  // Surface a resumable pending order to the compare cards.
  useEffect(() => {
    onOrderChange?.(order?.status === "pending" ? order : undefined)
  }, [order, onOrderChange])

  useEffect(() => {
    if (!ordersError) {
      clearLive(PLANS_ORDERS_LIVE)
      return
    }
    notifyLive({
      id: PLANS_ORDERS_LIVE,
      type: "error",
      reason: ordersReason,
      title: "无法确认是否已有待支付订单。",
      action: { label: "重试", onClick: () => setOrdersReload((value) => value + 1) },
    })
    return () => clearLive(PLANS_ORDERS_LIVE)
  }, [ordersError, ordersReason])

  useEffect(() => {
    if (!overviewError) {
      clearLive(PLANS_OVERVIEW_LIVE)
      return
    }
    notifyLive({
      id: PLANS_OVERVIEW_LIVE,
      type: "error",
      reason: overviewReason,
      title: "成员名额已到账，但套餐概览尚未更新。",
      action: { label: "重试", onClick: () => void syncPaidOverview() },
    })
    return () => clearLive(PLANS_OVERVIEW_LIVE)
  }, [overviewError, overviewReason])

  useEffect(() => {
    if (!workspaceSwitched) {
      clearLive(PLANS_WORKSPACE_SWITCHED_LIVE)
      return
    }
    notifyLive({
      id: PLANS_WORKSPACE_SWITCHED_LIVE,
      type: "error",
      title: "当前 Workspace 已切换，请关闭后重新打开订单。",
    })
    return () => clearLive(PLANS_WORKSPACE_SWITCHED_LIVE)
  }, [workspaceSwitched])

  // entry_confirming is a persistent state, not a one-off failure: the toast
  // stays with a retry action while the order holds its seat reservation.
  useEffect(() => {
    if (order?.status !== "pending" || order.entry_state !== "entry_confirming") {
      clearLive(PLANS_ENTRY_CONFIRMING_LIVE)
      return
    }
    notifyLive({
      id: PLANS_ENTRY_CONFIRMING_LIVE,
      type: "error",
      title: "支付渠道已受理该订单，但未返回可再次展示的付款入口。",
      description: "订单仍保留成员名额；请稍后重试找回，或等渠道确认后自动到账。",
      action: { label: "重试找回", onClick: () => void recoverOrder() },
    })
    return () => clearLive(PLANS_ENTRY_CONFIRMING_LIVE)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [order?.status, order?.entry_state, order?.public_id])

  useEffect(() => {
    let cancelled = false
    orderRef.current = undefined
    setOrder(undefined)
    setOrdersError(false)
    setOrdersReason(undefined)
    setAutoRefreshFailed(false)
    setOverviewError(false)
    setOverviewReason(undefined)
    if (!canPurchase || !workspaceUuid) {
      setOrdersLoading(false)
      return
    }
    setOrdersLoading(true)
    void (async () => {
      try {
        const orders = await accountHttp.accountListPaymentOrders({ status: "pending" })
        if (cancelled) return
        const pending = pendingPaymentOrder(orders)
        if (!pending) return
        orderRef.current = pending
        setOrder(pending)
        try {
          const detail = await accountHttp.accountGetPaymentOrder(pending.public_id)
          if (cancelled) return
          orderRef.current = detail
          setOrder(detail)
          if (detail.status !== "pending") setCancelOpen(false)
          if (detail.status === "paid") {
            notifySuccess("成员名额已到账")
            await syncPaidOverview()
          }
        } catch (reason) {
          if (!cancelled) notifyCommandError(reason, "订单详情更新失败，请手动刷新。")
        }
      } catch (reason) {
        if (!cancelled) {
          setOrdersReason(() => reason)
          setOrdersError(true)
        }
      } finally {
        if (!cancelled) setOrdersLoading(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [canPurchase, ordersReload, workspaceUuid])

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (submitBlocked || !lockedWorkspace || !agreement) return
    setBusy(true)
    try {
      // An empty channel is only legal when the frozen credit covers the whole
      // price; `fullyCredited` is that preview, the server re-checks at create.
      if (!provider && !fullyCredited) return
      const created = renewal
        ? await accountHttp.accountCreateRenewalIntent({
            renews_lot_id: renewal.id,
            term,
            provider,
            operation_id: operationId,
            purchase_agreement: { version: agreement.version, accepted: true },
            // B2: the server re-resolves the active Workspace and refuses when
            // the one this dialog locked no longer matches.
            expected_workspace_uuid: lockedWorkspace.uuid,
          })
        : await accountHttp.accountCreatePaymentIntent({
            seats: quantityClamped,
            term,
            tier,
            provider,
            operation_id: operationId,
            purchase_agreement: { version: agreement.version, accepted: true },
            // B2: the server re-resolves the active Workspace and refuses when the
            // one this dialog locked no longer matches — the order would otherwise
            // be charged to a Workspace the operator never confirmed.
            expected_workspace_uuid: lockedWorkspace.uuid,
          })
      orderRef.current = created
      setOrder(created)
      // A successful create closes this attempt; the next one starts fresh and
      // must not resume an order that has already been answered.
      setOperationId(crypto.randomUUID())
      if (created.status === "paid") {
        // A fully credited order settles inside the create transaction: there is
        // no entry to pay and nothing to wait for.
        notifySuccess(renewal ? "续费已完成" : "升级已完成", {
          description: "本单应付全部由原套餐折算抵扣，成员名额已到账。",
        })
        await syncPaidOverview()
      } else {
        notifySuccess(renewal ? "续费订单已创建" : "加购订单已创建", {
          description: created.pay_url
            ? "请打开托管收银台完成付款。"
            : created.qr_code
              ? "请扫码完成付款。"
              : created.remittance ?? "请把单号发给运营，确认收款后成员名额到账。",
        })
      }
    } catch (reason) {
      // The provider-create refusal names the order it already committed:
      // recover that entry instead of minting a second purchase intent.
      const refusedPending = refusedPendingOrderId(reason)
      if (refusedPending) {
        try {
          const recovered = await accountHttp.accountRecoverPaymentOrder(refusedPending)
          orderRef.current = recovered
          setOrder(recovered)
          notifySuccess("待支付订单已找回", {
            description: "该订单已锁定名额，继续完成付款即可。",
          })
          return
        } catch (recoverReason) {
          notifyCommandError(recoverReason, "找回付款入口失败，请稍后刷新订单列表。")
          return
        }
      }
      // The order may already exist when the create response was lost: the
      // pending order is the reservation — recover its entry before painting it
      // instead of letting the user mint a second purchase intent.
      if (commandErrorCode(reason) === PENDING_ORDER_EXISTS_CODE) {
        try {
          const orders = await accountHttp.accountListPaymentOrders({ status: "pending" })
          const pending = pendingPaymentOrder(orders)
          if (pending) {
            let resolved = pending
            try {
              resolved = await accountHttp.accountRecoverPaymentOrder(pending.public_id)
            } catch (recoverReason) {
              notifyCommandError(recoverReason, "找回付款入口失败，已保留待支付订单。")
            }
            orderRef.current = resolved
            setOrder(resolved)
            notifySuccess("已找回待支付订单", {
              description: "该订单已锁定名额，继续完成付款即可。",
            })
            return
          }
        } catch (listReason) {
          notifyCommandError(listReason, "找回待支付订单失败，请稍后刷新。")
          return
        }
      }
      if (commandErrorCode(reason) === WORKSPACE_MISMATCH_CODE) {
        // The switch landed server-side in another tab/device: repaint the
        // shell's standing so the local workspaceSwitched guard can engage.
        try {
          onOverviewChange?.(await accountHttp.accountListWorkspaces())
        } catch {
          // A failed repaint keeps the refusal toast as the only notice.
        }
      }
      notifyCommandError(reason, "下单失败，请稍后重试。")
    } finally {
      setBusy(false)
    }
  }

  async function refreshOrder(options?: { quiet?: boolean }) {
    const current = orderRef.current
    if (!current || current.status !== "pending" || refreshInFlight.current) return
    refreshInFlight.current = true
    if (!options?.quiet) setBusy(true)
    try {
      const next = await accountHttp.accountGetPaymentOrder(current.public_id)
      const latest = orderRef.current
      if (latest?.public_id !== current.public_id || latest.status !== "pending") return
      orderRef.current = next
      setOrder(next)
      if (next.status !== "pending") setCancelOpen(false)
      setAutoRefreshFailed(false)
      if (next.status === "paid") {
        notifySuccess("成员名额已到账")
        await syncPaidOverview()
      }
    } catch (reason) {
      if (options?.quiet) {
        setAutoRefreshFailed(true)
      } else {
        notifyCommandError(reason, "查询订单失败。")
      }
    } finally {
      refreshInFlight.current = false
      if (!options?.quiet) setBusy(false)
    }
  }

  /**
   * Explicit payment-entry recovery: Cloud asks the provider by merchant order
   * id before anything is re-created, then returns the row with its new
   * entry_state. A paid answer lands through the same settle path as polling.
   */
  async function recoverOrder() {
    const current = orderRef.current
    if (!current || current.status !== "pending") return
    setBusy(true)
    try {
      const next = await accountHttp.accountRecoverPaymentOrder(current.public_id)
      orderRef.current = next
      setOrder(next)
      if (next.status === "paid") {
        notifySuccess("成员名额已到账")
        await syncPaidOverview()
      } else if (next.entry_state === "ready") {
        notifySuccess("付款入口已找回", { description: "请继续完成付款。" })
      }
    } catch (reason) {
      notifyCommandError(reason, "找回付款入口失败。")
    } finally {
      setBusy(false)
    }
  }

  async function syncPaidOverview() {
    if (overviewSyncingRef.current) return
    overviewSyncingRef.current = true
    setOverviewSyncing(true)
    try {
      const overview = await accountHttp.accountListWorkspaces()
      if (overview.active_workspace?.uuid !== workspaceUuid) return
      setOverviewError(false)
      setOverviewReason(undefined)
      onOverviewChange?.(overview)
    } catch (reason) {
      setOverviewReason(() => reason)
      setOverviewError(true)
    } finally {
      overviewSyncingRef.current = false
      setOverviewSyncing(false)
    }
  }

  useVisiblePolling({
    enabled: order?.status === "pending",
    intervalMs: 3000,
    restartKey: order?.public_id ?? "",
    onPoll: () => {
      void refreshOrder({ quiet: true })
    },
  })

  async function cancelOrder() {
    const current = orderRef.current
    if (!current || current.status !== "pending") return
    setBusy(true)
    try {
      const next = await accountHttp.accountCancelPaymentOrder(current.public_id)
      orderRef.current = next
      setOrder(next)
      setCancelOpen(false)
      if (next.status === "paid") {
        notifySuccess("订单已付款，成员名额已到账")
        await syncPaidOverview()
      } else {
        notifySuccess("已取消待确认订单")
      }
    } catch (reason) {
      notifyCommandError(reason, "取消失败。")
    } finally {
      setBusy(false)
    }
  }

  async function openCheckout() {
    const current = orderRef.current
    if (!current || current.status !== "pending") return
    setBusy(true)
    try {
      await accountHttp.accountOpenPaymentOrder(current.public_id)
    } catch (reason) {
      notifyCommandError(reason, "无法打开托管收银台。")
    } finally {
      setBusy(false)
    }
  }

  // The lock is taken when the dialog opens, not in onOpenChange: the parent
  // owns `open`, so a controlled transition never fires the callback.
  useEffect(() => {
    if (!open || !workspaceUuid) return
    setLockedWorkspace((current) =>
      current ?? { uuid: workspaceUuid, name: workspaceName ?? workspaceUuid },
    )
    setQuantity(minSeats)
    setTerm("year")
    setProvider("")
    if (orderRef.current?.status === "pending") void refreshOrder()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, workspaceUuid, workspaceName])

  function changeOpen(next: boolean) {
    if (!next && overviewSyncingRef.current) return
    onOpenChange(next)
    if (!next) {
      setAcceptedPurchase(undefined)
      setReadingAgreement(undefined)
      setReadAgreementVersion(undefined)
      setLockedWorkspace(undefined)
      setProvider("")
      setCancelOpen(false)
      if (
        !overviewError &&
        orderRef.current &&
        orderRef.current.status !== "pending"
      ) {
        orderRef.current = undefined
        setOrder(undefined)
        setOrdersReload((value) => value + 1)
      }
    }
  }

  const pending = order?.status === "pending"
  const orderState = order
    ? paymentOrderPresentation(order.status, order.entry_state)
    : undefined
  const submitBlocked =
    !agreementAccepted ||
    !canPurchase ||
    busy ||
    ordersLoading ||
    ordersError ||
    workspaceSwitched ||
    !lockedWorkspace ||
    (!provider && !fullyCredited) ||
    (!renewal && workspaceFull) ||
    methodsLoading ||
    methodsError ||
    catalog === undefined ||
    amountCents === undefined

  return (
    <>
      <Dialog open={open} onOpenChange={changeOpen}>
        <DialogContent
          layout="panel"
          className="sm:max-w-3xl"
          showCloseButton={!overviewSyncing}
        >
          <div className="px-5 py-4">
            <DialogHeader>
              <DialogTitle className="text-md font-semibold">
                {readingAgreement ? readingAgreement.title : renewal ? `续费 ${plan.name}` : `升级为 ${plan.name}`}
              </DialogTitle>
              <DialogDescription>
                {readingAgreement
                  ? `版本 ${readingAgreement.version} · 生效日期 ${readingAgreement.effective_at}`
                  : renewal
                  ? `为${lockedWorkspace ? `「${lockedWorkspace.name}」` : "当前 Workspace"}续期 ${renewal.seats} 名成员席位，当前到期 ${lotDay(renewal.expires_at)}，续期从到期日顺延。`
                  : `为${lockedWorkspace ? `「${lockedWorkspace.name}」` : "当前 Workspace"}加购成员名额，每名成员含 ${storesPerSeat} 家店铺位。`}
              </DialogDescription>
            </DialogHeader>
          </div>

          {readingAgreement ? (
            <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-hidden border-t border-border px-5 py-4">
              <div
                tabIndex={-1}
                ref={agreementContentRef}
                aria-label="采购同意书正文"
                className="min-h-0 overflow-y-auto whitespace-pre-wrap text-sm leading-7 outline-none"
              >
                {readingAgreement.content}
              </div>
              {order?.purchase_agreement ? (
                <p className="text-xs text-muted-foreground">
                  本单同意时间：{order.purchase_agreement.accepted_at} · 操作者：{order.purchase_agreement.accepted_by}
                </p>
              ) : null}
              <div className="flex justify-end">
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => {
                    setReadingAgreement(undefined)
                    requestAnimationFrame(() => agreementLinkRef.current?.focus())
                  }}
                >
                  {order ? "返回订单" : "返回购买"}
                </Button>
              </div>
            </div>
          ) : order ? (
            <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto border-t border-border px-5 py-4">
              <div
                className="flex flex-wrap items-center justify-between gap-2"
                role="status"
                aria-live="polite"
              >
                <p className="font-mono text-sm">{order.public_id}</p>
                <StateChip
                  status={order.status}
                  label={orderState?.label}
                  tone={orderState?.tone}
                />
              </div>
              <p className="text-sm text-muted-foreground">
                {order.member_seats} 名成员 · {yuanLabel(order.unit_month_cents)} / 成员 / 月 ×{" "}
                {order.months} 个月
                {order.credit_cents > 0 ? (
                  <>
                    {" "}
                    = 原价 {yuanLabel(order.amount_cents + order.credit_cents)} · 原套餐折算抵扣 −
                    {yuanLabel(order.credit_cents)} · 应付 {yuanLabel(order.amount_cents)}
                  </>
                ) : (
                  <> = {yuanLabel(order.amount_cents)}</>
                )}{" "}
                · {paymentProviderLabel(order.provider)}
              </p>
              {order.purchase_agreement ? (
                <Button
                  ref={agreementLinkRef}
                  type="button"
                  variant="link"
                  onClick={() => setReadingAgreement(order.purchase_agreement ?? undefined)}
                >
                  查看本单采购同意书
                </Button>
              ) : null}
              {order.qr_code ? (
                <>
                  <AlipayQr value={order.qr_code} />
                  <p className="text-sm text-muted-foreground">
                    请扫码完成付款。到账后此页会自动更新。
                  </p>
                </>
              ) : order.remittance ? (
                <p className="text-sm text-muted-foreground">{order.remittance}</p>
              ) : pending && !order.pay_url ? (
                <div className="flex flex-col items-start gap-2">
                  <p className="text-sm text-muted-foreground">
                    {order.entry_state === "entry_confirming"
                      ? "该订单待渠道确认，成员名额已被保留。"
                      : "付款入口尚未确认，名额已被此订单保留。"}
                  </p>
                  <Button
                    type="button"
                    variant="outline"
                    disabled={busy || workspaceSwitched}
                    onClick={() => void recoverOrder()}
                  >
                    找回付款入口
                  </Button>
                </div>
              ) : null}
              {pending && order.pay_url ? (
                <Button
                  type="button"
                  variant="outline"
                  disabled={busy || workspaceSwitched}
                  onClick={() => void openCheckout()}
                >
                  在浏览器中继续支付
                </Button>
              ) : null}
              {autoRefreshFailed ? (
                <p className="text-sm text-muted-foreground" role="status">
                  订单状态尚未更新，可点「刷新状态」。
                </p>
              ) : null}
              <div className="mt-auto flex flex-col-reverse gap-2 border-t border-border pt-4 sm:flex-row sm:justify-end">
                {pending ? (
                  <>
                    <Button
                      type="button"
                      variant="outline"
                      disabled={busy || workspaceSwitched}
                      onClick={() => setCancelOpen(true)}
                    >
                      取消此订单
                    </Button>
                    <Button
                      type="button"
                      variant="default"
                      disabled={busy || workspaceSwitched}
                      aria-busy={busy}
                      onClick={() => void refreshOrder()}
                    >
                      {busy ? <Spinner data-icon="inline-start" /> : null}
                      刷新状态
                    </Button>
                  </>
                ) : (
                  <Button
                    type="button"
                    variant="default"
                    disabled={overviewSyncing}
                    aria-busy={overviewSyncing}
                    onClick={() => changeOpen(false)}
                  >
                    {overviewSyncing ? <Spinner data-icon="inline-start" /> : null}
                    {overviewSyncing ? "正在同步套餐" : "完成"}
                  </Button>
                )}
              </div>
            </div>
          ) : (
            <form
              onSubmit={submit}
              className="grid min-h-0 flex-1 gap-x-6 gap-y-5 overflow-y-auto border-t border-border px-5 py-4 sm:grid-cols-2"
            >
              {/* Left column: seat count + payment channel. A renewal keeps
                  the lot's seats — the count is fixed, not picked. */}
              <div className="flex flex-col gap-5">
                <div className="flex flex-col gap-2">
                  <span className="text-xs font-medium text-muted-foreground">
                    成员数量
                  </span>
                  {renewal ? (
                    <div className="rounded-lg border border-border/80 bg-muted/40 px-3.5 py-2.5 text-sm">
                      <span className="font-semibold tabular-nums">{renewal.seats}</span>{" "}
                      名成员 · {plan.name} · 续期不新增当前席位
                    </div>
                  ) : (
                    <>
                      <div className="flex items-center gap-2">
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon"
                          className="shrink-0"
                          aria-label="减少一名成员"
                          disabled={quantityClamped <= minSeats}
                          onClick={() =>
                            setQuantity((value) => clampQuantity(value - 1))
                          }
                        >
                          <Minus className="size-3.5" />
                        </Button>
                        <Input
                          type="number"
                          min={minSeats}
                          max={Math.max(minSeats, purchaseMax)}
                          value={quantityClamped}
                          onChange={(event) =>
                            setQuantity(clampQuantity(Number(event.target.value)))
                          }
                          className="min-w-0 flex-1 text-center font-mono tabular-nums"
                          aria-label="成员数量"
                        />
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon"
                          className="shrink-0"
                          aria-label="增加一名成员"
                          disabled={quantityClamped >= purchaseMax}
                          onClick={() =>
                            setQuantity((value) => clampQuantity(value + 1))
                          }
                        >
                          <Plus className="size-3.5" />
                        </Button>
                      </div>
                      {SEAT_QUICK_QUANTITIES.some((pick) => pick <= purchaseMax) ? (
                        <div
                          className="grid grid-cols-4 gap-1.5"
                          role="group"
                          aria-label="快捷数量"
                        >
                          {SEAT_QUICK_QUANTITIES.filter(
                            (pick) => pick <= purchaseMax,
                          ).map((pick) => {
                            const isSelected = quantityClamped === pick
                            return (
                              <button
                                key={pick}
                                type="button"
                                aria-pressed={isSelected ? "true" : "false"}
                                onClick={() => setQuantity(pick)}
                                className={cn(
                                  "h-7 rounded-md text-xs font-medium transition-colors cursor-pointer",
                                  isSelected
                                    ? "bg-brand text-brand-foreground hover:bg-brand/90"
                                    : "bg-muted/60 text-muted-foreground hover:bg-muted hover:text-foreground",
                                )}
                              >
                                {pick} 名成员
                              </button>
                            )
                          })}
                        </div>
                      ) : null}
                      <p className="text-xs leading-5 text-muted-foreground">
                        当前已购 {heldSeats} 名 · 上限 {maxSeats} 名
                        {workspaceFull ? "，名额已满。" : ""}
                      </p>
                    </>
                  )}
                </div>

                <div className="flex flex-col gap-2">
                  <span className="text-xs font-medium text-muted-foreground">
                    支付渠道
                  </span>
                  <PaymentChannelList
                    methods={methods}
                    loading={methodsLoading}
                    error={methodsError}
                    value={provider}
                    onChange={setProvider}
                    onRetry={() => setMethodsReload((v) => v + 1)}
                    emptyHint="管理员尚未开通支付渠道，可先用兑换码兑换名额。"
                  />
                </div>
              </div>

              {/* Right column: 账单选项 radio cards + 确认升级 summary. */}
              <div className="flex flex-col gap-5">
                <div className="flex flex-col gap-2">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-xs font-medium text-muted-foreground">
                      账单选项
                    </span>
                    <span className="text-meta text-muted-foreground">
                      按购买时间计时 · 非自然月
                    </span>
                  </div>
                  <div
                    className="flex flex-col gap-2"
                    role="radiogroup"
                    aria-label="账期"
                  >
                    {(catalog?.terms ?? []).map((option) => {
                      const isSelected = term === option.key
                      const termUnit = seatUnitMonthCents(catalog, tier, option.key)
                      const termDiscount =
                        option.discount_percent < 100
                          ? `${option.discount_percent / 10} 折`
                          : undefined
                      return (
                        <button
                          key={option.key}
                          type="button"
                          role="radio"
                          aria-checked={isSelected}
                          onClick={() => setTerm(option.key)}
                          className={cn(
                            "flex items-center gap-3 rounded-lg border px-3.5 py-2.5 text-left transition-all cursor-pointer",
                            isSelected
                              ? "border-brand/70 bg-brand-soft/40 ring-1 ring-brand/40 dark:border-brand/60 dark:bg-brand-soft/25 dark:ring-brand/30"
                              : "border-border/80 bg-background hover:bg-muted/40",
                          )}
                        >
                          <span
                            className={cn(
                              "flex size-4 shrink-0 items-center justify-center rounded-full border transition-all",
                              isSelected
                                ? "border-brand bg-brand text-brand-foreground"
                                : "border-muted-foreground/40",
                            )}
                          >
                            {isSelected ? (
                              <span className="size-1.5 rounded-full bg-brand-foreground" />
                            ) : null}
                          </span>
                          <span className="min-w-0 flex-1">
                            <span className="block text-sm font-medium text-foreground">
                              {seatTermLabel(option.key)}
                              <span className="ml-1.5 text-xs font-normal text-muted-foreground">
                                （{option.days} 天）
                              </span>
                            </span>
                            <span className="block text-xs text-muted-foreground">
                              {termDiscount !== undefined &&
                              listUnitMonthCents !== undefined ? (
                                <span className="mr-1 line-through opacity-70">
                                  {yuanLabel(listUnitMonthCents)}
                                </span>
                              ) : null}
                              {termUnit !== undefined
                                ? `${yuanLabel(termUnit)} / 成员 / 月 · `
                                : ""}
                              按购买时间计 {option.days} 天
                            </span>
                          </span>
                          {termDiscount !== undefined ? (
                            <span className="shrink-0 rounded-md bg-brand-soft px-1.5 py-0.5 text-meta font-semibold text-brand-ink">
                              {termDiscount}
                            </span>
                          ) : null}
                        </button>
                      )
                    })}
                  </div>
                </div>

                <div className="flex flex-col gap-2">
                  <span className="text-xs font-medium text-muted-foreground">
                    {renewal ? "确认续费" : "确认升级"}
                  </span>
                  <div className="flex flex-col gap-3 rounded-lg border border-border p-4">
                    <div className="flex items-baseline gap-2">
                      {hasDiscount && listAmountCents !== undefined ? (
                        <span className="font-mono text-base text-muted-foreground line-through tabular-nums">
                          {yuanLabel(listAmountCents)}
                        </span>
                      ) : null}
                      <span className="font-mono text-2xl font-bold tabular-nums tracking-tight">
                        {payableCents !== undefined ? yuanLabel(payableCents) : "—"}
                      </span>
                      {discountLabel ? (
                        <span className="rounded-md bg-brand-soft px-1.5 py-0.5 text-meta font-semibold text-brand-ink">
                          {discountLabel}
                        </span>
                      ) : null}
                    </div>
                    {creditCents > 0 ? (
                      <div className="flex items-center justify-between text-xs">
                        <span className="text-muted-foreground">
                          原套餐折算抵扣
                          {forfeitedCents > 0
                            ? `（剩余价值 ${yuanLabel(creditCents)}，超出部分作废）`
                            : ""}
                        </span>
                        <span className="font-mono tabular-nums text-brand-ink">
                          −{yuanLabel(appliedCreditCents)}
                        </span>
                      </div>
                    ) : null}
                    <p className="text-xs leading-5 text-muted-foreground">
                      {unitMonthCents !== undefined && activeTerm
                        ? `${yuanLabel(unitMonthCents)} / 成员 / 月 × ${seatCount} 名成员 × ${activeTerm.months} 个月（${activeTerm.days} 天）`
                        : "套餐目录读取中…"}
                      {renewal
                        ? ` · 续期后到期日从 ${lotDay(renewal.expires_at)} 顺延 ${activeTerm?.days ?? 0} 天`
                        : ` · 加购后 ${nextSeats} 名成员 · ${nextStores} 家店铺`}
                      {creditCents > 0 && amountCents !== undefined
                        ? ` · 原价 ${yuanLabel(amountCents)}`
                        : ""}
                    </p>
                    <p className="border-t border-border/60 pt-3 text-meta leading-5 text-muted-foreground">
                      {renewal
                        ? "续期批次在该批次到期日开始生效，按购买时间独立计时；支付成功后立即追加，不占用当前席位上限。"
                        : supersededLots.length > 0
                          ? `升级后总席位 = 本次 ${seatCount} 席；${supersededLots.length} 个更低档批次（${supersededSeats} 席）将在结算时折算终止。`
                          : `购买后总席位 = 现有已购 ${heldSeats} 席 + 本次 ${seatCount} 席 = ${nextSeats} 席。免费版 1 席为默认兜底，付费批次生效后不与免费席叠加。`}
                      {seatOverride != null && !renewal
                        ? ` 当前管理员覆盖为 ${seatOverride} 席，实际可用席位以覆盖值为准。`
                        : ""}
                      {fullyCredited
                        ? " 抵扣已覆盖本单原价，提交后立即到账，无需支付。"
                        : " 提交后生成待支付订单，支付成功后实时到账；实付以订单回显为准。"}
                    </p>
                    <div className="flex flex-col gap-2">
                      <div className="flex items-center gap-2 text-sm">
                        <Checkbox
                          id={agreementId}
                          checked={agreementAccepted}
                          disabled={busy || !agreementAvailable || readAgreementVersion !== agreement?.version}
                          aria-label="我已阅读并同意采购同意书"
                          aria-describedby={`${agreementId}-hint`}
                          onCheckedChange={(checked) => setAcceptedPurchase(checked ? purchaseKey : undefined)}
                        />
                        <div>
                          <label htmlFor={agreementId}>我已阅读并同意</label>
                          <Button
                            ref={agreementLinkRef}
                            type="button"
                            variant="link"
                            size="sm"
                            disabled={busy || !agreementAvailable}
                            onClick={() => {
                              if (!agreement) return
                              setReadingAgreement(agreement)
                              setReadAgreementVersion(agreement.version)
                            }}
                          >
                            《采购同意书》
                          </Button>
                        </div>
                      </div>
                      <p id={`${agreementId}-hint`} className="text-xs text-muted-foreground">
                        {agreementAccepted ? "已同意本次采购" : "请先阅读并同意采购同意书"}
                      </p>
                    </div>
                    <Button
                      type="submit"
                      variant="default"
                      disabled={submitBlocked}
                      aria-busy={busy}
                      className="h-10 w-full font-semibold"
                    >
                      {busy ? <Spinner data-icon="inline-start" /> : null}
                      {fullyCredited
                        ? "0 元升级 · 无需支付"
                        : renewal
                          ? `续费 ${plan.name}`
                          : `升级为 ${plan.name}`}
                    </Button>
                    <button
                      type="button"
                      onClick={() => {
                        changeOpen(false)
                        onOpenRedeem?.()
                      }}
                      className="mx-auto text-xs font-medium text-muted-foreground underline-offset-4 transition-colors hover:text-foreground hover:underline"
                    >
                      有兑换码？点此兑换
                    </button>
                  </div>
                </div>
              </div>
            </form>
          )}
        </DialogContent>
      </Dialog>
      <ConfirmDialog
        open={cancelOpen}
        onOpenChange={setCancelOpen}
        title="取消这笔待支付订单？"
        description="在线支付会先核对收款状态，渠道确认关闭后才能取消；EasyPay 需在渠道侧关闭交易。"
        confirmText="取消订单"
        busy={busy}
        onConfirm={() => void cancelOrder()}
      />
    </>
  )
}

import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"
import { fileURLToPath } from "node:url"
import { renderToStaticMarkup } from "react-dom/server"

import type {
  AccountOverview,
  PaymentOrderView,
  RedeemResultView,
  SeatCatalogData,
  WorkspaceBillingOverviewData,
} from "../src/bindings/commands"
import {
  MAX_MEMBER_SEATS_PER_WORKSPACE,
  PLAN_CATALOG,
  SEAT_QUICK_QUANTITIES,
  normalizePlanKey,
  seatCatalogTerm,
  seatCatalogTier,
  seatUnitMonthCents,
} from "../src/features/plans/plan-catalog"
import {
  PlansScreen,
  paymentOrderPresentation,
  pendingPaymentOrder,
  redeemSuccessNotice,
  seatTierSummary,
} from "../src/features/plans/plans-screen"
import { RedeemCodeForm } from "../src/features/plans/redeem-code-dialog"

const plansSource = readFileSync(
  fileURLToPath(new URL("../src/features/plans/plans-screen.tsx", import.meta.url)),
  "utf8",
)

const catalogSource = readFileSync(
  fileURLToPath(new URL("../src/features/plans/plan-catalog.ts", import.meta.url)),
  "utf8",
)

/** Mirrors the `SeatCatalogData` projection `GET /api/plans` serves — the
 * wire shape is what matters here, not where the numbers come from. */
const CATALOG: SeatCatalogData = {
  tiers: [
    {
      key: "pro",
      list_unit_month_cents: 10_000,
      official_mcp: false,
      terms: [
        { term: "month", unit_month_cents: 10_000 },
        { term: "quarter", unit_month_cents: 10_000 },
        { term: "year", unit_month_cents: 8_000 },
      ],
    },
    {
      key: "max",
      list_unit_month_cents: 15_000,
      official_mcp: true,
      terms: [
        { term: "month", unit_month_cents: 15_000 },
        { term: "quarter", unit_month_cents: 15_000 },
        { term: "year", unit_month_cents: 12_000 },
      ],
    },
    {
      key: "ultra",
      list_unit_month_cents: 20_000,
      official_mcp: true,
      terms: [
        { term: "month", unit_month_cents: 20_000 },
        { term: "quarter", unit_month_cents: 20_000 },
        { term: "year", unit_month_cents: 16_000 },
      ],
    },
  ],
  terms: [
    { key: "month", months: 1, days: 30, discount_percent: 100 },
    { key: "quarter", months: 3, days: 90, discount_percent: 100 },
    { key: "year", months: 12, days: 365, discount_percent: 80 },
  ],
  min_seats_per_purchase: 1,
  max_seats_per_purchase: 20,
  max_seats_per_workspace: 20,
  stores_per_seat: 5,
  free_stores: 1,
  max_stores_per_workspace: 100,
}

const BILLING_FREE: WorkspaceBillingOverviewData = {
  plan: "lite",
  purchased_seats: 0,
  member_seats: { default: 1, effective: 1, used: 1, suspended: 0 },
  store_slots: { default: 1, effective: 1, used: 0, suspended: 0 },
  lots: [],
  upgrade_credits: [],
}

const overview = {
  session: {
    authenticated: true,
    email: "seller@example.invalid",
    name: "Seller",
    role: "owner",
  },
  entitlement: {
    plan: "pro",
    features: {
      ai_relay: true,
      ocr: true,
      batch_listing: true,
      field_package: true,
    },
    limits: {
      stores: 10,
      stores_used: 1,
      seats: 8,
      seats_used: 1,
      s3_upload_bytes_monthly: 155692564480,
      s3_upload_bytes_used: 0,
      ai_tokens_monthly: 0,
      ai_tokens_used: 0,
      ai_calls_per_day: 1000,
    },
  },
  active_workspace: {
    id: 1,
    uuid: "550e8400-e29b-41d4-a716-446655440000",
    name: "演示 Workspace",
    plan: "pro",
    role: "owner",
    is_owned: true,
  },
  workspaces: [],
  account_mode: "owner",
  owned_count: 1,
  owned_limit: 3,
} satisfies AccountOverview

test("plan-catalog keeps display mapping only — no price book survives", () => {
  assert.deepEqual(
    PLAN_CATALOG.map(({ key }) => key),
    ["lite", "pro", "max", "ultra"],
  )
  // A tier row is key/name/tagline — the fixed seat/stores presets are gone.
  assert.deepEqual(Object.keys(PLAN_CATALOG[0]).sort(), ["key", "name", "tagline"])
  assert.deepEqual([...SEAT_QUICK_QUANTITIES], [1, 5, 10, 20])
  assert.equal(normalizePlanKey("free"), "lite")
  assert.equal(normalizePlanKey("LITE"), "lite")
  assert.equal(normalizePlanKey("enterprise"), undefined)
  // No second price book: nothing in the module prices or discounts a quote.
  assert.doesNotMatch(catalogSource, /_CENTS\b/)
  assert.doesNotMatch(catalogSource, /discount_percent/)
  assert.doesNotMatch(catalogSource, /10_000|15_000|20_000|\* 0\.8|\b80\b/)
  // The only policy constant left is the admin form's seat clamp.
  assert.equal(MAX_MEMBER_SEATS_PER_WORKSPACE, 20)
})

test("the seat catalog answers every quote input from the wire shape", () => {
  assert.equal(seatCatalogTier(CATALOG, "pro")?.list_unit_month_cents, 10_000)
  assert.equal(seatCatalogTier(CATALOG, "pro")?.official_mcp, false)
  assert.equal(seatCatalogTier(CATALOG, "max")?.official_mcp, true)
  assert.equal(seatUnitMonthCents(CATALOG, "pro", "year"), 8_000)
  assert.equal(seatUnitMonthCents(CATALOG, "ultra", "year"), 16_000)
  assert.equal(seatUnitMonthCents(CATALOG, "ultra", "month"), 20_000)
  assert.equal(seatCatalogTerm(CATALOG, "year")?.days, 365)
  assert.equal(seatCatalogTerm(CATALOG, "year")?.discount_percent, 80)
  // A tier the catalog does not sell is not a seat class.
  assert.equal(seatCatalogTier(CATALOG, "lite"), undefined)
  assert.equal(
    seatTierSummary(CATALOG),
    "Plus 版 ¥100 / 成员 / 月；商业版 ¥150 / 成员 / 月；企业版 ¥200 / 成员 / 月；年付 8 折",
  )
})

test("plans screen sells member seats of a picked tier and term", () => {
  const html = renderToStaticMarkup(
    <PlansScreen overview={overview} catalog={CATALOG} billingOverview={BILLING_FREE} />,
  )
  assert.match(html, /成员名额/)
  // The pinned current-plan card renders price + unit contiguously; the
  // compare columns keep the unit in its own muted span.
  assert.match(html, /¥100 \/ 成员 \/ 月/)
  assert.match(html, /¥150/)
  assert.match(html, /¥200/)
  assert.match(html, /\/ 成员 \/ 月/)
  assert.match(html, /每名成员含 5 个店铺位/)
  assert.match(html, /随时可加购到 20 名成员（100 家店铺）/)
  assert.match(html, /年付 8 折/)
  // Real tier difference: the official MCP gate comes from the catalog.
  assert.match(html, /官方 MCP/)
  // The comparison table has no annual-discount row and no excluded feature:
  // field packs ship on every tier now.
  assert.doesNotMatch(html, /年付折扣/)
  assert.match(html, /月付按标价计费/)
  assert.match(html, /季付按标价计费/)
  // Picking a paid tier opens the upgrade dialog instead of a page panel.
  assert.match(html, />升级</)
  assert.match(html, /识图按钱包扣费/)
  assert.match(html, /本月计数只作用量展示/)
  assert.match(html, /按购买时间/)
  assert.match(html, /非按月份大小计算/)
  assert.doesNotMatch(html, /当前上限/)
  assert.doesNotMatch(html, /兑换码加额按有效期/)
  assert.doesNotMatch(html, /店铺包装/)
  assert.doesNotMatch(html, /额度用尽后无法识图/)
  assert.doesNotMatch(html, /识别额度/)
  assert.doesNotMatch(html, /Free/)
  assert.doesNotMatch(html, /待定/)
  assert.doesNotMatch(html, /缴费开通 1 个 Workspace/)
  assert.doesNotMatch(html, /套餐/)
})

test("the billing overview lists unexpired lots each with its own 续费", () => {
  const billing: WorkspaceBillingOverviewData = {
    plan: "pro",
    purchased_seats: 8,
    member_seats: { default: 8, effective: 8, used: 2, suspended: 1 },
    store_slots: { default: 40, effective: 40, used: 3, suspended: 0 },
    plan_expires_at: "2026-12-31T00:00:00.000Z",
    next_change: {
      at: "2026-12-31T00:00:00.000Z",
      plan: "lite",
      effective_seats: 1,
      effective_stores: 1,
      suspended_members: 1,
      suspended_stores: 2,
    },
    lots: [
      {
        id: 7,
        tier: "pro",
        seats: 5,
        starts_at: "2026-01-01T00:00:00.000Z",
        expires_at: "2026-12-31T00:00:00.000Z",
        upgrade_credit_cents: 6_667,
        active: true,
        renewable: true,
      },
      {
        id: 9,
        tier: "max",
        seats: 3,
        starts_at: "2026-06-01T00:00:00.000Z",
        expires_at: "2026-09-01T00:00:00.000Z",
        renews_lot_id: 7,
        upgrade_credit_cents: 0,
        active: true,
        renewable: false,
      },
    ],
    upgrade_credits: [
      { tier: "pro", credit_cents: 0 },
      { tier: "max", credit_cents: 6_667 },
      { tier: "ultra", credit_cents: 6_667 },
    ],
  }
  const html = renderToStaticMarkup(
    <PlansScreen overview={overview} catalog={CATALOG} billingOverview={billing} />,
  )
  assert.match(html, /成员席位批次/)
  assert.match(html, /已购 8 席/)
  assert.match(html, /有效 8 · 已用 2 · 暂停 1/)
  assert.match(html, /店铺 3\/40/)
  assert.match(html, /Plus 版 · 5 席/)
  assert.match(html, /商业版 · 3 席/)
  assert.match(html, /生效中/)
  assert.match(html, /已续期/, "a lot with a successor is not renewable")
  // 批次列表读出服务端算好的剩余价值，不在这里重新定价。
  assert.match(html, /可折 ¥66.67/)
  // The renewable lot carries a 续费 action.
  assert.match(html, /续费/)
  assert.match(html, /下次变化/)
  assert.match(html, /届时 1 名成员 \/ 2 家店铺将暂停/)
  assert.match(html, /最晚到期/)
})

test("the upgrade dialog is the same checkout for purchase and renewal", () => {
  // The dialog body only mounts while open, so pin its structure on source.
  assert.match(plansSource, /sm:max-w-3xl/)
  assert.match(plansSource, /升级为 \$\{plan\.name\}/)
  assert.match(plansSource, /续费 \$\{plan\.name\}/)
  assert.match(plansSource, /成员数量/)
  assert.match(plansSource, /支付渠道/)
  assert.match(plansSource, /账单选项/)
  assert.match(plansSource, /确认升级/)
  assert.match(plansSource, /确认续费/)
  assert.match(plansSource, /快捷数量/)
  assert.match(plansSource, /accountGetPaymentMethods\(\)/)
  assert.match(plansSource, /hasDiscount/)
  assert.match(plansSource, /line-through/)
  assert.match(plansSource, /按购买时间计时 · 非自然月/)
  assert.doesNotMatch(plansSource, /在线快速加购/)
  // B6: the additive purchase equation replaces the old fixed-presets copy.
  assert.match(plansSource, /购买后总席位 = 现有已购/)
  // B7: the renewal intent is the existing binding with the lot id pinned.
  assert.match(plansSource, /accountCreateRenewalIntent\(\{/)
  assert.match(plansSource, /renews_lot_id: renewal\.id/)
  assert.match(plansSource, /到期日从 \$\{lotDay\(renewal\.expires_at\)\} 顺延/)
})

test("a workspace at the 20-seat ceiling cannot add more", () => {
  const full: AccountOverview = {
    ...overview,
    entitlement: {
      ...overview.entitlement,
      plan: "ultra",
      limits: { ...overview.entitlement.limits, stores: 100, seats: 20 },
    },
    active_workspace: overview.active_workspace
      ? { ...overview.active_workspace, plan: "ultra" }
      : undefined,
  }
  const billing: WorkspaceBillingOverviewData = {
    ...BILLING_FREE,
    plan: "ultra",
    purchased_seats: 20,
    member_seats: { default: 20, effective: 20, used: 20, suspended: 0 },
    store_slots: { default: 100, effective: 100, used: 20, suspended: 0 },
  }
  const html = renderToStaticMarkup(
    <PlansScreen overview={full} catalog={CATALOG} billingOverview={billing} />,
  )
  assert.match(html, /该工作空间已有 20 个成员名额，上限 20 个/)
})

test("the default badge is lite, and a stored free reads as lite", () => {
  for (const stored of ["lite", "free"]) {
    const trial: AccountOverview = {
      ...overview,
      entitlement: overview.entitlement
        ? {
            ...overview.entitlement,
            plan: stored,
            limits: { ...overview.entitlement.limits, stores: 1, seats: 1 },
          }
        : undefined,
      active_workspace: overview.active_workspace
        ? { ...overview.active_workspace, plan: stored }
        : undefined,
    }
    const html = renderToStaticMarkup(
      <PlansScreen overview={trial} catalog={CATALOG} billingOverview={BILLING_FREE} />,
    )
    assert.match(html, /免费版/, stored)
    assert.match(html, /默认 · 1 名成员 · 1 家店铺/, stored)
    assert.match(html, /年付 8 折/, stored)
    assert.match(html, /暂无付费席位批次/, stored)
    assert.doesNotMatch(html, /Free/, stored)
    assert.doesNotMatch(html, /试用/, stored)
    // The free badge cannot be bought; the paid columns offer 升级.
    assert.match(html, /默认/, stored)
    assert.match(html, />升级</, stored)
  }
})

test("member cannot open a slot purchase", () => {
  const member: AccountOverview = {
    ...overview,
    active_workspace: overview.active_workspace
      ? { ...overview.active_workspace, role: "member", is_owned: false }
      : undefined,
    account_mode: "member",
    owned_count: 0,
    owned_limit: 1,
  }
  const html = renderToStaticMarkup(
    <PlansScreen overview={member} catalog={CATALOG} billingOverview={BILLING_FREE} />,
  )
  assert.match(html, /只有自有 Workspace 的所有者可以加购/)
  assert.doesNotMatch(html, /确认下单/)
})

test("manager cannot redeem an owner-only code", () => {
  // Redemption moved off the plans page into the Workspace menu's dialog; the
  // menu still gates it on the active Workspace role.
  const menuSource = readFileSync(
    fileURLToPath(new URL("../src/components/workspace-switcher.tsx", import.meta.url)),
    "utf8",
  )
  assert.match(menuSource, /canRedeem=\{active\?\.role === "owner"\}/)
  const html = renderToStaticMarkup(<RedeemCodeForm canRedeem={false} />)
  assert.match(html, /只有 Workspace 所有者可以兑换/)
  assert.doesNotMatch(html, /所有者或管理员可以兑换/)
})

test("redemption notices distinguish wallet credits and member seats", () => {
  const base: RedeemResultView = {
    plan_key: "lite",
    plan_name: "Free",
    member_seats: 0,
    ocr_credits: 0,
    wallet_cents: 0,
    replaced_lots: 0,
    replaced_seats: 0,
  }
  assert.deepEqual(redeemSuccessNotice({ ...base, wallet_cents: 12_345 }), {
    title: "已兑换 ¥123.45 钱包额度",
    description: "余额已充入工作空间创建者的钱包，其所有工作空间共用，余额不过期。",
  })
  assert.match(
    redeemSuccessNotice({ ...base, member_seats: 10, plan_name: "Pro" }).title,
    /10 个成员名额 · Pro/,
  )
  const replaced = redeemSuccessNotice({
    ...base,
    member_seats: 1,
    plan_name: "Ultra",
    replaced_lots: 2,
    replaced_seats: 6,
    plan_expires_at: "2027-01-01T00:00:00.000Z",
  })
  assert.match(replaced.description, /原有 2 个生效批次（共 6 席）已终止/)
})

test("pending orders are selected once and use localized state chips", () => {
  const order = (status: string): PaymentOrderView => ({
    public_id: `po_550e8400-e29b-41d4-a716-44665544000${status.length}`,
    plan: "pro",
    member_seats: 10,
    months: 12,
    unit_month_cents: 1800,
    duration_days: 365,
    amount_cents: 216_000,
    credit_cents: 0,
    currency: "CNY",
    provider: "manual",
    status,
    entry_state: status === "pending" ? "ready" : status,
    created_at: "2026-08-24T00:00:00.000Z",
  })
  const pending = order("pending")
  assert.equal(pendingPaymentOrder([order("paid"), pending]), pending)
  assert.deepEqual(paymentOrderPresentation("pending"), {
    label: "待支付",
    tone: "flight",
  })
  assert.equal(paymentOrderPresentation("paid").label, "已到账")
  assert.equal(paymentOrderPresentation("canceled").label, "已取消")
  // A pending order's entry_state narrows the chip.
  assert.equal(
    paymentOrderPresentation("pending", "entry_unknown").label,
    "待确认",
  )
  assert.equal(
    paymentOrderPresentation("pending", "entry_confirming").label,
    "待渠道确认",
  )
})

test("checkout is resolved by order id instead of a renderer URL", () => {
  assert.match(plansSource, /accountListPaymentOrders\(\{ status: "pending" \}\)/)
  assert.match(plansSource, /accountOpenPaymentOrder\(current\.public_id\)/)
  assert.doesNotMatch(plansSource, /window\.open\(/)
})

test("pending payment keeps polling after the dialog or module is left", () => {
  assert.match(plansSource, /enabled: order\?\.status === "pending"/)
  assert.doesNotMatch(
    plansSource,
    /enabled: Boolean\(active && open && order\?\.status === "pending"\)/,
  )
})

test("settled orders refresh the overview and dismiss stale cancellation", () => {
  // Dialog load, manual refresh, cancel, explicit entry recovery, and a create
  // whose credit covered the whole price (settled inside the request) are the
  // five places a settle can land.
  assert.equal(plansSource.match(/await syncPaidOverview\(\)/g)?.length, 5)
  assert.match(
    plansSource,
    /if \(detail\.status !== "pending"\) setCancelOpen\(false\)/,
  )
  assert.match(
    plansSource,
    /if \(next\.status !== "pending"\) setCancelOpen\(false\)/,
  )
  // Settled-order failures ride the live toast (with a retry action), never
  // a role="alert" block in the dialog.
  assert.doesNotMatch(plansSource, /role="alert"/)
  assert.match(plansSource, /成员名额已到账，但套餐概览尚未更新/)
  assert.match(plansSource, /onClick: \(\) => void syncPaidOverview\(\)/)
  assert.match(plansSource, /notifyLive\(\{/)
  assert.match(
    plansSource,
    /if \(!next && overviewSyncingRef\.current\) return/,
  )
  assert.match(plansSource, /if \(overviewSyncingRef\.current\) return/)
  assert.match(plansSource, /!overviewError &&/)
  assert.match(plansSource, /overviewSyncing \? "正在同步套餐" : "完成"/)
  assert.match(plansSource, /showCloseButton=\{!overviewSyncing\}/)
})

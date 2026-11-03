import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"
import { renderToStaticMarkup } from "react-dom/server"

import { OrdersScreen } from "../src/features/orders/orders-screen"
import { filterOrders, orderEntitlement, sortOrdersByTime } from "../src/features/orders/orders-model"
import type { AdminPaymentOrderView } from "../src/bindings/commands"

test("confirming a remittance refreshes the shell overview", () => {
  const source = readFileSync(
    new URL("../src/features/orders/orders-screen.tsx", import.meta.url),
    "utf8",
  )
  const confirm = source.slice(source.indexOf("async function confirm("))
  assert.match(confirm, /adminConfirmOrder/)
  assert.match(confirm, /await reload\(\)/)
  assert.match(confirm, /await onSessionMayChange\?\.\(\)/)
  const shell = readFileSync(
    new URL("../src/app/settings-page.tsx", import.meta.url),
    "utf8",
  )
  assert.match(shell, /<OrdersScreen\s+onSessionMayChange=\{refreshOverview\}\s*\/>/)
})

test("admin orders screen lists confirm and cancel actions after load", () => {
  const html = renderToStaticMarkup(<OrdersScreen />)
  assert.match(html, /正在加载订单/)

  const source = readFileSync(
    new URL("../src/features/orders/orders-screen.tsx", import.meta.url),
    "utf8",
  )
  assert.match(source, /<TableHead>单号</)
  assert.match(source, /<TableHead>金额</)
  assert.match(source, /确认收款/)
  assert.match(source, /取消/)
})

test("order filters combine status, workspace, search, and inclusive local dates", () => {
  const makeOrder = (overrides: Partial<AdminPaymentOrderView>): AdminPaymentOrderView => ({
    public_id: "order-1",
    org_id: 1,
    workspace_name: "同名空间",
    created_by_email: "owner@example.com",
    plan: "pro",
    months: 1,
    amount_cents: 100,
    currency: "CNY",
    provider: "manual",
    status: "pending",
    created_at: new Date(2026, 9, 28, 23, 59).toISOString(),
    ...overrides,
  })
  const orders = [
    makeOrder({}),
    makeOrder({ public_id: "order-2", org_id: 2 }),
    makeOrder({ public_id: "order-3", status: "paid" }),
    makeOrder({ public_id: "order-4", created_at: new Date(2026, 9, 29, 0, 0).toISOString() }),
    makeOrder({ public_id: "order-5", created_at: "unknown" }),
    makeOrder({ public_id: "order-6", status: "future-status" }),
  ]
  const filters = { status: "pending" as const, query: "专业版", workspace: "1", from: "2026-10-28", to: "2026-10-28" }
  assert.deepEqual(filterOrders(orders, filters).map((order) => order.public_id), ["order-1"])
  assert.deepEqual(filterOrders(orders, { ...filters, status: "all", query: "ORDER-6", from: "", to: "" }).map((order) => order.public_id), ["order-6"])
  assert.deepEqual(sortOrdersByTime([orders[4]!, orders[3]!, orders[0]!], "asc").map((order) => order.public_id), ["order-1", "order-4", "order-5"])
  assert.deepEqual(sortOrdersByTime([orders[4]!, orders[3]!, orders[0]!], "desc").map((order) => order.public_id), ["order-4", "order-1", "order-5"])
  assert.equal(orderEntitlement(makeOrder({ plan: "wallet_topup", months: 1 })), "钱包充值")
  assert.equal(orderEntitlement(makeOrder({ plan: "new_product", months: 1 })), "new_product")
})

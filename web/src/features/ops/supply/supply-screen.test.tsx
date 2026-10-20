import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"
import { renderToStaticMarkup } from "react-dom/server"

import type {
  SupplyListView,
  SupplyOrderView,
  SupplyWarehouseStockView,
} from "@/bindings/commands"

import {
  EMPTY_SUPPLY_LIST,
  formatCount,
  formatTimeslot,
  runSupplyRead,
  statusTotal,
  supplyStateLabel,
  warehouseDisplayName,
  type SupplyReadState,
} from "./supply-model"
import { SupplyOrdersTable, WarehouseStocksTable } from "./supply-screen"

const transit: SupplyOrderView = {
  order_id: "9007199254740993",
  order_number: "00-0001-2489176-001",
  state: "IN_TRANSIT",
  created_date: "2026-08-12T08:11:00Z",
  timeslot_from: "2026-08-18T06:00:00Z",
  timeslot_to: "2026-08-18T14:00:00Z",
  timeslot_timezone: "Europe/Moscow",
  target_warehouse_id: "9007199254740993",
  target_warehouse_name: "Хоругвино",
  dropoff_warehouse_name: "Хоругвино кросс-док",
  item_count: 144,
  sku_count: 2,
  item_count_error: "",
}

const longName: SupplyOrderView = {
  ...transit,
  order_id: "9002",
  order_number: "00-0001-2489176-002",
  state: "READY_TO_SUPPLY",
  timeslot_from: "",
  timeslot_to: "",
  timeslot_timezone: "",
  target_warehouse_name:
    "Тверь — распределительный центр имени очень длинного русского названия склада",
  item_count: 3,
}

const bundleFailed: SupplyOrderView = {
  ...transit,
  order_id: "9003",
  order_number: "00-0001-2489176-003",
  item_count: 0,
  item_count_error: "PERMISSION_DENIED",
}

const horugvino: SupplyWarehouseStockView = {
  warehouse_id: "9007199254740993",
  name: "Хоругвино",
  present: 12920,
  reserved: 324,
  promised: 500,
  sku_count: 2,
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((accept) => {
    resolve = accept
  })
  return { promise, resolve }
}

function supplyPage(orders: SupplyOrderView[], patch: Partial<SupplyListView> = {}): SupplyListView {
  return { ...EMPTY_SUPPLY_LIST, orders, ...patch }
}

test("supply state labels stay on the six-tone vocabulary", () => {
  assert.equal(supplyStateLabel("IN_TRANSIT"), "运输中")
  assert.equal(supplyStateLabel("COMPLETED"), "已完成")
  assert.equal(supplyStateLabel("ORDER_STATE_X"), "ORDER_STATE_X")
  assert.equal(statusTotal([{ state: "IN_TRANSIT", count: 4 }, { state: "COMPLETED", count: 2 }]), 6)
})

test("a roster-driven Store switch fences older supply reads", () => {
  const source = readFileSync(new URL("./supply-screen.tsx", import.meta.url), "utf8")
  const branch = source.match(
    /if \(selected !== current\) \{([\s\S]*?)setStoreUid\(selected\)/,
  )?.[1]
  assert.ok(branch)
  assert.match(branch, /ordersSequence\.current \+= 1/)
  assert.match(branch, /warehousesSequence\.current \+= 1/)
})

test("a timeslot without bounds is an em dash, not a fabricated window", () => {
  assert.equal(formatTimeslot(longName), "—")
  assert.match(formatTimeslot(transit), /09:00.*Europe\/Moscow/)
  assert.equal(formatCount(12920), "12,920")
})

test("the orders table shows identity, warehouse, state, window and count", () => {
  const html = renderToStaticMarkup(
    <SupplyOrdersTable orders={[transit, longName]} loading={false} />,
  )
  assert.match(html, /00-0001-2489176-001/)
  assert.match(html, /Хоругвино/)
  assert.match(html, /运输中/)
  assert.match(html, /144/)
  assert.match(html, /2 SKU/)
  assert.match(html, /9007199254740993/)
  assert.match(html, /распределительный центр/)
  assert.match(html, /line-clamp-2/)
  assert.match(html, /xl:hidden[^>]*>时间窗 /)
  assert.match(html, /aria-label="详情 00-0001-2489176-001"/)
  assert.doesNotMatch(html, /title="Хоругвино"/)
})

test("an empty order page is empty, not an error", () => {
  const html = renderToStaticMarkup(
    <SupplyOrdersTable orders={[]} loading={false} />,
  )
  assert.match(html, /没有供货单/)
  assert.doesNotMatch(html, /暂无数据/)
})

test("a loading order page says it is reading Ozon", () => {
  const html = renderToStaticMarkup(
    <SupplyOrdersTable orders={[]} loading={true} />,
  )
  assert.match(html, /正在读取供货单/)
})

test("a failed supply read rides the live toast, never the table", () => {
  const source = readFileSync(new URL("./supply-screen.tsx", import.meta.url), "utf8")
  assert.doesNotMatch(source, /role="alert"/)
  assert.doesNotMatch(source, /\{error\}/)
  assert.match(source, /notifyLive\(\{/)
  assert.match(source, /SUPPLY_READ_LIVE = "supply-read"/)
})

test("a bundle failure prints Ozon's reason instead of a zero count", () => {
  const html = renderToStaticMarkup(
    <SupplyOrdersTable orders={[bundleFailed]} loading={false} />,
  )
  assert.match(html, /PERMISSION_DENIED/)
  assert.doesNotMatch(html, />0</)
})

test("warehouse stock is a count, not a percentage", () => {
  const html = renderToStaticMarkup(
    <WarehouseStocksTable warehouses={[horugvino]} loading={false} />,
  )
  assert.match(html, /12,920/)
  assert.match(html, /9007199254740993/)
  assert.doesNotMatch(html, /%/)
  assert.equal(
    warehouseDisplayName({ ...horugvino, name: "" }),
    "warehouse_id 9007199254740993",
  )
})

test("an empty warehouse roster is empty", () => {
  const html = renderToStaticMarkup(
    <WarehouseStocksTable warehouses={[]} loading={false} />,
  )
  assert.match(html, /没有仓库存/)
})

test("late reads cannot replace the newest committed supply snapshot", async () => {
  const first = deferred<SupplyListView>()
  const second = deferred<SupplyListView>()
  let generation = 1
  let state: SupplyReadState<SupplyListView> = {
    view: EMPTY_SUPPLY_LIST,
    loading: false,
    error: "",
  }
  const setState = (
    update: (previous: SupplyReadState<SupplyListView>) => SupplyReadState<SupplyListView>,
  ) => {
    state = update(state)
  }
  const stale = runSupplyRead({
    request: () => first.promise,
    isCurrent: () => generation === 1,
    setState,
    fallback: "failed",
  })
  generation = 2
  const current = runSupplyRead({
    request: () => second.promise,
    isCurrent: () => generation === 2,
    setState,
    fallback: "failed",
  })

  second.resolve(supplyPage([longName]))
  assert.equal(await current, true)
  first.resolve(supplyPage([transit]))
  assert.equal(await stale, false)
  assert.equal(state.view.orders[0]?.order_id, longName.order_id)
  assert.equal(state.loading, false)
})

test("a failed refresh preserves the painted snapshot and exposes actionable copy", async () => {
  const snapshot = supplyPage([transit], { last_id: "opaque cursor", has_more: true })
  const reason = { message: "RATE_LIMIT_EXCEEDED", serverCode: "RATE_LIMITED", traceId: "supply-trace" }
  let state: SupplyReadState<SupplyListView> = {
    view: snapshot,
    loading: false,
    error: "",
  }
  const loaded = await runSupplyRead<SupplyListView>({
    request: async () => {
      throw reason
    },
    isCurrent: () => true,
    setState: (update) => {
      state = update(state)
    },
    fallback: "读取订单失败，请稍后重试",
  })

  assert.equal(loaded, false)
  assert.equal(state.view, snapshot)
  assert.equal(state.error, "读取订单失败，请稍后重试")
  assert.equal(state.loading, false)
  assert.equal(state.reason, reason)
  await runSupplyRead({
    request: async () => snapshot,
    isCurrent: () => true,
    setState: (update) => { state = update(state) },
    fallback: "读取订单失败，请稍后重试",
  })
  assert.equal(state.reason, undefined)
  assert.equal(state.error, "")
})

test("an empty next page closes pagination without advancing the snapshot", async () => {
  const snapshot = supplyPage([transit], { last_id: "opaque cursor", has_more: true })
  let state: SupplyReadState<SupplyListView> = {
    view: snapshot,
    loading: false,
    error: "",
  }
  const advanced = await runSupplyRead({
    request: async () => EMPTY_SUPPLY_LIST,
    isCurrent: () => true,
    setState: (update) => {
      state = update(state)
    },
    fallback: "failed",
    accept: (next) => next.orders.length > 0,
    reject: (current) => ({ ...current, has_more: false }),
  })

  assert.equal(advanced, false)
  assert.equal(state.view.orders[0]?.order_id, transit.order_id)
  assert.equal(state.view.last_id, "opaque cursor")
  assert.equal(state.view.has_more, false)
})

test("orders and warehouses settle independently", async () => {
  let orders: SupplyReadState<SupplyListView> = {
    view: supplyPage([transit]),
    loading: false,
    error: "",
  }
  let warehouses: SupplyReadState<SupplyWarehouseStockView[]> = {
    view: [horugvino],
    loading: false,
    error: "",
  }
  await Promise.all([
    runSupplyRead<SupplyListView>({
      request: async () => supplyPage([longName]),
      isCurrent: () => true,
      setState: (update) => {
        orders = update(orders)
      },
      fallback: "orders failed",
    }),
    runSupplyRead<SupplyWarehouseStockView[]>({
      request: async () => {
        throw new Error("warehouse failed")
      },
      isCurrent: () => true,
      setState: (update) => {
        warehouses = update(warehouses)
      },
      fallback: "warehouse failed",
    }),
  ])

  assert.equal(orders.view.orders[0]?.order_id, longName.order_id)
  assert.equal(orders.error, "")
  assert.equal(warehouses.view[0]?.warehouse_id, horugvino.warehouse_id)
  assert.equal(warehouses.error, "warehouse failed")
})

test("tables expose busy semantics without hiding committed rows", () => {
  const orders = renderToStaticMarkup(
    <SupplyOrdersTable orders={[transit]} loading={true} />,
  )
  const warehouses = renderToStaticMarkup(
    <WarehouseStocksTable warehouses={[horugvino]} loading={false} />,
  )
  assert.match(orders, /aria-busy="true"/)
  assert.doesNotMatch(orders, /role="alert"/)
  assert.match(orders, /00-0001-2489176-001/)
  assert.doesNotMatch(warehouses, /role="alert"/)
  assert.match(warehouses, /role="region"/)
  assert.match(warehouses, /aria-label="各仓库存表"/)
  assert.match(warehouses, /tabindex="0"/)
  assert.match(warehouses, /max-h-\[32rem\]/)
})

test("leaving Supply fences both Seller reads and keeps a single app title", () => {
  const source = readFileSync(new URL("./supply-screen.tsx", import.meta.url), "utf8")
  const cleanup = source.match(/return \(\) => \{([\s\S]*?)\n\s*\}/)?.[1] ?? ""
  assert.match(cleanup, /ordersSequence\.current \+= 1/)
  assert.match(cleanup, /warehousesSequence\.current \+= 1/)
  assert.doesNotMatch(source, /<h1/)
  assert.match(source, /from "@\/components\/ui\/tabs"/)
  assert.match(source, /from "@\/components\/ui\/table"/)
  assert.match(source, /aria-label=\{`详情 \$\{orderIdentity\(order\)\}`\}/)
  assert.doesNotMatch(source, /tabIndex=\{-1\}/)
  assert.doesNotMatch(source, /space-y-/)
  assert.match(source, /aria-live="polite"/)
})

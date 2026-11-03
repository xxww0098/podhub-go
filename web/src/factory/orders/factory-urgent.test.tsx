import assert from "node:assert/strict"
import test from "node:test"
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"

import { deadlineInstant, isUrgent } from "@/factory/lib/order"
import { FactoryOrders, type FactoryOrdersProps } from "./factory-orders"

const now = Date.parse("2026-10-29T08:00:00Z")
const base: FactoryOrdersProps = {
  view: "urgent",
  rows: [],
  now,
  search: "",
  onSearchChange: () => {},
  hasPrevious: false,
  hasNext: false,
  onPrevious: () => {},
  onNext: () => {},
  onOpenOrder: () => {},
  onRetry: () => {},
}

test("加急只包含待接单或生产中的临期及催单", () => {
  const dueSoon = { deadline: "2026-10-29T20:00:00Z", nudge_count: 0 }
  assert.equal(isUrgent({ ...dueSoon, state: "dispatched" }, now), true)
  assert.equal(isUrgent({ ...dueSoon, state: "accepted" }, now), true)
  assert.equal(isUrgent({ state: "accepted", nudge_count: 1 }, now), true)
  assert.equal(isUrgent({ state: "dispatched", deadline: "2026-10-29T20:00:01Z" }, now), false)
  for (const state of ["shipped", "rejected", "cancelled", "unknown"]) {
    assert.equal(isUrgent({ ...dueSoon, state, nudge_count: 1 }, now), false, state)
  }
})

test("截止时间只接受有效日期和带时区时间", () => {
  assert.equal(deadlineInstant("2026-10-29"), Date.parse("2026-10-29T23:59:59Z"))
  assert.equal(deadlineInstant("2026-10-29T18:00:00+08:00"), Date.parse("2026-10-29T10:00:00Z"))
  assert.equal(deadlineInstant("2026-10-29T10:00:00"), null)
  assert.equal(deadlineInstant("2026-02-30"), null)
  assert.equal(deadlineInstant("2026-02-30T10:00:00Z"), null)
  assert.equal(isUrgent({ state: "dispatched", deadline: "2026-02-30T10:00:00Z" }, now), false)
})

test("加急清单显示真实生产状态、倒计时、催单和订单详情入口", () => {
  const html = renderToStaticMarkup(createElement(FactoryOrders, {
    ...base,
    rows: [
      {
        dispatch_id: "dispatch-a", dispatch_no: "F-A", posting_number: "P-A", state: "dispatched",
        deadline: "2026-10-29T10:00:00Z", nudge_count: 1,
        lines: [{ name: "T 恤", offer_id: "offer-a", quantity: 2 }],
      },
      {
        dispatch_id: "dispatch-b", dispatch_no: "F-B", posting_number: "P-B", state: "accepted",
        nudge_count: 1, lines: [{ name: "帆布袋", offer_id: "offer-b", quantity: 1 }],
      },
    ],
  }))
  assert.match(html, /aria-label="加急订单列表"/)
  assert.match(html, /待接单/)
  assert.match(html, /生产中/)
  assert.match(html, /剩余 2 小时 0 分/)
  assert.match(html, /临近截止、被催单/)
  assert.match(html, /aria-label="按订单状态筛选"/)
  assert.match(html, /aria-label="按加急原因筛选"/)
  assert.match(html, /aria-label="查看订单 F-A"/)
  assert.match(html, /aria-label="查看订单 F-B"/)
})

test("加急清单区分空结果和搜索无结果", () => {
  const empty = renderToStaticMarkup(createElement(FactoryOrders, base))
  const searched = renderToStaticMarkup(createElement(FactoryOrders, { ...base, search: "不存在" }))
  assert.match(empty, /暂无加急订单/)
  assert.match(searched, /没有找到匹配的订单/)
  assert.doesNotMatch(searched, /暂无加急订单/)
  const filtered = renderToStaticMarkup(createElement(FactoryOrders, { ...base, urgentReason: "nudge" }))
  assert.match(filtered, /没有找到匹配的订单/)
})

test("加急分页按接口游标状态启用，并提供有名称的刷新与分页操作", () => {
  const first = renderToStaticMarkup(createElement(FactoryOrders, { ...base, hasNext: true }))
  const last = renderToStaticMarkup(createElement(FactoryOrders, { ...base, hasPrevious: true }))
  const button = (html: string, label: string) =>
    (html.match(/<button\b[^>]*>/g) ?? []).find((item) => item.includes(`aria-label="${label}"`)) ?? ""
  assert.match(button(first, "上一页"), /\sdisabled=""/)
  assert.doesNotMatch(button(first, "下一页"), /\sdisabled=""/)
  assert.doesNotMatch(button(last, "上一页"), /\sdisabled=""/)
  assert.match(button(last, "下一页"), /\sdisabled=""/)
  assert.match(first, /aria-label="刷新加急订单"/)
})

import assert from "node:assert/strict"
import test from "node:test"
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"

import { FactoryOrders, type FactoryOrdersProps } from "./factory-orders"

const base: FactoryOrdersProps = {
  view: "pending",
  rows: [],
  now: Date.parse("2026-10-29T08:00:00Z"),
  search: "",
  onSearchChange: () => {},
  hasPrevious: false,
  hasNext: false,
  onPrevious: () => {},
  onNext: () => {},
  onOpenOrder: () => {},
  onRetry: () => {},
}

test("订单表展示真实数据及状态，分页遵循服务端结果", () => {
  const html = renderToStaticMarkup(createElement(FactoryOrders, {
    ...base,
    hasNext: true,
    rows: [{
      dispatch_id: "dispatch-1", dispatch_no: "F001", posting_number: "P001", state: "dispatched",
      deadline: "2026-10-29T10:00:00Z", nudge_count: 1,
      lines: [{ name: "帆布袋", offer_id: "offer-1", quantity: 2 }],
    }],
  }))
  assert.match(html, /F001/)
  assert.match(html, /帆布袋/)
  assert.match(html, /待接单/)
  assert.match(html, /在催/)
  assert.match(html, /加急/)
  assert.match(html, /aria-sort="ascending"[^>]*>[^<]*<span[^>]*>剩余时间/)
  assert.match(html, /aria-label="查看订单 F001"/)
  const previous = html.match(/<button[^>]*aria-label="上一页"[^>]*>/)?.[0] ?? ""
  const next = html.match(/<button[^>]*aria-label="下一页"[^>]*>/)?.[0] ?? ""
  assert.match(previous, /\sdisabled=""/)
  assert.ok(next)
  assert.doesNotMatch(next, /\sdisabled=""/)
})

test("读取失败不会呈现成功的空列表", () => {
  const html = renderToStaticMarkup(createElement(FactoryOrders, { ...base, error: "订单读取失败" }))
  assert.match(html, /role="alert"/)
  assert.match(html, /重试/)
  assert.doesNotMatch(html, /暂无待生产订单/)
})

test("已发货列表不显示剩余时间或加急", () => {
  const html = renderToStaticMarkup(createElement(FactoryOrders, {
    ...base,
    view: "shipped",
    rows: [{
      dispatch_id: "dispatch-2", dispatch_no: "F002", posting_number: "P002", state: "shipped",
      deadline: "2026-10-01", nudge_count: 1,
      lines: [{ name: "T 恤", offer_id: "offer-2", quantity: 1 }],
    }],
  }))
  assert.match(html, /已发货/)
  assert.doesNotMatch(html, /剩余时间|加急|在催/)
})

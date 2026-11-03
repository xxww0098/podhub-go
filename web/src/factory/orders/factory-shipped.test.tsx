import assert from "node:assert/strict"
import test from "node:test"
import { Children, isValidElement, type ReactNode } from "react"
import { renderToStaticMarkup } from "react-dom/server"

import { FactoryOrders, type FactoryOrdersProps } from "./factory-orders"

const base: FactoryOrdersProps = {
  view: "shipped",
  now: Date.parse("2026-10-29T08:00:00Z"),
  rows: [{
    dispatch_id: "sent-1", dispatch_no: "F001", posting_number: "P001", state: "shipped",
    deadline: "2026-10-28T08:00:00Z", nudge_count: 2,
    lines: [{ name: "帆布袋", offer_id: "bag-1", quantity: 2 }],
  }],
  search: "",
  onSearchChange: () => {},
  hasPrevious: false,
  hasNext: true,
  onPrevious: () => {},
  onNext: () => {},
  onOpenOrder: () => {},
  onRetry: () => {},
}

type ClickProps = { children?: ReactNode; "aria-label"?: string; onClick?: () => void }
function findClick(node: ReactNode, label: string): (() => void) | undefined {
  let found: (() => void) | undefined
  Children.forEach(node, (child) => {
    if (found || !isValidElement<ClickProps>(child)) return
    found = child.props["aria-label"] === label
      ? child.props.onClick
      : findClick(child.props.children, label)
  })
  return found
}

function buttonFor(html: string, label: string): string {
  return (html.match(/<button\b[^>]*>/g) ?? [])
    .find((button) => button.includes(`aria-label="${label}"`)) ?? ""
}

test("已发货订单仅展示真实订单信息，详情按钮传递派发单 ID", () => {
  let opened = ""
  const props = { ...base, onOpenOrder: (id: string) => { opened = id } }
  const html = renderToStaticMarkup(FactoryOrders(props))
  assert.match(html, /F001/)
  assert.match(html, /帆布袋/)
  assert.match(html, /已发货/)
  assert.doesNotMatch(html, /剩余时间|加急|在催|确认发货|2026-10-28/)
  const click = findClick(FactoryOrders(props), "查看订单 F001")
  assert.ok(click)
  click()
  assert.equal(opened, "sent-1")
})

test("已发货分页按游标及加载状态启用，下一页调用提供的操作", () => {
  let nextCalls = 0
  const props = { ...base, onNext: () => { nextCalls += 1 } }
  const firstPage = renderToStaticMarkup(FactoryOrders(props))
  assert.match(buttonFor(firstPage, "上一页"), /\sdisabled=""/)
  assert.doesNotMatch(buttonFor(firstPage, "下一页"), /\sdisabled=""/)
  const click = findClick(FactoryOrders(props), "下一页")
  assert.ok(click)
  click()
  assert.equal(nextCalls, 1)
  const lastPage = renderToStaticMarkup(FactoryOrders({ ...props, hasPrevious: true, hasNext: false }))
  assert.doesNotMatch(buttonFor(lastPage, "上一页"), /\sdisabled=""/)
  assert.match(buttonFor(lastPage, "下一页"), /\sdisabled=""/)
  const loading = renderToStaticMarkup(FactoryOrders({ ...props, loading: true }))
  assert.match(buttonFor(loading, "下一页"), /\sdisabled=""/)
})

test("已发货空状态、搜索无结果和读取失败互相区分", () => {
  const empty = renderToStaticMarkup(FactoryOrders({ ...base, rows: [], hasNext: false }))
  assert.match(empty, /暂无已发货订单/)
  const search = renderToStaticMarkup(FactoryOrders({ ...base, rows: [], search: "无结果", hasNext: false }))
  assert.match(search, /没有找到匹配的订单/)
  assert.doesNotMatch(search, /暂无已发货订单/)
  const failure = renderToStaticMarkup(FactoryOrders({ ...base, rows: [], error: "订单读取失败", hasNext: false }))
  assert.match(failure, /role="alert"/)
  assert.match(failure, /重试/)
  assert.doesNotMatch(failure, /暂无已发货订单/)
})

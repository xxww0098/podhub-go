import assert from "node:assert/strict"
import test from "node:test"
import { Children, isValidElement, type ReactNode } from "react"
import { renderToStaticMarkup } from "react-dom/server"

import { FactoryOrders, type FactoryOrdersProps } from "./factory-orders"

const base: FactoryOrdersProps = {
  view: "producing",
  now: Date.parse("2026-10-29T08:00:00Z"),
  rows: [
    {
      dispatch_id: "production-1", dispatch_no: "F001", posting_number: "P001", state: "accepted",
      deadline: "2026-10-29T14:00:00Z", nudge_count: 0,
      lines: [{ name: "帆布袋", offer_id: "bag-1", quantity: 2 }],
    },
    {
      dispatch_id: "production-2", dispatch_no: "F002", posting_number: "P002", state: "accepted",
      deadline: null, nudge_count: 0,
      lines: [{ name: "马克杯", offer_id: "cup-1", quantity: 1 }],
    },
  ],
  search: "",
  onSearchChange: () => {},
  hasPrevious: false,
  hasNext: false,
  onPrevious: () => {},
  onNext: () => {},
  onOpenOrder: () => {},
  onRetry: () => {},
}

function rowFor(html: string, dispatch_no: string): string {
  const rows = html.match(/<tr\b[^>]*>[\s\S]*?<\/tr>/g) ?? []
  return rows.find((row) => row.includes(dispatch_no)) ?? ""
}

function buttonFor(html: string, label: string): string {
  const buttons = html.match(/<button\b[^>]*>/g) ?? []
  return buttons.find((button) => button.includes(`aria-label="${label}"`)) ?? ""
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

test("生产中展示订单状态、临期标记和未知截止时间", () => {
  const html = renderToStaticMarkup(FactoryOrders(base))
  const urgent = rowFor(html, "F001")
  const noDeadline = rowFor(html, "F002")
  assert.match(urgent, /生产中/)
  assert.match(urgent, /剩余 6 小时 0 分/)
  assert.match(urgent, /加急/)
  assert.match(noDeadline, /生产中/)
  assert.match(noDeadline, /—/)
  assert.doesNotMatch(noDeadline, /加急|超时/)
  assert.match(urgent, /aria-label="查看订单 F001"/)
})

test("生产中分页依据游标状态禁用，并在加载时禁止翻页", () => {
  const lastPage = renderToStaticMarkup(FactoryOrders({ ...base, hasPrevious: true }))
  assert.doesNotMatch(buttonFor(lastPage, "上一页"), /\sdisabled=""/)
  assert.match(buttonFor(lastPage, "下一页"), /\sdisabled=""/)
  const loading = renderToStaticMarkup(FactoryOrders({ ...base, loading: true, hasPrevious: true, hasNext: true }))
  assert.match(buttonFor(loading, "上一页"), /\sdisabled=""/)
  assert.match(buttonFor(loading, "下一页"), /\sdisabled=""/)
})

test("生产中把催单信息保留在该订单，即使没有截止时间", () => {
  const rows = base.rows.map((row) => row.dispatch_id === "production-2" ? { ...row, nudge_count: 1 } : row)
  const html = renderToStaticMarkup(FactoryOrders({ ...base, rows }))
  const nudged = rowFor(html, "F002")
  assert.match(nudged, /在催/)
  assert.match(nudged, /加急/)
  assert.doesNotMatch(nudged, /剩余 0/)
})

test("生产中详情按钮传入所选派发单 ID", () => {
  let opened = ""
  const tree = FactoryOrders({ ...base, onOpenOrder: (id) => { opened = id } })
  const click = findClick(tree, "查看订单 F001")
  assert.ok(click)
  click()
  assert.equal(opened, "production-1")
})

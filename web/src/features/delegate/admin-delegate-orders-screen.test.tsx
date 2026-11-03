import assert from "node:assert/strict"
import test from "node:test"
import { renderToStaticMarkup } from "react-dom/server"

import { AdminDelegateOrdersTable } from "./admin-delegate-orders-screen"

test("管理员委托单保留真实厂家、取消状态和键盘可用的查看入口", () => {
  const html = renderToStaticMarkup(<AdminDelegateOrdersTable rows={[{
    order_id: "order-1", org_id: 12, store_id: "store-1", posting_number: "POST-001",
    state: "in_production", cancel_requested: true, line_count: 2,
    source_names: ["一厂", "二厂"], created_at_ms: 1_755_000_000_000, updated_at_ms: 1_755_000_000_000,
  }]} onOpen={() => {}} />)
  assert.match(html, /POST-001/)
  assert.match(html, /一厂、二厂/)
  assert.match(html, /生产中/)
  assert.match(html, /请求取消/)
  assert.match(html, /aria-label="查看委托单 POST-001"/)
})

test("空队列仍保留表头并区分本页搜索无匹配", () => {
  const html = renderToStaticMarkup(<AdminDelegateOrdersTable rows={[]} emptyText="本页没有匹配的物流单号。" onOpen={() => {}} />)
  assert.match(html, /委托单队列/)
  assert.match(html, /物流单号/)
  assert.match(html, /工作空间 ID/)
  assert.match(html, /本页没有匹配的物流单号。/)
})

import assert from "node:assert/strict"
import test from "node:test"
import { renderToStaticMarkup } from "react-dom/server"
import { FactoryDashboard } from "./factory-dashboard"

const now = Date.parse("2026-10-29T08:00:00Z")
const callbacks = { onOpenOrder: () => {}, onOpenList: () => {} }

test("统计未知时不显示零订单或空列表成功状态", () => {
  const html = renderToStaticMarkup(<FactoryDashboard urgent_orders={[]} now={now} {...callbacks} />)
  assert.match(html, /订单统计暂不可用/)
  assert.match(html, /加急订单暂不可用/)
  assert.doesNotMatch(html, /暂无加急订单/)
})

test("已读取统计与真实订单按各自状态显示，加急不作为额外分布项", () => {
  const html = renderToStaticMarkup(<FactoryDashboard
    counts={{ pending: 2, producing: 1, urgent: 1, shipped: 0 }}
    urgent_orders={[{
      dispatch_id: "one", dispatch_no: "P-001", posting_number: "P", state: "accepted",
      deadline: "2026-10-29T10:00:00Z", lines: [{ name: "帆布袋", offer_id: "bag", quantity: 2 }],
    }]}
    now={now}
    {...callbacks}
  />)
  assert.match(html, /待生产，2 单/)
  assert.match(html, /生产中，1 单/)
  assert.match(html, /加急，1 单/)
  assert.match(html, /已发货，0 单/)
  assert.match(html, /帆布袋/)
  assert.match(html, /× 2/)
  assert.match(html, /2 小时/)
  assert.match(html, /查看 P-001 详情/)
  assert.match(html, /含待生产和生产中订单/)
  assert.doesNotMatch(html, /<img/)
})

test("真实零加急才展示空状态", () => {
  const html = renderToStaticMarkup(<FactoryDashboard counts={{ pending: 0, producing: 0, urgent: 0, shipped: 0 }} urgent_orders={[]} now={now} {...callbacks} />)
  assert.match(html, /暂无加急订单/)
})

test("订单图的刻度覆盖最大值，条形不会溢出", () => {
  const html = renderToStaticMarkup(<FactoryDashboard counts={{ pending: 1, producing: 100, urgent: 0, shipped: 3 }} urgent_orders={[]} now={now} {...callbacks} />)
  const widths = [...html.matchAll(/style="width:([\d.]+)%"/g)].map((match) => Number(match[1]))
  assert.equal(widths.length, 3)
  assert.ok(widths.every((width) => width >= 0 && width <= 100))
  assert.match(html, />102<\/span>/)
})

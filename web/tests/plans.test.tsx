import assert from "node:assert/strict"
import test from "node:test"
import { renderToStaticMarkup } from "react-dom/server"
import { PlansScreen, subscriptionDate } from "../src/features/plans/plans-screen"
import { subscriptionFixture, subscriptionOverview } from "./fixtures/subscription"

test("subscription separates current capacity, future paid services and unpaid renewal", () => {
  const html = renderToStaticMarkup(<PlansScreen overview={subscriptionOverview} subscription={subscriptionFixture} />)
  assert.match(html, /当前可用店铺/)
  assert.match(html, /8 家/)
  assert.match(html, /已付款的未来服务/)
  assert.match(html, /6 家店铺/)
  assert.match(html, /下次续费配置/)
  assert.match(html, /¥120\/月/)
  assert.match(html, /保存配置不代表已经付款/)
  assert.match(html, /调整下期店铺数量/)
  assert.match(html, /恢复为 8 家，预览补差/)
  assert.doesNotMatch(html, /成员席位批次|年付 8 折|每名成员含 5 个店铺/)
})

test("billing dates use Shanghai even when the browser is in another timezone", () => {
  assert.match(subscriptionDate("2026-11-21T02:00:00Z"), /2026\/11\/21 10:00/)
  assert.equal(subscriptionDate(null), "—")
})

test("viewing a subscription does not give members purchase controls", () => {
  const overview = { ...subscriptionOverview, active_workspace: { ...subscriptionOverview.active_workspace!, role: "member" } }
  const html = renderToStaticMarkup(<PlansScreen overview={overview} subscription={subscriptionFixture} />)
  assert.match(html, /只有工作区所有者或管理员可以管理订阅/)
  assert.doesNotMatch(html, />调整下期店铺数量</)
})

test("an expired subscription displays actual free capacity despite a saved paid renewal", () => {
  const expired = { ...subscriptionFixture, status: "expired" as const, plan_key: "free", stores: { used: 7, limit: 1 }, extra_stores: 0, periods: [], current_end: null }
  const html = renderToStaticMarkup(<PlansScreen overview={subscriptionOverview} subscription={expired} />)
  assert.match(html, /付费服务已到期/)
  assert.match(html, />购买套餐</)
  assert.match(html, /6 家店铺/)
  assert.doesNotMatch(html, />续费套餐与加购</)
})

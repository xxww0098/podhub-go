import assert from "node:assert/strict"
import test from "node:test"
import { renderToStaticMarkup } from "react-dom/server"
import { PlansScreen, subscriptionDate } from "../src/features/plans/plans-screen"
import { subscriptionFixture, subscriptionOverview } from "./fixtures/subscription"

test("subscription separates current capacity, future paid services and unpaid renewal", () => {
  const html = renderToStaticMarkup(<PlansScreen overview={subscriptionOverview} subscription={subscriptionFixture} />)
  assert.match(html, /当前可用店铺/)
  assert.match(html, /已连接 7 \/ 8 家/)
  assert.match(html, /8 家/)
  assert.match(html, /已付款的未来服务/)
  assert.match(html, /6 家店铺/)
  assert.match(html, /下次续费配置/)
  assert.match(html, /按当前配置续费/)
  assert.match(html, /入门版 · 8 家店铺/)
  assert.match(html, /¥160\/月/)
  assert.match(html, />续费</)
  assert.match(html, /本期扩容 \/ 升级/)
  assert.doesNotMatch(html, /调整下期容量|修改下期配置|恢复为|保存配置不代表已经付款/)
  assert.match(html, />续费订阅<\/button>/)
  assert.doesNotMatch(html, /data-slot="subscription-editor"/)
  assert.match(html, /aria-expanded="false"[^>]*[^<]*>查看套餐对比</)
  assert.match(html, /1 \/ 10 人/)
  assert.doesNotMatch(html, /额外成员|成员席位批次|年付 8 折|每名成员含 5 个店铺|加购|套餐自带/)
  assert.doesNotMatch(html, />1 家店铺</)
})

test("billing dates use Shanghai even when the browser is in another timezone", () => {
  assert.match(subscriptionDate("2026-11-21T02:00:00Z"), /2026\/11\/21 10:00/)
  assert.equal(subscriptionDate(null), "—")
})

test("a free workspace does not claim that a paid renewal has been configured", () => {
  const free = { ...subscriptionFixture, status: "free" as const, plan_key: "free", stores: { used: 0, limit: 1 }, periods: [], current_end: null, term_end: null }
  const html = renderToStaticMarkup(<PlansScreen overview={subscriptionOverview} subscription={free} />)
  assert.match(html, /永久免费/)
  assert.match(html, />购买套餐</)
  assert.doesNotMatch(html, /下次续费配置|按当前配置续费/)
  assert.doesNotMatch(html, /当前额度可用至/)
})

test("viewing a subscription does not give members purchase controls", () => {
  const overview = { ...subscriptionOverview, active_workspace: { ...subscriptionOverview.active_workspace!, role: "member" } }
  const html = renderToStaticMarkup(<PlansScreen overview={overview} subscription={subscriptionFixture} />)
  assert.match(html, /只有工作区所有者或管理员可以管理订阅/)
  assert.doesNotMatch(html, />续费<|本期扩容/)
  assert.doesNotMatch(html, /data-slot="subscription-editor"/)
})

test("an expired subscription displays actual free capacity and offers only a fresh purchase", () => {
  const expired = { ...subscriptionFixture, status: "expired" as const, plan_key: "free", stores: { used: 7, limit: 1 }, periods: [], current_end: null }
  const html = renderToStaticMarkup(<PlansScreen overview={subscriptionOverview} subscription={expired} />)
  assert.match(html, /付费服务已到期/)
  assert.match(html, />购买套餐</)
  assert.doesNotMatch(html, /下次续费配置|按当前配置续费/)
  assert.doesNotMatch(html, />续费订阅</)
})

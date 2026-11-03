import assert from "node:assert/strict"
import test from "node:test"
import { renderToStaticMarkup } from "react-dom/server"

import type { SubscriptionOrder } from "@/bindings/http-subscription"
import { SubscriptionPaymentOrder } from "./subscription-payment-order"
import { PlansScreen } from "./plans-screen"
import { subscriptionFixture, subscriptionOverview } from "../../../tests/fixtures/subscription"
import { invalidateAccountOverview, peekAccountOverview, rememberAccountOverview } from "@/features/account/account-overview-cache"

const baseOrder: SubscriptionOrder = {
  public_id: "po_qa_subscription", status: "pending", amount_cents: 12000, reconciliation_reason: null,
  purchase_agreement: { version: "agreement-1", title: "购买确认", effective_at: "2026-10-27T00:00:00Z", content: "测试", accepted_at: "2026-10-27T00:00:00Z", accepted_by: "qa@example.invalid" },
}
function renderOrder(order?: SubscriptionOrder, error?: string) {
  return renderToStaticMarkup(<SubscriptionPaymentOrder order={order} publicId="po_qa_subscription" loading={false} error={error} onRefresh={() => {}} onRecover={() => {}} />)
}

test("stored subscription payment entries use the existing QR and hosted checkout controls", () => {
  const order = { ...baseOrder, provider: "alipay", entry_state: "ready", qr_code: "https://pay.example.invalid/qr", pay_url: "https://pay.example.invalid/checkout" }
  const html = renderOrder(order)
  assert.match(html, /aria-label="扫码付款码"/)
  assert.match(html, /在浏览器中继续支付/)
  assert.match(html, /支付宝/)
  assert.match(html, /查询支付结果 \/ 找回入口/)
  assert.doesNotMatch(html, /收款已记录|请将单号交给运营/)
})

test("unconfirmed channel results keep the original order and never display a payable or paid entry", () => {
  const html = renderOrder({ ...baseOrder, provider: "alipay", entry_state: "entry_confirming" })
  assert.match(html, /待渠道确认/)
  assert.match(html, /继续查询原订单，避免重复付款/)
  assert.match(html, /查询支付结果 \/ 找回入口/)
  assert.doesNotMatch(html, /扫码付款码|在浏览器中继续支付|收款已记录/)
})

test("manual orders and settled orders have distinct instructions", () => {
  const manual = { ...baseOrder, provider: "manual", entry_state: "manual" }
  assert.match(renderOrder(manual), /请将单号交给运营核对付款/)
  assert.doesNotMatch(renderOrder(manual), /查询支付结果 \/ 找回入口/)
  const paid = { ...manual, status: "paid", entry_state: "closed", qr_code: "old-qr" }
  assert.match(renderOrder(paid), /收款已记录/)
  assert.doesNotMatch(renderOrder(paid), /扫码付款码|在浏览器中继续支付|请将单号交给运营/)
})

test("read failures mark retained order data as unconfirmed and remain retryable", () => {
  const html = renderOrder({ ...baseOrder, provider: "manual" }, "连接失败")
  assert.match(html, /支付状态读取失败，当前信息未确认最新状态/)
  assert.match(html, /po_qa_subscription/)
  assert.match(html, /刷新状态/)
  assert.doesNotMatch(html, /收款已记录/)
})

test("pending subscription orders block another purchase until the existing order is resolved", (t) => {
  const previous = peekAccountOverview()
  t.after(() => { if (previous) rememberAccountOverview(previous); else invalidateAccountOverview() })
  rememberAccountOverview(subscriptionOverview)
  const html = renderToStaticMarkup(<PlansScreen overview={subscriptionOverview} subscription={{ ...subscriptionFixture, pending_order: true, pending_public_id: "po_qa_subscription" }} />)
  assert.match(html, /<button[^>]*disabled[^>]*>续费订阅<\/button>/)
  assert.match(html, /订阅付款订单/)
  assert.match(html, /正在读取订单与付款入口/)
  assert.doesNotMatch(html, /data-slot="subscription-editor"/)
  assert.ok(html.indexOf('aria-label="订阅付款订单"') < html.indexOf('aria-label="下次续费配置"'))
})

test("the current cached member permission takes priority over an older owner prop", (t) => {
  const previous = peekAccountOverview()
  t.after(() => { if (previous) rememberAccountOverview(previous); else invalidateAccountOverview() })
  rememberAccountOverview({ ...subscriptionOverview, active_workspace: { ...subscriptionOverview.active_workspace!, role: "member" } })
  const html = renderToStaticMarkup(<PlansScreen overview={subscriptionOverview} subscription={subscriptionFixture} />)
  assert.match(html, /只有工作区所有者或管理员可以管理订阅/)
  assert.doesNotMatch(html, /<button[^>]*>续费订阅<\/button>/)
})

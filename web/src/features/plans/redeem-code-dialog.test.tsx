import assert from "node:assert/strict"
import test from "node:test"
import { renderToStaticMarkup } from "react-dom/server"

import { RedeemCodeForm, redeemSuccessNotice } from "./redeem-code-dialog"

test("describes a scheduled plan without presenting it as wallet credit", () => {
  const notice = redeemSuccessNotice({ ok: true, wallet_cents: 0, plan_key: "pro", plan_stores: 3, plan_months: 6, starts_at: "2026-11-01T00:00:00Z", ends_at: "2027-05-01T00:00:00Z" })
  assert.match(notice.title, /专业版 · 3 家店铺 · 6 个月/)
  assert.match(notice.description, /生效时间/)
  assert.doesNotMatch(notice.title, /钱包/)
})

test("explains that paid time is retained", () => {
  const html = renderToStaticMarkup(<RedeemCodeForm canRedeem workspaceUuid="workspace" />)
  assert.match(html, /套餐将在已有付费时长结束后生效/)
  assert.doesNotMatch(html, /剩余时长不结转/)
})

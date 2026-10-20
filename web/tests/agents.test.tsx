import assert from "node:assert/strict"
import test from "node:test"
import { renderToStaticMarkup } from "react-dom/server"

import type { AgentWorkbench } from "../src/bindings/commands"
import { AgentCard, inviteLink, rebateLabel } from "../src/features/agents/agent-card"
import { inviteCodeFromSearch } from "../src/features/account/login-screen"
import { bpsFromPercent, centsFromYuan } from "../src/features/agents/agents-screen"

const workbench: AgentWorkbench = {
  invite_code: "AB23CD45",
  status: "active",
  rebate_bps: 1000,
  min_order_cents: 10_000,
  attribution_validity_days: 365,
  min_withdraw_cents: 10_000,
  wallet: { balance_cents: 500, held_cents: 0, available_cents: 500 },
  payout_account: null,
  wallet_transfer_available: true,
  invitee_count: 3,
  credited_count: 1,
  skipped_count: 1,
  credited_total_cents: 500,
  commissions: [
    {
      id: 1,
      invitee_email: "a***@example.com",
      workspace_name: "客户工作空间",
      product: "wallet_topup",
      order_amount_cents: 500,
      rebate_bps: 1000,
      amount_cents: 500,
      status: "credited",
      note: "代理佣金 · 订单 aw_1",
      created_at: "2026-09-04T00:00:00.000Z",
    },
    {
      id: 2,
      invitee_email: "b***@example.com",
      workspace_name: "另一工作空间",
      product: "member_seats",
      order_amount_cents: 4500,
      rebate_bps: 1000,
      amount_cents: 0,
      status: "skipped",
      note: "代理已停用",
      created_at: "2026-09-04T01:00:00.000Z",
    },
  ],
}

test("an invite link points at /login with the code, and ?invite= prefills it upper-cased", () => {
  assert.equal(
    inviteLink("https://richai.ozon-pod.com", "AB23CD45"),
    "https://richai.ozon-pod.com/login?invite=AB23CD45",
  )
  assert.equal(inviteCodeFromSearch("?invite=ab23cd45&screen=console"), "AB23CD45")
  assert.equal(inviteCodeFromSearch("?screen=console"), "")
})

test("rates are read as percent and written back as integer basis points", () => {
  assert.equal(rebateLabel(1000), "10%")
  assert.equal(rebateLabel(1250), "12.5%")
  assert.equal(bpsFromPercent("10"), 1000)
  assert.equal(bpsFromPercent("12.5"), 1250)
  assert.equal(bpsFromPercent(""), null, "empty means no rate typed")
  assert.equal(bpsFromPercent("101"), undefined)
  assert.equal(bpsFromPercent("-1"), undefined)
  assert.equal(bpsFromPercent("abc"), undefined)
})

test("the qualifying floor is read as yuan and written back as integer cents", () => {
  assert.equal(centsFromYuan("100"), 10_000)
  assert.equal(centsFromYuan("0.5"), 50)
  assert.equal(centsFromYuan(""), 0, "empty means no floor")
  assert.equal(centsFromYuan("-1"), undefined)
  assert.equal(centsFromYuan("abc"), undefined)
  assert.equal(centsFromYuan("1000001"), undefined)
})

test("the agent card shows the code, the link target, the rate and both commission outcomes", () => {
  const html = renderToStaticMarkup(
    <AgentCard workbench={workbench} origin="https://richai.ozon-pod.com" />,
  )
  assert.match(html, /AB23CD45/)
  assert.match(html, /10%/)
  assert.match(html, /佣金余额/)
  assert.match(html, /a\*\*\*@example\.com/)
  assert.match(html, /已入账/)
  assert.match(html, /未计佣 · 代理已停用/)
  assert.match(html, /¥5\.00/)
  assert.match(html, /复制邀请链接/)
  assert.doesNotMatch(html, /alice@/)
})

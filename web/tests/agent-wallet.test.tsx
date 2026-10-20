import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"
import { fileURLToPath } from "node:url"
import { renderToStaticMarkup } from "react-dom/server"

import type { AgentWorkbench } from "../src/bindings/commands"
import { AgentWalletCard } from "../src/features/agents/agent-wallet-card"
import { PayoutAccountForm } from "../src/features/agents/payout-account-form"

const workbench: AgentWorkbench = {
  invite_code: "AB23CD45",
  status: "active",
  rebate_bps: 1000,
  min_order_cents: 10_000,
  attribution_validity_days: 365,
  min_withdraw_cents: 10_000,
  wallet: { balance_cents: 30_000, held_cents: 20_000, available_cents: 10_000 },
  payout_account: {
    channel: "alipay",
    account: "agent@x.invalid",
    real_name: "代理人",
  },
  wallet_transfer_available: true,
  invitee_count: 3,
  credited_count: 2,
  skipped_count: 0,
  credited_total_cents: 30_000,
  commissions: [],
}

const pendingWithdrawal = {
  public_id: "wd_abc123def456",
  amount_cents: 20_000,
  channel: "alipay",
  account: "agent@x.invalid",
  real_name: "代理人",
  status: "pending",
  reference: null,
  reject_reason: null,
  requested_at: "2026-09-18T00:00:00.000Z",
  decided_at: null,
}

test("the wallet card reads available / held / lifetime and blocks withdraw while one is pending", () => {
  const html = renderToStaticMarkup(
    <AgentWalletCard
      workbench={workbench}
      withdrawals={[pendingWithdrawal]}
      ledger={[]}
      onChanged={() => {}}
    />,
  )
  assert.match(html, /佣金余额/)
  assert.match(html, /可用余额/)
  assert.match(html, /在途提现/)
  assert.match(html, /累计佣金/)
  assert.match(html, /wd_abc123def456/)
  assert.match(html, /处理中/)
  // A pending row exists → the 申请提现 button carries `disabled`.
  const withdrawButton = html.match(/<button[^>]*>(?:[^<]|<svg[\s\S]*?<\/svg>)*[^<]*申请提现/)?.[0] ?? ""
  assert.match(withdrawButton, /\sdisabled[\s=]/)
})

test("a disabled agent keeps the wallet card and reads the settled copy", () => {
  const disabled = { ...workbench, status: "disabled" }
  const html = renderToStaticMarkup(
    <AgentWalletCard
      workbench={disabled}
      withdrawals={[]}
      ledger={[]}
      onChanged={() => {}}
    />,
  )
  assert.match(html, /代理已停用，不再产生新佣金；余额仍可提现或转入钱包。/)
  const withdrawButton = html.match(/<button[^>]*>(?:[^<]|<svg[\s\S]*?<\/svg>)*[^<]*申请提现/)?.[0] ?? ""
  assert.doesNotMatch(withdrawButton, /\sdisabled[\s=]/)
})

test("转入钱包 is disabled without a transfer target", () => {
  const stranded = { ...workbench, wallet_transfer_available: false }
  const html = renderToStaticMarkup(
    <AgentWalletCard
      workbench={stranded}
      withdrawals={[]}
      ledger={[]}
      onChanged={() => {}}
    />,
  )
  const transferButton = html.match(/<button[^>]*>(?:[^<]|<svg[\s\S]*?<\/svg>)*[^<]*转入钱包/)?.[0] ?? ""
  assert.match(transferButton, /\sdisabled[\s=]/)
})

test("the payout form refuses a blank submit and reads the saved account back", () => {
  const blank = renderToStaticMarkup(
    <PayoutAccountForm account={null} onSaved={() => {}} />,
  )
  assert.match(blank, /支付宝/)
  const submit = blank.match(/<button[^>]*type="submit"[^>]*>/)?.[0] ?? ""
  assert.match(submit, /\sdisabled[\s=]/)

  const saved = renderToStaticMarkup(
    <PayoutAccountForm
      account={{ channel: "wechat", account: "wx-1", real_name: "代理人" }}
      onSaved={() => {}}
    />,
  )
  assert.match(saved, /微信/)
  assert.match(saved, /wx-1/)
  assert.match(saved, /代理人/)
})

test("the withdrawal dialogs enforce their contracts in source", () => {
  const panel = readFileSync(
    fileURLToPath(
      new URL("../src/features/agents/agent-withdrawals-panel.tsx", import.meta.url),
    ),
    "utf8",
  )
  // Reject is required: the submit stays disabled until `reason` is non-blank,
  // and the reason goes to the API verbatim.
  assert.match(panel, /const canSubmit = reason\.trim\(\) !== ""/)
  assert.match(panel, /adminHttp\.adminRejectAgentWithdrawal\(row\.public_id, reason\.trim\(\)\)/)
  // Pay passes the optional reference through, blank → undefined.
  assert.match(panel, /adminHttp\.adminPayAgentWithdrawal\(\s*row\.public_id,/)
  assert.match(panel, /reference\.trim\(\) === "" \? undefined : reference\.trim\(\)/)
  // The queue only writes through the two dialogs — no other mutation call.
  assert.doesNotMatch(panel, /api\.(post|put|delete|patch)/)
})

test("the wallet card submits integer cents and never floats", () => {
  const source = readFileSync(
    fileURLToPath(
      new URL("../src/features/agents/agent-wallet-card.tsx", import.meta.url),
    ),
    "utf8",
  )
  // 元 typed by the Agent → 分 the API moves; the conversion is the shared
  // integer helper, no floats reach the request body.
  assert.match(source, /topupCentsFromYuan/)
  assert.match(source, /accountHttp\.agentRequestWithdrawal\(cents\)/)
  assert.match(source, /accountHttp\.agentTransferToWallet\(operationId, cents\)/)
  assert.match(source, /crypto\.randomUUID\(\)/)
})

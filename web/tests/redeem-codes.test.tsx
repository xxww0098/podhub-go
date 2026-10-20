import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"
import { renderToStaticMarkup } from "react-dom/server"

import { RedeemCodeForm } from "../src/features/plans/redeem-code-dialog"
import { RedeemCodesScreen } from "../src/features/redeem-codes/redeem-codes-screen"
import { toneFor } from "../src/lib/receipt-state"

test("the Workspace menu carries the 兑换码 entry and the dialog form redeems", () => {
  // The redeem card left the plans page: the menu item opens RedeemCodeDialog,
  // whose form body renders statically.
  const menuSource = readFileSync(
    new URL("../src/components/workspace-switcher.tsx", import.meta.url),
    "utf8",
  )
  assert.match(menuSource, /兑换码/)
  assert.match(menuSource, /<RedeemCodeDialog/)
  const html = renderToStaticMarkup(<RedeemCodeForm canRedeem />)
  assert.match(html, />兑换</)
})

test("redeem-code management has a loading state before the ledger arrives", () => {
  const html = renderToStaticMarkup(<RedeemCodesScreen />)
  assert.match(html, /创建兑换码/)
  assert.match(html, /正在读取兑换码/)
  assert.match(html, /搜索尾号、内容、批次或备注/)
  assert.match(html, /按状态筛选/)
  assert.match(html, /未使用/)
  assert.match(html, /已作废/)
  assert.doesNotMatch(html, /兑换码统计/)
})

test("redeem-code row actions expose copy, delete and search clear", () => {
  const source = readFileSync(
    new URL("../src/features/redeem-codes/redeem-codes-screen.tsx", import.meta.url),
    "utf8",
  )
  assert.match(source, /label="复制尾号"/)
  assert.match(source, /label="删除"/)
  assert.doesNotMatch(source, /label="作废"/)
  assert.doesNotMatch(source, /adminRevokeRedeemCode/)
  assert.match(source, /<PlatformAdminSearch/)
  assert.match(source, /adminDeleteRedeemCode/)
  assert.match(source, /status === "unused" \|\| status === "expired" \|\| status === "revoked"/)
})

test("兑换码列表用勾选列驱动批量删除，逐条删除并把失败交给通知", () => {
  const source = readFileSync(
    new URL("../src/features/redeem-codes/redeem-codes-screen.tsx", import.meta.url),
    "utf8",
  )
  // 表头全选（含半选）与行勾选，选中态落在行上。
  assert.match(source, /aria-label="选择当前筛选的全部兑换码"/)
  assert.match(source, /indeterminate=\{!allVisibleSelected && someVisibleSelected\}/)
  assert.ok(source.includes("toggleSelectRow(code.id, checked === true)"))
  assert.ok(source.includes('data-state={selectedIds.has(code.id) ? "selected" : undefined}'))
  // 批量条只在有勾选时出现；删除只作用于仍可删除的码，已兑换的码留在台账里。
  assert.ok(source.includes("已选 {liveSelected.length} 个"))
  assert.ok(source.includes("其中 {deletableSelected.length} 个可删除"))
  assert.ok(
    source.includes(
      "const deletableSelected = liveSelected.filter((code) => canDelete(code.status))",
    ),
  )
  // 后端没有批量端点：确认一次后逐条删除；失败走 notifyCommandError，不写进页面。
  assert.ok(source.includes("await adminHttp.adminDeleteRedeemCode(code.id)"))
  assert.ok(source.includes("个兑换码删除失败，请刷新后重试"))
  assert.ok(source.includes('notifySuccess(`已删除 ${removed} 个兑换码`)'))
  assert.ok(source.includes("删除后无法恢复。"))
})

test("兑换内容是 tab，第二项是钱包额度而不是识别次数", () => {
  const source = readFileSync(
    new URL("../src/features/redeem-codes/redeem-codes-screen.tsx", import.meta.url),
    "utf8",
  )
  assert.match(source, /<TabsTrigger value="member_seats"/)
  assert.match(source, /<TabsTrigger value="wallet_credits"/)
  // The dropdown and the OCR-count creation path are both gone from the form.
  assert.doesNotMatch(source, /<option value="ocr_credits">/)
  assert.doesNotMatch(source, /识别次数/)
  // 元 typed by the operator reaches the wire as 分.
  assert.match(source, /wallet_cents: isWallet \? \(walletCents \?\? 0\) : 0/)
})

test("保存兑换码 只有一层弹窗，未保存时由页脚按钮收口", () => {
  const source = readFileSync(
    new URL("../src/features/redeem-codes/redeem-codes-screen.tsx", import.meta.url),
    "utf8",
  )
  // 完整码只显示一次，但提示留在弹窗内：不再叠一层「尚未保存完整兑换码」。
  assert.doesNotMatch(source, /尚未保存完整兑换码/)
  assert.match(source, /复制全部并关闭/)
  assert.match(source, /不保存，直接关闭/)
  // 隐式关闭（Esc、遮罩、右上角）在未保存时被吞掉，只有用户点过的按钮能强制关闭。
  assert.match(source, /if \(!force && created && !saved\) return/)
  assert.match(source, /showCloseButton=\{!created \|\| saved\}/)
  // 一键保存并退出：复制成功才算保存，保存之后才关闭。
  assert.match(source, /async function copyAllAndClose\(\)/)
})

test("redeem-code statuses resolve through the shared tone table", () => {
  assert.equal(toneFor("unused"), "idle")
  assert.equal(toneFor("redeemed"), "good")
  assert.equal(toneFor("expired"), "unknown")
  assert.equal(toneFor("revoked"), "bad")
})

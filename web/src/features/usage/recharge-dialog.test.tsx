import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"
import { fileURLToPath } from "node:url"
import { renderToStaticMarkup } from "react-dom/server"

import { UsageStatsPanel } from "./usage-stats-panel"

function readNearby(relative: string): string {
  return readFileSync(fileURLToPath(new URL(relative, import.meta.url)), "utf8")
}

test("去充值 stays owner-gated and opens the recharge dialog in place", () => {
  const screen = readNearby("./usage-screen.tsx")
  const catalog = readNearby("../../app/screen-catalog.tsx")

  assert.match(screen, /<RechargeDialog/)
  assert.match(screen, /role === "owner"/)
  assert.doesNotMatch(screen, /onOpenPlans/)
  assert.doesNotMatch(catalog, /UsageScreen[\s\S]*onOpenPlans/)
})

test("the wallet card renders 去充值 only with a target", () => {
  const withTarget = renderToStaticMarkup(
    <UsageStatsPanel workspaceId={1} workspaceName="演示 Workspace" onTopUp={() => {}} />,
  )
  assert.match(withTarget, /去充值/)

  const without = renderToStaticMarkup(
    <UsageStatsPanel workspaceId={1} workspaceName="演示 Workspace" />,
  )
  assert.doesNotMatch(without, /去充值/)
})

test("the recharge dialog talks to the top-up wire, never the member-seats order endpoints", () => {
  const dialog = readNearby("./recharge-dialog.tsx")

  assert.match(dialog, /accountCreateRechargeOrder\(/)
  assert.match(dialog, /accountGetWalletDetail\(\)/)
  assert.match(dialog, /accountGetPaymentMethods\(\)/)
  // Top-up orders are `wallet_topup` product rows: /api/orders/* is
  // member-seats only, so status rides the wallet detail's `recharges` page.
  assert.doesNotMatch(dialog, /accountGetPaymentOrder|accountOpenPaymentOrder|accountCancelPaymentOrder|paymentIntent/)
  // Failures ride toasts; the dialog body keeps status chips and retry buttons.
  assert.doesNotMatch(dialog, /role="alert"|FieldError|errorMessage\(reason\)\s*<|>\s*\{error/)
})

test("quick amounts stay inside the server's ¥1 – ¥10,000 envelope", () => {
  const dialog = readNearby("./recharge-dialog.tsx")
  const match = dialog.match(/QUICK_YUAN = \[([^\]]+)\]/)
  assert.ok(match)
  const amounts = match[1].split(",").map((part) => Number(part.trim()))
  for (const yuan of amounts) {
    assert.ok(yuan * 100 >= 100 && yuan * 100 <= 1_000_000)
  }
})

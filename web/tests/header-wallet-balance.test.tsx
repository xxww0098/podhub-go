import assert from "node:assert/strict"
import test from "node:test"
import { renderToStaticMarkup } from "react-dom/server"

import type { WalletView } from "../src/bindings/commands"
import {
  WalletBalanceBadge,
  computeWalletBalance,
  formatCompactQuota,
} from "../src/components/workspace-quota-facts"

/** Cases are written in 元; the wallet only ever speaks microfen (10^8 per 元). */
function wallet(yuan: { available: number; held?: number; spent: number }): WalletView {
  const held = yuan.held ?? 0
  return {
    available_microfen: yuan.available * 100_000_000,
    held_microfen: held * 100_000_000,
    balance_microfen: (yuan.available + held) * 100_000_000,
    spent_microfen: yuan.spent * 100_000_000,
    updated_at: "2026-08-22T00:00:00Z",
  }
}

test("formatCompactQuota formats values in K and M thresholds cleanly", () => {
  assert.equal(formatCompactQuota(0), "0")
  assert.equal(formatCompactQuota(500), "500")
  assert.equal(formatCompactQuota(50_000), "50K")
  assert.equal(formatCompactQuota(300_100), "300.1K")
  assert.equal(formatCompactQuota(1_000_000), "1M")
  assert.equal(formatCompactQuota(1_500_000), "1.5M")
  assert.equal(formatCompactQuota(143_000_000), "143M")
})

test("computeWalletBalance measures spend against everything ever topped up", () => {
  // Nothing spent yet: ¥0 of ¥1,000.00 granted. The header readout uses the
  // shared formatYuan default (2 decimals ≥¥1), the same figure the usage
  // screen prints for this wallet.
  const fresh = computeWalletBalance(wallet({ available: 1_000, spent: 0 }))
  assert.equal(fresh.granted, "¥1,000.00")
  assert.equal(fresh.available, "¥1,000.00")
  assert.equal(fresh.formattedPercent, "0%")
  assert.equal(fresh.clampedPercent, 0)
  assert.equal(fresh.tone, "normal")

  // A held reservation still counts as granted, not as spent.
  const held = computeWalletBalance(wallet({ available: 700, held: 100, spent: 200 }))
  assert.equal(held.granted, "¥1,000.00")
  assert.equal(held.held, "¥100.00")
  assert.equal(held.formattedPercent, "20%")
  assert.equal(held.tone, "normal")

  const warning = computeWalletBalance(wallet({ available: 150, spent: 850 }))
  assert.equal(warning.formattedPercent, "85%")
  assert.equal(warning.tone, "warning")

  const danger = computeWalletBalance(wallet({ available: 15, spent: 985 }))
  assert.equal(danger.formattedPercent, "98.5%")
  assert.equal(danger.tone, "danger")

  // An empty balance is danger even when little was ever topped up.
  const empty = computeWalletBalance(wallet({ available: 0, spent: 10 }))
  assert.equal(empty.formattedPercent, "100%")
  assert.equal(empty.tone, "danger")

  // A wallet that was never topped up has nothing to be a percentage of.
  const ungranted = computeWalletBalance(wallet({ available: 0, spent: 0 }))
  assert.equal(ungranted.formattedPercent, "0%")
  assert.equal(ungranted.tone, "danger")

  // A sub-0.1% burn reads as a floor rather than rounding to nothing.
  const trace = computeWalletBalance(wallet({ available: 999.99, spent: 0.01 }))
  assert.equal(trace.formattedPercent, "<0.1%")
})

test("WalletBalanceBadge renders remaining ¥ and an aria-label without progress bar", () => {
  const html = renderToStaticMarkup(
    <WalletBalanceBadge
      wallet={wallet({ available: 24.46, spent: 236.78 })}
      onOpenUsage={() => {}}
    />,
  )

  assert.match(html, /¥24\.46\b/)
  assert.match(html, /lucide-wallet/)
  assert.doesNotMatch(html, /lucide-sparkles/)
  assert.doesNotMatch(html, /role="progressbar"/)
  assert.match(html, /aria-label="钱包余额 ¥24\.46 CNY"/)
})

test("the header balance reads two decimals, matching the usage screen", () => {
  // Regression: the badge used to pin 3 decimals (¥99.807) while the usage screen
  // printed the same wallet as ¥99.81 — one number, two readings. The badge
  // now uses the shared formatYuan default so both surfaces agree, and a
  // sub-¥1 balance still exposes the ¥0.003 minimum billing step.
  const gate = computeWalletBalance(wallet({ available: 99.807, spent: 0.193 }))
  assert.equal(gate.available, "¥99.81")
  const html = renderToStaticMarkup(
    <WalletBalanceBadge
      wallet={wallet({ available: 99.807, spent: 0.193 })}
    />,
  )
  assert.match(html, /¥99\.81\b/)
  assert.doesNotMatch(html, /¥99\.807/)

  const trace = computeWalletBalance(wallet({ available: 0.003, spent: 0 }))
  assert.equal(trace.available, "¥0.003")
})

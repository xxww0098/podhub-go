import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"

const source = readFileSync(
  new URL("../src/features/console/console-screen.tsx", import.meta.url),
  "utf8",
)
const metrics = readFileSync(
  new URL("../src/features/console/console-metrics.ts", import.meta.url),
  "utf8",
)

test("ConsoleScreen keeps read failures in the toast host", () => {
  assert.doesNotMatch(source, /role="alert"/)
  assert.doesNotMatch(source, /setReadError|setRefreshError|setLedgerError/)
  assert.match(source, /CONSOLE_READ_LIVE = "console-read"/)
  assert.match(source, /notifyLive\(\{/)
  assert.match(source, /clearLive\(CONSOLE_READ_LIVE\)/)
})

test("ConsoleScreen keeps per-row failure badges on the page", () => {
  // The attention bar carries the store-read failure count…
  assert.match(source, /家店铺读取异常/)
  // …and the roster chip label for a failed read lives in the status spec.
  assert.match(metrics, /读取失败/)
})

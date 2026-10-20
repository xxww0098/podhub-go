import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"
import { renderToStaticMarkup } from "react-dom/server"

import { OrdersScreen } from "../src/features/orders/orders-screen"

test("confirming a remittance refreshes the shell overview", () => {
  const source = readFileSync(
    new URL("../src/features/orders/orders-screen.tsx", import.meta.url),
    "utf8",
  )
  const confirm = source.slice(source.indexOf("async function confirm("))
  assert.match(confirm, /adminConfirmOrder/)
  assert.match(confirm, /await reload\(\)/)
  assert.match(confirm, /await onSessionMayChange\?\.\(\)/)
  const shell = readFileSync(
    new URL("../src/app/settings-dialog.tsx", import.meta.url),
    "utf8",
  )
  assert.match(shell, /<OrdersScreen\s+onSessionMayChange=\{refreshOverview\}\s*\/>/)
})

test("admin orders screen lists confirm and cancel actions after load", () => {
  const html = renderToStaticMarkup(<OrdersScreen />)
  assert.match(html, /刷新/)
  assert.match(html, /暂无订单/)

  const source = readFileSync(
    new URL("../src/features/orders/orders-screen.tsx", import.meta.url),
    "utf8",
  )
  assert.match(source, /<TableHead>单号</)
  assert.match(source, /<TableHead>金额</)
  assert.match(source, /确认收款/)
  assert.match(source, /取消/)
})

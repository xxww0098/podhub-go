import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"
import { renderToStaticMarkup } from "react-dom/server"

import { UsersScreen } from "../src/features/users/users-screen"
import { PlatformAiAccountsScreen } from "../src/features/platform/ai-accounts-screen"
import { RedeemCodesScreen } from "../src/features/redeem-codes/redeem-codes-screen"
import { AgentsScreen } from "../src/features/agents/agents-screen"
import { AdminLogsScreen, AdminUsageScreen, AdminErrorsScreen } from "../src/features/platform/logs"
import { OrdersScreen } from "../src/features/orders/orders-screen"

test("each platform admin pane still mounts", () => {
  assert.match(renderToStaticMarkup(<UsersScreen />), /用户/)
  const pool = renderToStaticMarkup(<PlatformAiAccountsScreen />)
  assert.match(pool, /role="tab"[^>]*>AI识图</)
  assert.match(pool, /role="tab"[^>]*>生图</)
  assert.match(pool, /role="tab"[^>]*>运行限制</)
  assert.doesNotMatch(pool, /CLIProxy|cpa-hop-key|href="\/cpa\/"/)
  assert.match(renderToStaticMarkup(<RedeemCodesScreen />), /兑换/)
  assert.match(renderToStaticMarkup(<AgentsScreen />), /代理/)
  // Retention lives in the pane description (settings-sections), not the body.
  assert.match(renderToStaticMarkup(<AdminLogsScreen />), /API 请求/)
  assert.match(renderToStaticMarkup(<AdminUsageScreen />), /API 请求日志/)
  assert.match(renderToStaticMarkup(<AdminErrorsScreen />), /错误日志/)
  assert.match(renderToStaticMarkup(<OrdersScreen />), /订单/)
})

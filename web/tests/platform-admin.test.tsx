import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"
import { renderToStaticMarkup } from "react-dom/server"

import { UsersScreen } from "../src/features/users/users-screen"
import { PlatformOcrScreen } from "../src/features/platform/ocr-screen"
import { PlatformAiAccountsScreen } from "../src/features/platform/ai-accounts-screen"
import { PlatformMediaScreen } from "../src/features/platform/media-screen"
import { PlatformPromptsScreen } from "../src/features/platform/prompts"
import { RedeemCodesScreen } from "../src/features/redeem-codes/redeem-codes-screen"
import { AgentsScreen } from "../src/features/agents/agents-screen"
import { AdminLogsScreen, AdminUsageScreen, AdminErrorsScreen } from "../src/features/platform/logs"
import { OrdersScreen } from "../src/features/orders/orders-screen"
import type { IntegrationCredentialsOverview } from "../src/bindings/commands"

test("each platform admin pane still mounts", () => {
  assert.match(renderToStaticMarkup(<UsersScreen />), /用户/)
  assert.match(renderToStaticMarkup(<PlatformOcrScreen />), /OCR/)
  const pool = renderToStaticMarkup(<PlatformAiAccountsScreen />)
  assert.match(pool, /AI 账号池/)
  assert.match(pool, /新增账号/)
  assert.doesNotMatch(pool, /CLIProxy|cpa-hop-key|href="\/cpa\/"/)
  assert.match(renderToStaticMarkup(<PlatformMediaScreen />), /对象存储/)
  assert.match(renderToStaticMarkup(<PlatformPromptsScreen />), /提示词/)
  assert.match(renderToStaticMarkup(<RedeemCodesScreen />), /兑换/)
  assert.match(renderToStaticMarkup(<AgentsScreen />), /代理/)
  // Retention lives in the pane description (settings-sections), not the body.
  assert.match(renderToStaticMarkup(<AdminLogsScreen />), /API 请求/)
  assert.match(renderToStaticMarkup(<AdminUsageScreen />), /API 请求日志/)
  assert.match(renderToStaticMarkup(<AdminErrorsScreen />), /错误日志/)
  assert.match(renderToStaticMarkup(<OrdersScreen />), /订单/)
})

test("平台 · 提示词 only manages submitted supplier prompts", () => {
  const prompts = readFileSync(
    new URL("../src/features/platform/prompts.tsx", import.meta.url),
    "utf8",
  )
  assert.match(prompts, /supplierPromptsList/)
  assert.match(prompts, /supplierPromptPatch/)
  assert.match(prompts, /每个类目至少保留一条/)
  assert.doesNotMatch(prompts, /listingCardSaveCategoryPrompt/)
  assert.match(prompts, /PlatformPromptsScreen/)
})

test("PlatformOcrScreen does not repeat 当前识图 summary in toolbar", () => {
  const html = renderToStaticMarkup(
    <PlatformOcrScreen
      initialOverview={{
        ai_default_model: "qwen3.7-flash",
        ai_accounts: [
          {
            id: "env-ai",
            label: "Qwen",
            ref_id: "env-ai",
            configured: true,
            active: true,
            base_url: "https://dashscope.aliyuncs.com/compatible-mode/v1",
            api_format: "chat_completions",
            model: "qwen3.7-flash",
            thinking: false,
            thinking_format: "enable_thinking",
            priority: 0,
          },
        ],
        media_accounts: [],
      } as unknown as IntegrationCredentialsOverview}
    />,
  )
  const matches = html.match(/当前识图/g) ?? []
  // Appears once in the summary strip, not duplicated in the toolbar
  assert.equal(matches.length, 1)
})

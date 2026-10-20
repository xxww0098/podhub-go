import { AI_MODEL_CHOICES, DEFAULT_AI_MODEL_CHOICE } from "@/lib/ai-model-presets"
import assert from "node:assert/strict"
import test from "node:test"
import { renderToStaticMarkup } from "react-dom/server"
import type { AiAccountView, AiPriceView, IntegrationCredentialsOverview } from "@/bindings/commands"
import { accountForModel, connectionProbe, modelCatalogueProbe } from "./ai-account-model"
import { AiAccountEditor } from "./ai-account-editor"
import { PlatformAiAccountsScreen } from "./ai-accounts-screen"
import { AiAllowlist } from "./ai-prices"

const account: AiAccountView = {
  id: "a", ref_id: "a", configured: true, label: "主账号", base_url: "https://example.test/v1",
  api_format: "chat_completions", model: "model-a", active: true, thinking: false, thinking_format: "none", priority: 10,
}
const overview: IntegrationCredentialsOverview = {
  ai_default_model: "model-a", ai_accounts: [account, { ...account, id: "b", label: "备用账号", active: false }],
  media_accounts: [],
}
const price: AiPriceView = {
  model: "model-a", billing_mode: "per_request", per_request_microfen: 100, input_microfen_per_million: 0,
  output_microfen_per_million: 0, reasoning_microfen_per_million: 0, cached_input_microfen_per_million: 0,
  max_request_microfen: 100, effective_from: "2026-10-07",
}

test("model readiness never borrows an account from a different model", () => {
  const other = { ...account, id: "other", model: "model-b", priority: 100 }
  assert.equal(accountForModel([account, other], "model-a")?.id, "a")
  assert.equal(accountForModel([other], "model-a"), undefined)
  assert.equal(accountForModel([{ ...account, active: false }], "model-a"), undefined)
  assert.equal(accountForModel([{ ...account, api_format: "responses" }], "model-a"), undefined)
  assert.equal(accountForModel([account, { ...account, id: "higher", priority: 20 }], "model-a")?.id, "higher")
})

test("account pool shows status, connection test and edit controls", () => {
  const html = renderToStaticMarkup(<PlatformAiAccountsScreen initialOverview={overview} />)
  assert.match(html, /2 \/ 64 个账号 · 1 个已启用/)
  for (const label of ["测试连接 主账号", "停用 主账号", "启用 备用账号", "编辑 主账号", "删除 备用账号"]) assert.ok(html.includes(label))
  assert.match(html, /尚未测试/)
  assert.match(html, /已启用/)
  assert.match(html, /已停用/)
  assert.match(html, /全部账号/)
  assert.match(html, /搜索账号/)
  assert.match(html, /默认识图/)
  assert.doesNotMatch(html, /优先级 <span|支持识图|\/cpa\/|CLIProxy|role="alert"/)
})

test("new account form defaults to DeepSeek 4.1 Flash with thinking off and hides advanced fields", () => {
  const html = renderToStaticMarkup(<AiAccountEditor busy={false} onSave={() => {}} />)
  assert.match(html, /DeepSeek 4.1 Flash · 关闭思考/)
  assert.match(html, /经 Cline 调用 DeepSeek/)
  assert.match(html, /密钥（必填）/)
  assert.match(html, /type="password"/)
  assert.match(html, /启用/)
  assert.match(html, /测试连接/)
  assert.match(html, /尚未测试/)
  assert.match(html, /高级设置/)
  assert.doesNotMatch(html, /<details[^>]*\bopen=/)
  assert.match(html, /value="https:\/\/api\.cline\.bot\/api\/v1"/)
  assert.match(html, /value="deepseek\/deepseek-v4\.1-flash"/)
  assert.match(html, /思考类型/)
  assert.doesNotMatch(html, />reasoning_effort<|>thinking_type<|>enable_thinking</)
  assert.equal(DEFAULT_AI_MODEL_CHOICE.model, "deepseek/deepseek-v4.1-flash")
  assert.equal(DEFAULT_AI_MODEL_CHOICE.thinking, false)
  assert.equal(DEFAULT_AI_MODEL_CHOICE.thinkingFormat, "thinking_type")
})

test("saved account keeps a blank key and a custom endpoint behind advanced settings", () => {
  const html = renderToStaticMarkup(<AiAccountEditor account={account} busy={false} onSave={() => {}} />)
  assert.match(html, /留空则保留已保存的密钥/)
  assert.match(html, /自定义/)
  assert.match(html, /高级设置/)
  assert.doesNotMatch(html, /<details[^>]*\bopen=/)
  assert.match(html, /id="ai-model"/)
  assert.match(html, /pattern="\\S\+"/)
  assert.match(html, /从服务目录拉取并选择模型/)
  assert.match(html, /value="https:\/\/example.test\/v1"/)
  assert.match(html, /同一模型按数字从高到低使用/)
})

test("catalogue probe mirrors the Cloud contract for keys and endpoints", () => {
  const base = { baseUrl: "https://example.test/v1", apiKey: "", apiFormat: "chat_completions" as const }
  assert.deepEqual(modelCatalogueProbe({ ...base, baseUrl: "  " }), { status: "blocked", reason: "请先在高级设置中填写有效的服务地址。" })
  assert.deepEqual(modelCatalogueProbe({ ...base, baseUrl: "example.test" }), { status: "blocked", reason: "请先在高级设置中填写有效的服务地址。" })
  assert.deepEqual(modelCatalogueProbe(base), { status: "blocked", reason: "请先填写密钥，再拉取模型列表。" })
  assert.deepEqual(modelCatalogueProbe({ ...base, apiKey: " sk-1 " }), {
    status: "ready",
    request: { id: null, base_url: "https://example.test/v1", api_format: "chat_completions", api_key: "sk-1" },
  })
  // Unchanged endpoint (trailing slashes are cosmetic) may reuse the stored key.
  assert.deepEqual(modelCatalogueProbe({ ...base, account, baseUrl: "https://example.test/v1/" }), {
    status: "ready",
    request: { id: "a", base_url: "https://example.test/v1/", api_format: "chat_completions", api_key: "" },
  })
  assert.deepEqual(modelCatalogueProbe({ ...base, account, baseUrl: "https://other.test/v1" }), {
    status: "blocked",
    reason: "更换服务地址或接口格式后，需要重新填写密钥。",
  })
  // A draft key rides along with the account id so Cloud can test the replacement.
  assert.deepEqual(modelCatalogueProbe({ ...base, account, baseUrl: "https://other.test/v1", apiKey: "sk-2" }), {
    status: "ready",
    request: { id: "a", base_url: "https://other.test/v1", api_format: "chat_completions", api_key: "sk-2" },
  })
  assert.deepEqual(modelCatalogueProbe({ ...base, account, apiFormat: "responses" }), {
    status: "blocked",
    reason: "更换服务地址或接口格式后，需要重新填写密钥。",
  })
})

test("priced unsupported models cannot be selected or probed; selected price cannot be deleted", () => {
  const html = renderToStaticMarkup(<AiAllowlist accounts={[account]} defaultModel="model-a" prices={[price, { ...price, model: "model-b" }]} busy={false} onPrices={() => {}} onDefaultModel={() => {}} onDeletePrice={async () => true} />)
  const buttons = [...html.matchAll(/<button\b[^>]*>[\s\S]*?<\/button>/g)].map((match) => match[0])
  assert.ok(buttons.find((button) => button.includes("设为识图"))?.match(/ disabled(?:=""|[ >])/g))
  assert.ok(buttons.find((button) => button.includes('aria-label="测试 model-b"'))?.match(/ disabled(?:=""|[ >])/g))
  assert.ok(buttons.find((button) => button.includes('aria-label="下架 model-a"'))?.match(/ disabled(?:=""|[ >])/g))
  assert.ok(!buttons.find((button) => button.includes('aria-label="测试 model-a"'))?.match(/ disabled(?:=""|[ >])/g))
})


test("named models keep endpoint-specific thinking, and the connection test refuses a missing key", () => {
  assert.deepEqual(AI_MODEL_CHOICES.map(({ id, thinking, thinkingFormat }) => [id, thinking, thinkingFormat]), [
    ["deepseek-4-1-flash-off", false, "thinking_type"],
    ["qwen-3-7-flash-off", false, "enable_thinking"],
    ["glm-5-3-flash-low", "low", "reasoning_effort"],
  ])
  const deepseek = AI_MODEL_CHOICES.find((row) => row.id === "deepseek-4-1-flash-off")
  const qwen = AI_MODEL_CHOICES.find((row) => row.id === "qwen-3-7-flash-off")
  const glm = AI_MODEL_CHOICES.find((row) => row.id === "glm-5-3-flash-low")
  assert.equal(deepseek?.baseUrl, "https://api.cline.bot/api/v1")
  assert.equal(qwen?.baseUrl, "https://dashscope.aliyuncs.com/compatible-mode/v1")
  assert.equal(glm?.baseUrl, "https://opencode.ai/zen/go/v1")
  assert.notEqual(deepseek?.thinkingFormat, glm?.thinkingFormat)
  assert.equal(connectionProbe({
    baseUrl: deepseek!.baseUrl, apiKey: "", apiFormat: "chat_completions", model: deepseek!.model,
  }).status, "blocked")
  assert.deepEqual(connectionProbe({
    baseUrl: deepseek!.baseUrl, apiKey: " sk-1 ", apiFormat: "chat_completions", model: deepseek!.model,
  }), {
    status: "ready",
    request: { id: null, model: "deepseek/deepseek-v4.1-flash", baseUrl: "https://api.cline.bot/api/v1", apiFormat: "chat_completions", apiKey: "sk-1" },
  })
  assert.deepEqual(connectionProbe({
    accountId: "a",
    stored: { base_url: account.base_url, api_format: account.api_format, configured: true },
    baseUrl: account.base_url, apiKey: "", apiFormat: account.api_format, model: account.model,
  }), {
    status: "ready",
    request: { id: "a", model: "model-a", baseUrl: "https://example.test/v1", apiFormat: "chat_completions" },
  })
})

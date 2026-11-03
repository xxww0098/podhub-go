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
  api_format: "chat_completions", model: "model-a", active: true, thinking: false, thinking_format: "none", priority: 10, purpose: "ocr",
}
const runtime = { max_concurrency_global: 20, max_concurrency_user: 3, max_concurrency_account: 4, user_rate_per_minute: 15, lease_ttl_seconds: 120, allow_public_egress: true }
const imageAccount: AiAccountView = { ...account, id: "img", ref_id: "img", label: "生图账号", model: "qwen-image-2.1-pro", purpose: "image", thinking: "provider_default" }
const chatAccount: AiAccountView = { ...account, id: "chat", ref_id: "chat", label: "对话账号", model: "claude-sonnet-5-5", purpose: "chat", api_format: "anthropic_messages", thinking: "medium", thinking_format: "anthropic_budget" }
const overview: IntegrationCredentialsOverview = {
  ai_default_model: "model-a", ai_accounts: [account, { ...account, id: "b", label: "备用账号", active: false }, chatAccount, imageAccount], ai_runtime: runtime,
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
  assert.equal(accountForModel([{ ...account, purpose: "image" }], "model-a"), undefined)
  assert.equal(accountForModel([{ ...account, purpose: "chat" }], "model-a"), undefined)
  assert.equal(accountForModel([account, { ...account, id: "higher", priority: 20 }], "model-a")?.id, "higher")
})

test("the screen mounts AI识图, 对话, 生图 and 运行限制 tabs, each holding only its own accounts", () => {
  const html = renderToStaticMarkup(<PlatformAiAccountsScreen initialOverview={overview} />)
  for (const tab of ["AI识图", "对话", "生图", "运行限制"]) assert.match(html, new RegExp(`role="tab"[^>]*>${tab}<`))
  const panels = [...html.matchAll(/<div[^>]*role="tabpanel"[^>]*>([\s\S]*?)(?=<div[^>]*role="tabpanel"|$)/g)].map((match) => match[1])
  assert.equal(panels.length, 4)
  const [ocr, chat, image, limits] = panels
  for (const label of ["测试连接 主账号", "停用 主账号", "启用 备用账号", "编辑 主账号", "删除 备用账号"]) assert.ok(ocr.includes(label), label)
  assert.ok(!ocr.includes("生图账号") && !ocr.includes("qwen-image-2.1-pro"))
  assert.match(ocr, /AI识图默认模型/)
  assert.match(ocr, /默认识图/)
  assert.match(ocr, /<table[^>]*aria-label="AI识图服务账号"/)
  assert.match(ocr, /搜索账号/)
  assert.match(ocr, /全部账号/)
  assert.match(ocr, /尚未测试/)
  assert.match(chat, /<table[^>]*aria-label="对话服务账号"/)
  assert.ok(chat.includes("编辑 对话账号") && !chat.includes("主账号") && !chat.includes("AI识图默认模型"))
  assert.match(chat, /Anthropic 消息/)
  assert.doesNotMatch(chat, /默认识图/)
  assert.match(image, /<table[^>]*aria-label="生图服务账号"/)
  assert.ok(image.includes("编辑 生图账号") && !image.includes("主账号") && !image.includes("AI识图默认模型"))
  assert.doesNotMatch(image, /默认识图/)
  assert.match(limits, /aria-label="AI 运行限制"/)
  for (const label of ["全局并发上限", "单用户并发上限", "单账号并发上限", "单用户每分钟请求数", "并发租约时长（秒）", "允许模型列表与连接测试访问公网地址"]) assert.ok(limits.includes(label), label)
  for (const value of ["20", "3", "4", "15", "120"]) assert.match(limits, new RegExp(`value="${value}"`))
  assert.match(limits, /role="switch"[^>]*aria-checked="true"/)
  assert.doesNotMatch(html, /\/cpa\/|CLIProxy|role="alert"|AI 账号池/)
})

test("empty pools keep their toolbar and table available", () => {
  const html = renderToStaticMarkup(<PlatformAiAccountsScreen initialOverview={{ ai_default_model: "", ai_accounts: [], ai_runtime: runtime }} />)
  for (const label of ["搜索账号", "刷新", "新增账号", "账号名称", "服务地址", "模型", "状态", "操作", "还没有 AI 账号"]) assert.ok(html.includes(label))
  assert.match(html, /0 个账号 · 0 个已启用/)
})

test("unclassified accounts and missing runtime stay visible and disable changes", () => {
  const old = { ai_default_model: "model-a", ai_accounts: [{ ...account, purpose: null }], ai_runtime: null }
  const html = renderToStaticMarkup(<PlatformAiAccountsScreen initialOverview={old} />)
  assert.match(html, /账号用途未确认：主账号/)
  assert.match(html, /AI 运行限制未确认/)
  assert.match(html, /账号分类未确认/)
  assert.doesNotMatch(html, /还没有 AI 账号/)
  assert.match(html, /aria-label="新增账号"[^>]*disabled|disabled[^>]*aria-label="新增账号"/)
  assert.doesNotMatch(html, /aria-label="AI 运行限制"/)
  assert.equal(accountForModel(old.ai_accounts, "model-a"), undefined)
  const pricesHtml = renderToStaticMarkup(<AiAllowlist hideModelSummary accountsUnknown accounts={old.ai_accounts} defaultModel="model-a" prices={[price]} busy onPrices={() => {}} onDefaultModel={() => {}} onDeletePrice={async () => true} />)
  assert.match(pricesHtml, /账号状态未确认/)
  assert.doesNotMatch(pricesHtml, /无可用账号/)
})

test("new account form defaults to DeepSeek 4.1 Flash with thinking off and hides advanced fields", () => {
  const html = renderToStaticMarkup(<AiAccountEditor purpose="ocr" busy={false} onSave={() => {}} />)
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
  const html = renderToStaticMarkup(<AiAccountEditor account={account} purpose="ocr" busy={false} onSave={() => {}} />)
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

test("chat account form chooses the wire format and the controls that format understands", () => {
  const html = renderToStaticMarkup(<AiAccountEditor purpose="chat" busy={false} onSave={() => {}} />)
  assert.match(html, /DeepSeek 4.1 Flash · 关闭思考/)
  assert.match(html, /id="ai-format"/)
  assert.match(html, /id="ai-thinking"/)
  assert.match(html, /id="ai-thinking-format"/)
  assert.match(html, /例如：对话主账号/)
  assert.doesNotMatch(html, /不能用于识图/)
  const saved = renderToStaticMarkup(<AiAccountEditor account={chatAccount} purpose="chat" busy={false} onSave={() => {}} />)
  assert.match(saved, /Anthropic 消息/)
  assert.match(saved, /Anthropic 预算/)
  assert.match(saved, /value="claude-sonnet-5-5"/)
})

test("image account form fixes the Bailian image model and carries no thinking controls", () => {
  const html = renderToStaticMarkup(<AiAccountEditor purpose="image" busy={false} onSave={() => {}} />)
  assert.match(html, /value="qwen-image-2\.1-pro"/)
  assert.match(html, /<details[^>]*\bopen=/)
  assert.doesNotMatch(html, /id="ai-choice"|id="ai-thinking"|id="ai-thinking-format"|id="ai-format"|对话补全/)
  assert.match(html, /生图主账号/)
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

test("model search filters rows without treating the hidden default as unpriced", () => {
  const html = renderToStaticMarkup(<AiAllowlist accounts={[account]} defaultModel="model-a" prices={[price, { ...price, model: "model-b" }]} modelQuery=" MODEL-B " busy={false} onPrices={() => {}} onDefaultModel={() => {}} onDeletePrice={async () => true} />)
  const table = html.match(/<table\b[\s\S]*?<\/table>/)?.[0] ?? ""
  assert.match(table, /model-b/)
  assert.doesNotMatch(table, /model-a|未定价/)
  assert.doesNotMatch(html, /请先定价，再使用此模型识图/)
})

test("an unmatched search keeps the empty result distinct from an empty model list", () => {
  const html = renderToStaticMarkup(<AiAllowlist accounts={[account]} defaultModel="model-a" prices={[price]} modelQuery="missing" busy={false} onPrices={() => {}} onDefaultModel={() => {}} onDeletePrice={async () => true} />)
  assert.match(html, /没有匹配的模型/)
  assert.doesNotMatch(html, /还没有识图模型|未定价/)
})

test("empty OCR model list keeps its columns and add action available", () => {
  const html = renderToStaticMarkup(<AiAllowlist accounts={[]} defaultModel="" prices={[]} busy={false} onPrices={() => {}} onDefaultModel={() => {}} onDeletePrice={async () => true} />)
  for (const label of ["模型", "计价", "零售", "单次约估", "生效自", "操作", "还没有识图模型", "添加模型"]) assert.ok(html.includes(label))
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

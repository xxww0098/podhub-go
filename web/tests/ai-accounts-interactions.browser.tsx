import { flushSync } from "react-dom"
import { createRoot } from "react-dom/client"
import type { IntegrationCredentialsOverview } from "@/bindings/commands"
import { adminHttp } from "@/bindings/http-admin"
import { aiAccountsHttp } from "@/bindings/http-ai-accounts"
import { integrationsHttp } from "@/bindings/http-integrations"
import { PlatformAiAccountsScreen } from "@/features/platform/ai-accounts-screen"
import "../src/index.css"

const fixture = document.querySelector<HTMLDivElement>("#fixture")!
const results = document.querySelector<HTMLPreElement>("#results")!
const run = document.querySelector<HTMLButtonElement>("#run")!
const frame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
function check(value: unknown, message: string): asserts value { if (!value) throw new Error(message) }

const overview: IntegrationCredentialsOverview = {
  ai_default_model: "model-a",
  ai_accounts: [{ id: "a", ref_id: "a", label: "测试账号", configured: true, active: true,
    base_url: "https://example.test/v1", api_format: "chat_completions", model: "model-a",
    thinking: false, thinking_format: "none", priority: 0, purpose: "ocr" }],
  ai_runtime: { max_concurrency_global: 0, max_concurrency_user: 0, max_concurrency_account: 0, user_rate_per_minute: 0, lease_ttl_seconds: 90, allow_public_egress: false },
}

run.onclick = async () => {
  run.disabled = true
  delete results.dataset.result
  const originalProbe = aiAccountsHttp.verifyModel
  const originalSave = aiAccountsHttp.upsert
  const originalSetDefault = aiAccountsHttp.setDefaultModel
  const originalRead = integrationsHttp.integrationsGetCredentials
  const originalPrices = adminHttp.adminListAiPrices
  const root = createRoot(fixture)
  const settle = async (predicate: () => boolean, message: string) => {
    const deadline = performance.now() + 1500
    while (!predicate()) {
      check(performance.now() < deadline, message)
      await frame()
    }
  }
  try {
    let resolveProbe: ((value: { verified: boolean; model_present: boolean; latency_ms: number }) => void) | undefined
    aiAccountsHttp.verifyModel = () => new Promise((resolve) => { resolveProbe = resolve })
    aiAccountsHttp.upsert = async () => overview
    integrationsHttp.integrationsGetCredentials = async () => overview
    const price = { billing_mode: "per_request" as const, per_request_microfen: 1, input_microfen_per_million: 0, output_microfen_per_million: 0, reasoning_microfen_per_million: 0, cached_input_microfen_per_million: 0, max_request_microfen: 1, effective_from: "2026-10-01" }
    adminHttp.adminListAiPrices = async () => ["model-a", "model-b", "model-c"].map((model) => ({ ...price, model }))
    flushSync(() => root.render(<PlatformAiAccountsScreen initialOverview={overview} />))
    fixture.querySelector<HTMLButtonElement>('[aria-label="测试连接 测试账号"]')!.click()
    await settle(() => !!fixture.querySelector<HTMLButtonElement>('[aria-label="编辑 测试账号"]')?.disabled, "edit stayed enabled during a probe")
    check(fixture.querySelector<HTMLButtonElement>('[aria-label="刷新"]')?.disabled, "refresh stayed enabled during a probe")
    check(resolveProbe, "probe was not started")
    resolveProbe({ verified: true, model_present: true, latency_ms: 3 })
    await settle(() => !!fixture.textContent?.includes("连接正常"), "probe result was not shown")
    fixture.querySelector<HTMLButtonElement>('[aria-label="编辑 测试账号"]')!.click()
    await settle(() => !!document.querySelector('[role="dialog"] form'), "account editor did not open")
    document.querySelector<HTMLFormElement>('[role="dialog"] form')!.requestSubmit()
    await settle(() => !document.querySelector('[role="dialog"]') && !!fixture.textContent?.includes("尚未测试"), "saved account retained its old connection result")
    check(!fixture.textContent?.includes("连接正常"), "saved account still showed an old success")

    const eligible = { ...overview, ai_accounts: [overview.ai_accounts[0], { ...overview.ai_accounts[0], id: "b", label: "第二账号", model: "model-b" }, { ...overview.ai_accounts[0], id: "c", label: "未启用", model: "model-c", active: false }] }
    let requestedModel = ""
    let finishDefault: ((value: IntegrationCredentialsOverview) => void) | undefined
    aiAccountsHttp.setDefaultModel = (model) => { requestedModel = model; return new Promise((resolve) => { finishDefault = resolve }) }
    flushSync(() => root.render(<PlatformAiAccountsScreen key="default-model" initialOverview={eligible} />))
    const modelSelect = fixture.querySelector<HTMLButtonElement>('[aria-label="AI识图默认模型"]')!
    await settle(() => !modelSelect.disabled, "eligible default selector stayed disabled")
    modelSelect.click()
    await settle(() => !!document.querySelector('[role="option"]'), "model choices did not open")
    const options = [...document.querySelectorAll<HTMLElement>('[role="option"]')]
    check(options.some((item) => item.textContent?.trim() === "model-b"), "priced model with an active account was missing")
    check(!options.some((item) => item.textContent?.trim() === "model-c"), "inactive account was offered as an AI image recognition model")
    options.find((item) => item.textContent?.trim() === "model-b")!.click()
    await settle(() => requestedModel === "model-b" && modelSelect.disabled, "default change did not lock controls")
    check(finishDefault, "default change was not started")
    finishDefault({ ...eligible, ai_default_model: "model-b" })
    await settle(() => modelSelect.textContent?.includes("model-b") === true && !modelSelect.disabled, "default change did not read back the selected model")
    let failedChange = false
    aiAccountsHttp.setDefaultModel = async () => { failedChange = true; throw new Error("write failed") }
    modelSelect.click()
    await settle(() => !![...document.querySelectorAll<HTMLElement>('[role="option"]')].find((item) => item.textContent?.trim() === "model-a"), "model choices did not reopen")
    const firstChoice = [...document.querySelectorAll<HTMLElement>('[role="option"]')].find((item) => item.textContent?.trim() === "model-a")!
    firstChoice.click()
    await settle(() => failedChange && !modelSelect.disabled, "failed change did not unlock the selector")
    check(modelSelect.textContent?.includes("model-b"), "failed change falsely updated the selected model")

    adminHttp.adminListAiPrices = async () => { throw new Error("prices unavailable") }
    flushSync(() => root.render(<PlatformAiAccountsScreen key="price-failure" initialOverview={eligible} />))
    await settle(() => !!fixture.textContent?.includes("模型价格未确认"), "price read failure was not shown")
    check(fixture.querySelector<HTMLButtonElement>('[aria-label="AI识图默认模型"]')?.disabled, "unknown prices allowed a default change")
    check(fixture.textContent?.includes("第二账号"), "price failure hid the readable accounts")
    adminHttp.adminListAiPrices = async () => ["model-a", "model-b", "model-c"].map((model) => ({ ...price, model }))

    const many = { ...overview, ai_accounts: Array.from({ length: 23 }, (_, index) => ({ ...overview.ai_accounts[0], id: `id-${String(index).padStart(2, "0")}`, label: `账号 ${String(index).padStart(2, "0")}` })) }
    flushSync(() => root.render(<PlatformAiAccountsScreen key="paging" initialOverview={many} />))
    check(fixture.textContent?.includes("账号 00") && !fixture.textContent?.includes("账号 10"), "first page does not contain ten accounts")
    fixture.querySelector<HTMLButtonElement>('[aria-label="下一页"]')!.click()
    await settle(() => !!fixture.textContent?.includes("账号 10") && !fixture.textContent?.includes("账号 00"), "next page did not change rows")
    const search = fixture.querySelector<HTMLInputElement>('[aria-label="搜索账号"]')!
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(search, "账号 00")
    search.dispatchEvent(new Event("input", { bubbles: true }))
    await settle(() => !!fixture.textContent?.includes("账号 00") && !!fixture.querySelector('[aria-label="第 1 页，共 1 页"]'), "filter did not reset the page")

    integrationsHttp.integrationsGetCredentials = async () => { throw new Error("read failed") }
    flushSync(() => root.render(<PlatformAiAccountsScreen key="failed-read" />))
    await settle(() => !!fixture.textContent?.includes("无法读取 AI 账号"), "read failure was not shown")
    check(fixture.textContent?.includes("状态未确认"), "failed read was presented as an empty account pool")
    check(!fixture.textContent?.includes("0 个账号"), "failed read showed a fabricated account count")
    results.textContent = "PASS: probe locks mutations; default model uses priced ready accounts; failures stay unknown; pagination resets"
    results.dataset.result = "pass"
  } catch (reason) {
    results.textContent = `FAIL: ${reason instanceof Error ? reason.message : String(reason)}`
    results.dataset.result = "fail"
  } finally {
    flushSync(() => root.unmount())
    aiAccountsHttp.verifyModel = originalProbe
    aiAccountsHttp.upsert = originalSave
    aiAccountsHttp.setDefaultModel = originalSetDefault
    integrationsHttp.integrationsGetCredentials = originalRead
    adminHttp.adminListAiPrices = originalPrices
    run.disabled = false
  }
}

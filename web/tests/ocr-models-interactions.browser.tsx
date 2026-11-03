import { useState } from "react"
import { createRoot } from "react-dom/client"
import type { AiPriceView, IntegrationCredentialsOverview } from "@/bindings/commands"
import { AppShell } from "@/app/app-shell"
import { accountHttp } from "@/bindings/http-account"
import { adminHttp } from "@/bindings/http-admin"
import { aiAccountsHttp } from "@/bindings/http-ai-accounts"
import { integrationsHttp } from "@/bindings/http-integrations"
import type { SettingsSection } from "@/lib/settings-sections"
import { noNotifications, overview as accountFixture } from "./account-fixtures"
import "../src/index.css"

const fixture = document.querySelector<HTMLDivElement>("#fixture")!
const results = document.querySelector<HTMLPreElement>("#results")!
const run = document.querySelector<HTMLButtonElement>("#run")!
const account = { ...accountFixture, session: { ...accountFixture.session, role: "super_admin" } }
let integration: IntegrationCredentialsOverview = {
  ai_default_model: "",
  ai_accounts: ["model-a", "model-b"].map((model) => ({
    id: model, ref_id: model, label: model, configured: true, active: true,
    base_url: "https://example.test/v1", api_format: "chat_completions", model,
    thinking: false, thinking_format: "none", priority: 0, purpose: "ocr",
  })),
  ai_runtime: { max_concurrency_global: 0, max_concurrency_user: 0, max_concurrency_account: 0,
    user_rate_per_minute: 0, lease_ttl_seconds: 90, allow_public_egress: false },
}
let prices: AiPriceView[] = ["model-a", "model-b"].map((model) => ({
  model, billing_mode: "per_request", per_request_microfen: 1000000,
  input_microfen_per_million: 0, cached_input_microfen_per_million: 0,
  output_microfen_per_million: 0, reasoning_microfen_per_million: 0,
  max_request_microfen: 1000000, effective_from: "2026-10-28",
}))
let failPriceRead = false
let publishedModel = ""
accountHttp.accountGetOverview = async () => account
integrationsHttp.integrationsGetCredentials = async () => integration
adminHttp.adminListAiPrices = async () => {
  if (failPriceRead) { failPriceRead = false; throw new Error("isolated price read failure") }
  return prices
}
adminHttp.adminPublishAiPrice = async (request) => {
  publishedModel = request.model
  prices = prices.map((price) => price.model === request.model ? { ...price, ...request } : price)
  return { prices }
}
adminHttp.adminDeleteAiPrice = async (model) => { prices = prices.filter((price) => price.model !== model); return { prices } }
aiAccountsHttp.setDefaultModel = async (model) => { integration = { ...integration, ai_default_model: model }; return integration }

function Fixture() {
  const [section, setSection] = useState<SettingsSection | null>("ai-accounts")
  return <AppShell screen="supplier-dbs" adminSurface settingsRequest={section} onSettingsRequestChange={setSection}
    overview={account} onScreenChange={() => {}} onSignedOut={() => {}} notifications={noNotifications}><div /></AppShell>
}
createRoot(fixture).render(<Fixture />)

const frame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
function check(value: unknown, message: string): asserts value { if (!value) throw new Error(message) }
async function settle(predicate: () => boolean, message: string) {
  const deadline = performance.now() + 3000
  while (!predicate()) { check(performance.now() < deadline, message); await frame() }
}
function button(label: string): HTMLButtonElement {
  const node = [...document.querySelectorAll<HTMLButtonElement>("button")].find((item) => item.textContent?.trim() === label)
  check(node, `missing button: ${label}`)
  return node
}

run.onclick = async () => {
  run.disabled = true
  try {
    await settle(() => !!document.querySelector('[aria-label="搜索模型名称"]') && fixture.textContent?.includes("model-b") === true, "model list did not load")
    check(!fixture.querySelector('[aria-label="设置分区"] [aria-label="AI识图"]'), "AI recognition still has a standalone menu")
    check(fixture.querySelector('[aria-label="AI 账号"][aria-current="page"]'), "AI accounts navigation is not selected")
    check(fixture.querySelector('[aria-label="AI识图服务账号"]'), "AI recognition accounts are missing from AI accounts")
    button("生图").click()
    await settle(() => button("生图").getAttribute("aria-selected") === "true", "image tab did not open")
    button("AI识图").click()
    await settle(() => button("AI识图").getAttribute("aria-selected") === "true", "AI recognition tab did not reopen")
    const search = document.querySelector<HTMLInputElement>('[aria-label="搜索模型名称"]')!
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(search, "missing")
    search.dispatchEvent(new Event("input", { bubbles: true }))
    await settle(() => fixture.textContent?.includes("没有匹配的模型") === true, "search empty state failed")
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(search, "")
    search.dispatchEvent(new Event("input", { bubbles: true }))
    await settle(() => fixture.textContent?.includes("model-b") === true, "clearing search failed")
    const defaultForModel = () => {
      const modelRow = fixture.querySelector('[aria-label="编辑 model-b 价格"]')?.closest("tr")
      return [...(modelRow?.querySelectorAll<HTMLButtonElement>("button") ?? [])].find((item) => item.textContent?.trim() === "设为识图")
    }
    await settle(() => !!defaultForModel(), "model-b default action was missing")
    const setDefault = defaultForModel()
    check(setDefault, "model-b default action was missing")
    setDefault.click()
    await settle(() => integration.ai_default_model === "model-b" && fixture.querySelector('[aria-label="AI识图默认模型"]')?.textContent?.includes("model-b") === true && !document.querySelector<HTMLButtonElement>('[aria-label="编辑 model-a 价格"]')?.disabled, "default model did not read back")
    document.querySelector<HTMLButtonElement>('[aria-label="编辑 model-a 价格"]')!.click()
    await settle(() => !!document.querySelector('[role="dialog"] #ai-rate-per-request'), "price editor did not open")
    button("发布价格").click()
    await settle(() => publishedModel === "model-a" && !document.querySelector('[role="dialog"]'), "isolated price publish failed")
    failPriceRead = true
    document.querySelector<HTMLButtonElement>('[aria-label="刷新模型"]')!.click()
    await settle(() => !!document.querySelector('[aria-label="重试读取价格"]'), "price failure was not visible")
    document.querySelector<HTMLButtonElement>('[aria-label="重试读取价格"]')!.click()
    await settle(() => !!document.querySelector('[aria-label="搜索模型名称"]'), "price retry failed")
    integration = { ...integration, ai_runtime: null, ai_accounts: [{ ...integration.ai_accounts[0], purpose: null }] }
    document.querySelector<HTMLButtonElement>('[aria-label="刷新模型"]')!.click()
    await settle(() => fixture.textContent?.includes("状态未确认") === true && !!document.querySelector<HTMLButtonElement>('[aria-label="添加模型"]')?.disabled, "unknown settings allowed writes")
    integration = { ...integration, ai_runtime: { max_concurrency_global: 0, max_concurrency_user: 0, max_concurrency_account: 0, user_rate_per_minute: 0, lease_ttl_seconds: 90, allow_public_egress: false }, ai_accounts: [{ ...integration.ai_accounts[0], purpose: "ocr" }] }
    prices = Array.from({ length: 12 }, (_, index) => ({ ...prices[0], model: `paged-${String(index).padStart(2, "0")}` }))
    document.querySelector<HTMLButtonElement>('[aria-label="刷新模型"]')!.click()
    await settle(() => fixture.textContent?.includes("paged-00") === true && !document.querySelector<HTMLButtonElement>('[aria-label="下一页模型"]')?.disabled, "first model page failed")
    document.querySelector<HTMLButtonElement>('[aria-label="下一页模型"]')!.click()
    await settle(() => fixture.textContent?.includes("paged-10") === true && !fixture.textContent?.includes("paged-00"), "next model page failed")
    const pagedSearch = document.querySelector<HTMLInputElement>('[aria-label="搜索模型名称"]')!
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(pagedSearch, "paged-00")
    pagedSearch.dispatchEvent(new Event("input", { bubbles: true }))
    await settle(() => fixture.textContent?.includes("paged-00") === true && !!document.querySelector('[aria-label="第 1 页，共 1 页"]'), "model search did not reset page")
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(pagedSearch, "")
    pagedSearch.dispatchEvent(new Event("input", { bubbles: true }))
    await settle(() => !document.querySelector<HTMLButtonElement>('[aria-label="下一页模型"]')?.disabled, "model pages did not return")
    document.querySelector<HTMLButtonElement>('[aria-label="每页模型数"]')!.click()
    await settle(() => [...document.querySelectorAll<HTMLElement>('[role="option"]')].some((option) => option.textContent?.trim() === "20 条"), "page-size options did not open")
    ;[...document.querySelectorAll<HTMLElement>('[role="option"]')].find((option) => option.textContent?.trim() === "20 条")!.click()
    await settle(() => fixture.textContent?.includes("paged-11") === true && !!document.querySelector<HTMLButtonElement>('[aria-label="下一页模型"]')?.disabled, "20-model page failed")
    document.querySelector<HTMLButtonElement>('[aria-label="每页模型数"]')!.click()
    await settle(() => [...document.querySelectorAll<HTMLElement>('[role="option"]')].some((option) => option.textContent?.trim() === "10 条"), "page-size options did not reopen")
    ;[...document.querySelectorAll<HTMLElement>('[role="option"]')].find((option) => option.textContent?.trim() === "10 条")!.click()
    await settle(() => !document.querySelector<HTMLButtonElement>('[aria-label="下一页模型"]')?.disabled, "10-model page failed")
    document.querySelector<HTMLButtonElement>('[aria-label="下一页模型"]')!.click()
    await settle(() => fixture.textContent?.includes("paged-10") === true, "second page did not return")
    prices = prices.slice(0, 3)
    document.querySelector<HTMLButtonElement>('[aria-label="刷新模型"]')!.click()
    await settle(() => fixture.textContent?.includes("paged-00") === true && !!document.querySelector('[aria-label="第 1 页，共 1 页"]'), "shorter result did not clamp page")
    results.textContent = "PASS: AI识图账号、页签、搜索、默认模型、定价、重试、未知状态保护和分页"
    results.dataset.result = "pass"
  } catch (reason) {
    results.textContent = `FAIL: ${reason instanceof Error ? reason.message : String(reason)}`
    results.dataset.result = "fail"
  } finally { run.disabled = false }
}

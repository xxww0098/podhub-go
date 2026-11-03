// The fixture blocks network access and exercises only local payment drafts.
import { flushSync } from "react-dom"
import { createRoot } from "react-dom/client"
import type { PaymentConfigData, ReplacePaymentConfigRequest } from "@/bindings/commands"
import { integrationsHttp } from "@/bindings/http-integrations"
import { Toaster } from "@/components/ui/toast"
import { PaymentConfigPanel } from "@/features/platform/payment-config"
import "../src/index.css"

const fixture = document.querySelector<HTMLDivElement>("#fixture")!
const results = document.querySelector<HTMLPreElement>("#results")!
const run = document.querySelector<HTMLButtonElement>("#run")!
const originals = { ...integrationsHttp }
const unexpected: string[] = []
window.fetch = async (input) => { unexpected.push(String(input)); throw new Error("Unexpected network request") }
const frame = () => new Promise<void>((resolve) => { const timeout = window.setTimeout(resolve, 10); requestAnimationFrame(() => { window.clearTimeout(timeout); resolve() }) })
async function settle() { await frame(); await frame() }
function check(value: unknown, message: string): asserts value { if (!value) throw new Error(message) }
function button(text: string) {
  const matches = [...fixture.querySelectorAll<HTMLButtonElement>("button")].filter((item) => item.textContent?.trim() === text || item.getAttribute("aria-label") === text)
  check(matches.length === 1, `Expected one ${text} button, got ${matches.length}`)
  return matches[0]!
}
async function click(element: HTMLElement) { flushSync(() => element.click()); await settle() }
async function input(id: string, value: string) {
  const element = fixture.querySelector<HTMLInputElement | HTMLTextAreaElement>(`#${id}`)
  check(element, `Missing ${id}`)
  const prototype = element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
  Object.getOwnPropertyDescriptor(prototype, "value")!.set!.call(element, value)
  element.dispatchEvent(new Event("input", { bubbles: true }))
  await settle()
}
const config: PaymentConfigData = {
  revision: 7,
  providers: [
    { provider: "alipay", enabled: true, configured: true, values: { appId: "old-id", gateway: "https://openapi.alipay.com/gateway.do" }, secretFieldsConfigured: ["privateKey", "alipayPublicKey"] },
    ...["wechat", "easypay", "stripe", "airwallex"].map((provider) => ({ provider, enabled: false, configured: false, values: {}, secretFieldsConfigured: [] })),
  ],
}

async function draftsAndSaveBoundary() {
  let sent: ReplacePaymentConfigRequest | undefined
  integrationsHttp.integrationsReplacePaymentConfig = async (request) => { sent = structuredClone(request); return config }
  const root = createRoot(fixture)
  try {
    flushSync(() => root.render(<Toaster><PaymentConfigPanel initialConfig={config} /></Toaster>)); await settle()
    check(fixture.querySelector('[aria-label="支付宝配置"]'), "Alipay is the initial configuration")
    check(fixture.querySelector<HTMLTextAreaElement>("#payment-alipay-privateKey")?.placeholder.includes("留空保持不变"), "Saved secrets remain hidden")
    await input("payment-alipay-appId", "new-app-id")
    await input("payment-alipay-privateKey", "fixture-key-line-1\nfixture-key-line-2")
    await click(button("显示应用私钥"))
    check(button("隐藏应用私钥").getAttribute("aria-pressed") === "true", "Secret visibility can be toggled")
    await click(button("清空应用私钥输入"))
    check(fixture.querySelector<HTMLTextAreaElement>("#payment-alipay-privateKey")?.value === "", "Clear affects only the unsaved secret input")
    check(button("显示应用私钥").disabled, "An empty secret is hidden and cannot be revealed")
    await input("payment-alipay-privateKey", "fixture-key-line-1\nfixture-key-line-2")
    await click(button("显示应用私钥"))
    const wechat = [...fixture.querySelectorAll<HTMLButtonElement>('[aria-pressed]')].find((item) => item.textContent?.includes("微信支付"))
    check(wechat, "WeChat is selectable")
    await click(wechat)
    await input("payment-wechat-privateKey", "fixture-wechat-key")
    check(button("显示商户 API 私钥").getAttribute("aria-pressed") === "false", "A different provider's secret starts hidden")
    const easy = [...fixture.querySelectorAll<HTMLButtonElement>('[aria-pressed]')].find((item) => item.textContent?.includes("易支付"))
    check(easy, "EasyPay is selectable")
    await click(easy)
    await input("payment-easypay-pid", "merchant-test")
    const ali = [...fixture.querySelectorAll<HTMLButtonElement>('[aria-pressed]')].find((item) => item.textContent?.includes("支付宝"))
    check(ali, "Alipay is selectable")
    await click(ali)
    check(fixture.querySelector<HTMLTextAreaElement>("#payment-alipay-privateKey")?.value.includes("fixture-key-line-2"), "Switching providers retains the unsaved draft")
    check(button("显示应用私钥").getAttribute("aria-pressed") === "false", "Switching providers hides the secret again")
    await click(button("保存全部支付配置"))
    check(sent?.expectedRevision === 7 && sent.providers.length === 5, "Save includes the revision and all five providers")
    const savedAli = sent.providers.find((row) => row.provider === "alipay")
    const savedEasy = sent.providers.find((row) => row.provider === "easypay")
    check(savedAli?.values.appId === "new-app-id" && savedAli.values.privateKey.includes("fixture-key-line-2"), "Save contains the edited Alipay fields")
    check(savedAli.values.alipayPublicKey === "" && savedEasy?.values.pid === "merchant-test", "Unchanged secrets and another provider draft are preserved")
    check(fixture.querySelector<HTMLTextAreaElement>("#payment-alipay-privateKey")?.value === "", "A successful response clears entered secrets")
  } finally { flushSync(() => root.unmount()); Object.assign(integrationsHttp, originals); await settle() }
}

async function failedSaveKeepsDraft() {
  let attempts = 0
  integrationsHttp.integrationsReplacePaymentConfig = async () => { attempts++; throw new Error("fixture save failed") }
  const root = createRoot(fixture)
  try {
    flushSync(() => root.render(<Toaster><PaymentConfigPanel initialConfig={config} /></Toaster>)); await settle()
    await input("payment-alipay-appId", "unsaved-app-id")
    await click(button("保存全部支付配置"))
    check(attempts === 1 && fixture.querySelector<HTMLInputElement>("#payment-alipay-appId")?.value === "unsaved-app-id", "A failed save retains the draft")
    check(!button("保存全部支付配置").disabled, "A failed save can be retried")
  } finally { flushSync(() => root.unmount()); Object.assign(integrationsHttp, originals); await settle() }
}

async function failedReadCanRetry() {
  let attempts = 0
  integrationsHttp.integrationsGetPaymentConfig = async () => { attempts++; if (attempts === 1) throw new Error("fixture unavailable"); return config }
  const root = createRoot(fixture)
  try {
    flushSync(() => root.render(<Toaster><PaymentConfigPanel /></Toaster>)); await settle()
    check(fixture.querySelector('[role="alert"]')?.textContent?.includes("无法读取支付配置"), "Read failure is visible")
    await click(button("重试"))
    check(attempts === 2 && fixture.querySelector('[aria-label="支付宝配置"]'), "Retry reads and renders the configuration")
  } finally { flushSync(() => root.unmount()); Object.assign(integrationsHttp, originals); await settle() }
}

async function incompleteResponseBlocksSave() {
  const partial = { ...config, providers: config.providers.filter((provider) => provider.provider !== "stripe") }
  const root = createRoot(fixture)
  try {
    flushSync(() => root.render(<Toaster><PaymentConfigPanel initialConfig={partial} /></Toaster>)); await settle()
    check(button("保存全部支付配置").disabled, "An incomplete response cannot replace the whole configuration")
    check(fixture.querySelector('[role="alert"]')?.textContent?.includes("部分支付渠道未读取"), "The missing data is explained")
  } finally { flushSync(() => root.unmount()); Object.assign(integrationsHttp, originals); await settle() }
}

run.onclick = async () => {
  run.disabled = true; const lines: string[] = []
  for (const [name, checkCase] of [["cross-provider draft and save boundary", draftsAndSaveBoundary], ["failed save retains draft", failedSaveKeepsDraft], ["read failure and retry", failedReadCanRetry], ["incomplete response blocks save", incompleteResponseBlocksSave]] as const) {
    try { await checkCase(); lines.push(`PASS ${name}`) } catch (error) { lines.push(`FAIL ${name}: ${String(error)}`) }
  }
  if (unexpected.length) lines.push(`FAIL unexpected network calls: ${unexpected.length}`)
  results.textContent = lines.join("\n"); results.dataset.result = lines.some((line) => line.startsWith("FAIL")) ? "failed" : "passed"; run.disabled = false
}
if (new URLSearchParams(location.search).has("autorun")) run.click()

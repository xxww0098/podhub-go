import { useState } from "react"
import { createRoot } from "react-dom/client"

import { AppShell } from "@/app/app-shell"
import { accountHttp } from "@/bindings/http-account"
import { adminHttp, type CatalogFetchConfigData } from "@/bindings/http-admin"
import type { SettingsSection } from "@/lib/settings-sections"
import { noNotifications, overview } from "./account-fixtures"
import "../src/index.css"

const fixture = document.querySelector<HTMLDivElement>("#fixture")!
const results = document.querySelector<HTMLPreElement>("#results")!
const run = document.querySelector<HTMLButtonElement>("#run")!
const account = { ...overview, session: { ...overview.session, role: "super_admin" } }
let config: CatalogFetchConfigData = {
  enabled: false, schedule_mode: "fixed", at_minute: 180, window_start_minute: 120,
  window_end_minute: 240, utc_offset_minutes: 480, keys: [], next_run_at_ms: null,
  last_run_at_ms: null, last_status: null, last_error: "", last_duration_ms: null,
  last_root_nodes: null, last_key_client_id: null, last_key_attempts: 0,
  failure_streak: 0, running: false, updated_at_ms: 0,
  coordinate_freshness: { total: 0, fresh: 0, stale: 0, expired: 0, missing: 0 },
}
let saveCount = 0
let runCount = 0
let failRead = false
window.fetch = async () => { throw new Error("unexpected network request in category fixture") }
accountHttp.accountGetOverview = async () => account
adminHttp.catalogFetchConfig = async () => {
  if (failRead) { failRead = false; throw new Error("isolated read failure") }
  return structuredClone(config)
}
adminHttp.saveCatalogFetchConfig = async (request) => {
  saveCount++
  if (saveCount === 1) throw new Error("isolated save failure")
  config = { ...config, ...request, keys: request.keys.map((key) => ({ client_id: key.client_id, api_key_configured: true, disabled: false })) }
  return structuredClone(config)
}
adminHttp.runCatalogFetch = async () => {
  runCount++
  config = { ...config, last_run_at_ms: Date.now(), last_status: "ok", last_key_client_id: config.keys[0]?.client_id ?? null, last_key_attempts: 1, last_root_nodes: 1, last_duration_ms: 1 }
  return structuredClone(config)
}

function Fixture() {
  const [section, setSection] = useState<SettingsSection | null>("categories")
  return <AppShell screen="supplier-dbs" adminSurface settingsRequest={section} onSettingsRequestChange={setSection}
    overview={account} onScreenChange={() => {}} onSignedOut={() => {}} notifications={noNotifications}><div /></AppShell>
}
createRoot(fixture).render(<Fixture />)
if (new URLSearchParams(location.search).has("visual")) run.hidden = true

const frame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
function check(value: unknown, message: string): asserts value { if (!value) throw new Error(message) }
async function settle(predicate: () => boolean, message: string) {
  const deadline = performance.now() + 3000
  while (!predicate()) { check(performance.now() < deadline, message); await frame() }
}
function button(label: string) {
  const node = [...fixture.querySelectorAll<HTMLButtonElement>("button")].find((item) => item.textContent?.trim() === label)
  check(node, `missing button: ${label}`)
  return node
}
function fill(input: HTMLInputElement, value: string) {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value)
  input.dispatchEvent(new Event("input", { bubbles: true }))
}

run.onclick = async () => {
  run.disabled = true
  try {
    await settle(() => !!fixture.querySelector("#catalog-key-client-0"), "configuration did not load")
    check(button("立即抓取").disabled, "an unsaved key must not allow a run")
    const client = fixture.querySelector<HTMLInputElement>("#catalog-key-client-0")!
    const secret = fixture.querySelector<HTMLInputElement>("#catalog-key-secret-0")!
    fill(client, "fixture-client")
    fill(secret, "fixture-secret")
    await settle(() => !button("保存配置").disabled, "valid draft could not be saved")
    check(secret.type === "password", "secret was visible by default")
    fixture.querySelector<HTMLButtonElement>('[aria-label="显示第 1 把 Api-Key"]')!.click()
    await settle(() => secret.type === "text", "secret visibility did not toggle")
    button("保存配置").click()
    await frame()
    await settle(() => saveCount === 1 && !button("保存配置").disabled, "failed save did not return control")
    check(secret.value === "fixture-secret" && button("立即抓取").disabled, "failed save lost the draft or enabled a run")
    button("保存配置").click()
    await settle(() => saveCount === 2 && fixture.textContent?.includes("Api-Key 已保存") === true, "save did not reflect confirmed configuration")
    check(fixture.querySelector<HTMLInputElement>("#catalog-key-secret-0")?.value === "", "saved secret remained visible")
    check(fixture.querySelector<HTMLInputElement>("#catalog-key-secret-0")?.type === "password", "save did not reset secret visibility")
    check(!button("立即抓取").disabled, "saved key did not enable manual run")
    button("立即抓取").click()
    await settle(() => runCount === 1, "manual run was not sent to the isolated API")
    await frame()
    button("添加密钥（最多 8 把）").click()
    await settle(() => !!fixture.querySelector("#catalog-key-secret-1"), "second key was not added")
    fixture.querySelector<HTMLButtonElement>('[aria-label="显示第 2 把 Api-Key"]')!.click()
    await settle(() => fixture.querySelector<HTMLInputElement>("#catalog-key-secret-1")?.type === "text", "second key did not become visible")
    fixture.querySelector<HTMLButtonElement>('[aria-label="上移第 2 把密钥"]')!.click()
    await settle(() => fixture.querySelector<HTMLInputElement>("#catalog-key-secret-0")?.type === "password" && fixture.querySelector<HTMLInputElement>("#catalog-key-secret-1")?.type === "password", "reordering exposed a secret")
    failRead = true
    fixture.querySelector<HTMLButtonElement>('button[aria-label="账号"]')!.click()
    await frame()
    fixture.querySelector<HTMLButtonElement>('button[aria-label="类目"]')!.click()
    await settle(() => !!fixture.querySelector('[aria-label="重试"]'), "failed read did not offer retry")
    fixture.querySelector<HTMLButtonElement>('[aria-label="重试"]')!.click()
    await settle(() => !!fixture.querySelector("#catalog-key-client-0"), "retry did not recover")
    results.textContent = "PASS: empty state, failed save, secret visibility, reorder, confirmed save, run and read retry"
    results.dataset.result = "pass"
  } catch (reason) {
    results.textContent = `FAIL: ${reason instanceof Error ? reason.message : String(reason)}`
    results.dataset.result = "fail"
  } finally {
    run.disabled = false
  }
}

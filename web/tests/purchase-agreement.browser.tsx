// Dev-only subscription interactions; every billing call is mocked.
import { flushSync } from "react-dom"
import { createRoot } from "react-dom/client"
import { subscriptionHttp, type SubscriptionQuote, type SubscriptionRequest } from "@/bindings/http-subscription"
import { Toaster } from "@/components/ui/toast"
import { PlansScreen } from "@/features/plans/plans-screen"
import { subscriptionFixture as view, subscriptionOverview as overview } from "./fixtures/subscription"
import "../src/index.css"

const fixture = document.querySelector<HTMLDivElement>("#fixture")!
const results = document.querySelector<HTMLPreElement>("#results")!
const run = document.querySelector<HTMLButtonElement>("#run")!
const requests: string[] = []
window.fetch = async (input) => { requests.push(String(input)); throw new Error(`Unexpected request: ${input}`) }
const frame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
async function settle() { await frame(); await frame() }
function check(value: unknown, message: string): asserts value { if (!value) throw new Error(message) }
function button(text: string, parent: ParentNode = document) {
  const found = [...parent.querySelectorAll<HTMLButtonElement>("button")].filter((el) => el.textContent?.trim() === text && !el.closest('[aria-hidden="true"]'))
  check(found.length === 1, `Expected one button ${text}, got ${found.length}`)
  return found[0]!
}
async function click(el: HTMLElement) { check(!el.hasAttribute("disabled"), "Control disabled"); flushSync(() => el.click()); await settle() }
const dialog = () => document.querySelector<HTMLElement>('[data-slot="dialog-content"]')!
const originals = { ...subscriptionHttp }
let calls: { kind: string; payload?: SubscriptionRequest }[] = []
const quoted = (req: SubscriptionRequest): SubscriptionQuote => ({
  quote_id: "quote-test", expires_at: "2026-11-21T03:00:00Z", revision: 1, action: req.action,
  current: { plan_key: "lite", stores: 8, members: 1, term_end: view.current_end },
  target: { plan_key: "lite", stores: req.action === "change" ? 8 : 6, members: 1 },
  amount_cents: req.action === "change" ? 4000 : 0, schedule_only: req.action !== "change",
  breakdown: [], effective_at: view.current_end, term_end: view.term_end,
  keep_store_ids: req.keep_store_ids ?? null, renewal: req.target!, renewal_amount_cents: 12000,
})
async function mounted(action: () => Promise<void>) {
  calls = []
  subscriptionHttp.quote = async (req) => { calls.push({ kind: "quote", payload: req }); return quoted(req) }
  subscriptionHttp.confirm = async () => { calls.push({ kind: "confirm" }); return view }
  subscriptionHttp.order = async () => { calls.push({ kind: "order" }); return { order_id: 1, public_id: "po_test", payment_deadline_at: "2026-11-21T03:00:00Z" } }
  subscriptionHttp.view = async () => view
  const root = createRoot(fixture)
  try { flushSync(() => root.render(<Toaster><PlansScreen overview={overview} subscription={view} /></Toaster>)); await settle(); await action() }
  finally { flushSync(() => root.unmount()); Object.assign(subscriptionHttp, originals); await settle() }
}
async function previewAndConfirm() {
  await mounted(async () => {
    await click(button("调整下期店铺数量"))
    check(dialog().textContent?.includes("只需暂停 1 家"), "Only occupied excess should require suspension")
    await click(button("预览费用与生效日期", dialog()))
    check(calls.length === 1 && calls[0]!.kind === "quote", "Preview must not persist configuration")
    check(calls[0]!.payload?.keep_store_ids?.length === 6, "Exactly six retained stores")
    check(dialog().textContent?.includes("店铺 A"), "Preview should name the paused store")
    await click(button("确认下期减少", dialog()))
    check(calls.some((c) => c.kind === "confirm"), "Explicit confirmation should save")
  })
}
async function discard() {
  await mounted(async () => {
    await click(button("调整下期店铺数量"))
    await click(button("预览费用与生效日期", dialog()))
    await click(button("返回修改", dialog()))
    check(!calls.some((c) => c.kind === "confirm" || c.kind === "order"), "Back must not buy or save")
  })
}
async function paidRestoration() {
  await mounted(async () => {
    await click(button("恢复为 8 家，预览补差"))
    await click(button("预览费用与生效日期", dialog()))
    const buy = button("恢复为 8 家，补差 ¥40", dialog())
    check(buy.disabled, "Paid future restoration requires consent")
    const consent = dialog().querySelector<HTMLElement>('[aria-label="我已阅读并同意购买确认"]')!
    check(consent.hasAttribute("disabled") || consent.getAttribute("aria-disabled") === "true", "Unread agreement must block consent")
    await click(button("阅读《订阅购买确认》", dialog()))
    check(dialog().textContent?.includes(view.purchase_agreement.content), "Agreement must be readable")
    await click(button("返回购买", dialog()))
    await click(dialog().querySelector<HTMLElement>('[aria-label="我已阅读并同意购买确认"]')!)
    await click(button("恢复为 8 家，补差 ¥40", dialog()))
    check(calls.filter((c) => c.kind === "order").length === 1, "One paid order")
    check(!calls.some((c) => c.kind === "confirm"), "Paid future restoration cannot use free schedule")
  })
}
run.onclick = async () => {
  run.disabled = true; requests.length = 0; const lines: string[] = []
  for (const [name, fn] of [["preview then explicit confirmation", previewAndConfirm], ["discard preview", discard], ["paid future restoration and consent", paidRestoration]] as const) {
    try { await fn(); lines.push(`PASS ${name}`) } catch (error) { lines.push(`FAIL ${name}: ${String(error)}`) }
    results.textContent = lines.join("\n")
  }
  if (requests.length) lines.push(`FAIL unexpected network: ${requests.join(", ")}`)
  results.textContent = lines.join("\n"); results.dataset.result = lines.some((line) => line.startsWith("FAIL")) ? "failed" : "passed"; run.disabled = false
}
if (new URLSearchParams(location.search).has("autorun")) run.click()

if (new URLSearchParams(location.search).has("preview")) {
  const root = createRoot(fixture)
  root.render(<Toaster><PlansScreen overview={overview} subscription={view} /></Toaster>)
}

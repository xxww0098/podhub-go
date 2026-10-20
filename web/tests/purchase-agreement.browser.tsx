// Dev-only interactions: all account calls are mocked; no real orders are created.
import { flushSync } from "react-dom"
import { createRoot } from "react-dom/client"
import type { AccountOverview, PaymentOrderView, SeatCatalogData, WorkspaceBillingOverviewData } from "@/bindings/commands"
import { accountHttp } from "@/bindings/http-account"
import { Toaster } from "@/components/ui/toast"
import { PlansScreen } from "@/features/plans/plans-screen"
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
async function click(el: HTMLElement) { check(!el.hasAttribute("disabled"), `Control disabled: ${el.outerHTML.slice(0,220)}`); flushSync(() => el.click()); await settle() }
const dialog = () => document.querySelector<HTMLElement>('[data-slot="dialog-content"]')!
const consent = () => dialog().querySelector<HTMLElement>('[aria-label="我已阅读并同意采购同意书"]')!
const accepted = () => consent().getAttribute("aria-checked") === "true" || (consent() as HTMLInputElement).checked === true
const submit = () => dialog().querySelector<HTMLButtonElement>('button[type="submit"]')!
const agreement = { version: "test-v1", title: "采购同意书", effective_at: "2026-09-21", content: "测试协议正文：仅用于自动检查。" }
const workspace = { id: 1, uuid: "550e8400-e29b-41d4-a716-446655440000", name: "测试 Workspace", plan: "pro", role: "owner", is_owned: true }
const overview: AccountOverview = { session: { authenticated: true, email: "test@example.invalid", role: "owner", name: "Test" }, active_workspace: workspace, workspaces: [workspace], account_mode: "owner", owned_count: 1, owned_limit: 3 }
const catalog: SeatCatalogData = {
  tiers: ["pro", "max", "ultra"].map((key) => ({ key, list_unit_month_cents: 10000, official_mcp: true, terms: [{ term: "month", unit_month_cents: 10000 }, { term: "year", unit_month_cents: 8000 }] })),
  terms: [{ key: "month", months: 1, days: 30, discount_percent: 100 }, { key: "year", months: 12, days: 365, discount_percent: 80 }],
  min_seats_per_purchase: 1, max_seats_per_purchase: 20, max_seats_per_workspace: 20, stores_per_seat: 5, free_stores: 1, max_stores_per_workspace: 100,
}
const billing: WorkspaceBillingOverviewData = { plan: "pro", purchased_seats: 1, member_seats: { default: 1, effective: 1, used: 1, suspended: 0 }, store_slots: { default: 5, effective: 5, used: 0, suspended: 0 }, upgrade_credits: [], lots: [{ id: 7, tier: "pro", seats: 1, starts_at: "2026-01-01T00:00:00Z", expires_at: "2027-01-01T00:00:00Z", upgrade_credit_cents: 0, active: true, renewable: true }] }
const order: PaymentOrderView = { public_id: "order-test", status: "pending", entry_state: "ready", amount_cents: 96000, credit_cents: 0, currency: "CNY", duration_days: 365, member_seats: 1, months: 12, unit_month_cents: 8000, plan: "max", provider: "manual", created_at: "2026-09-21T00:00:00Z", remittance: "测试付款说明", purchase_agreement: { ...agreement, accepted_at: "2026-09-21T00:00:00Z", accepted_by: "user-test" } }
const originals = { ...accountHttp }
let calls: { kind: string; payload: unknown }[] = []
let fail = false
async function mounted(action: (rerender: (next: AccountOverview) => Promise<void>) => Promise<void>, options: { missing?: boolean; renewal?: boolean; credited?: boolean; pending?: boolean; history?: boolean } = {}) {
  calls = []; fail = false
  accountHttp.accountGetPaymentMethods = async () => ({ manual: !options.credited, providers: [], purchase_agreement: options.missing ? undefined : agreement })
  accountHttp.accountListPaymentOrders = async () => options.pending ? [order] : []
  accountHttp.accountListPaymentOrderPage = async () => ({ orders: [] })
  accountHttp.accountGetPaymentOrder = async () => order
  accountHttp.accountCreatePaymentIntent = async (payload) => { calls.push({ kind: "purchase", payload }); if (fail) throw new Error("test refusal"); return order }
  accountHttp.accountCreateRenewalIntent = async (payload) => { calls.push({ kind: "renewal", payload }); if (fail) throw new Error("test refusal"); return order }
  const data = options.credited ? { ...billing, upgrade_credits: [{ tier: "max", credit_cents: 200000, lots: [] }] } : billing
  const root = createRoot(fixture)
  const render = async (next: AccountOverview) => { flushSync(() => root.render(<Toaster><PlansScreen overview={next} catalog={catalog} billingOverview={data} /></Toaster>)); await settle() }
  try {
    await render(overview)
    if (options.history) { await action(render); return }
    if (options.renewal) await click(button("续费"))
    else {
      const entries = [...fixture.querySelectorAll<HTMLButtonElement>("button")].filter((el) => !el.disabled && el.textContent?.trim() === (options.pending ? "继续支付" : "升级"))
      const entry = entries[options.pending ? 1 : 0]
      check(entry, "Upgrade entry missing"); await click(entry)
    }
    await settle(); await action(render)
  } finally { flushSync(() => root.unmount()); Object.assign(accountHttp, originals); await settle() }
}
async function readAndAccept() {
  await click(button("《采购同意书》", dialog()))
  check(dialog().textContent?.includes(agreement.content), "Agreement body missing")
  check(document.querySelectorAll('[data-slot="dialog-content"]').length === 1, "Reader must reuse purchase dialog")
  await click(button("返回购买", dialog()))
  check(!accepted(), "Reading must not consent automatically")
  await click(consent()); check(accepted(), "Consent must be explicit")
}
async function guards() {
  await mounted(async () => {
    check(consent() && !accepted() && (consent().hasAttribute("disabled") || consent().getAttribute("aria-disabled") === "true"), "Consent must start unread and disabled")
    check(submit().disabled, "Unread purchase must be disabled")
    flushSync(() => dialog().querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })))
    await settle(); check(Number(calls.length) === 0, "Programmatic submit must not bypass consent")
    await readAndAccept(); check(!submit().disabled, "Accepted purchase must enable submit")
    fail = true; await click(submit())
    check(Number(calls.length) === 1 && accepted(), "Failed attempt must retain consent")
    fail = false; await click(submit())
    check(Number(calls.length) === 2, "Retry must submit")
    const payload = calls[1]!.payload as { purchase_agreement: { version: string; accepted: boolean }; operation_id: string }
    check(payload.purchase_agreement?.version === agreement.version && payload.purchase_agreement.accepted === true, "Purchase must submit accepted version")
    check(payload.operation_id === (calls[0]!.payload as typeof payload).operation_id, "Retry must preserve operation")
    await click(button("查看本单采购同意书", dialog()))
    check(dialog().textContent?.includes(agreement.content), "Order must show frozen agreement")
    check(Number(calls.length) === 2, "Reading order receipt must not create another order")
  })
}
async function resets() {
  await mounted(async (render) => {
    await readAndAccept()
    await click(dialog().querySelector<HTMLElement>('[aria-label="增加一名成员"]')!)
    check(!accepted() && submit().disabled, "Seat edit must clear consent")
    if ((consent().hasAttribute("disabled") || consent().getAttribute("aria-disabled") === "true")) await readAndAccept(); else await click(consent())
    await click(dialog().querySelector<HTMLElement>('[aria-label="账期"] [role="radio"]')!)
    check(!accepted() && submit().disabled, "Term edit must clear consent")
    if ((consent().hasAttribute("disabled") || consent().getAttribute("aria-disabled") === "true")) await readAndAccept(); else await click(consent())
    await click(dialog().querySelector<HTMLElement>('[data-slot="dialog-close"]')!)
    for (let i = 0; i < 15 && dialog(); i++) await settle()
    const entry = [...fixture.querySelectorAll<HTMLButtonElement>("button")].find((el) => !el.disabled && el.textContent?.trim() === "升级")!
    await click(entry)
    check(!accepted() && submit().disabled, "Reopening must clear consent")
    await readAndAccept()
    await render({ ...overview, active_workspace: { ...workspace, id: 2, uuid: "550e8400-e29b-41d4-a716-446655440001" } })
    check(!dialog() || !accepted(), "Workspace switch must clear consent")
  })
}
async function alternateFlows() {
  for (const options of [{ renewal: true }, { credited: true }]) {
    await mounted(async () => {
      check(submit().disabled, "Renewal and zero-pay order must require consent")
      await readAndAccept(); await click(submit())
      check(Number(calls.length) === 1, "Accepted alternate flow must submit")
      check(calls[0]!.kind === (options.renewal ? "renewal" : "purchase"), "Wrong order endpoint")
      check((calls[0]!.payload as { purchase_agreement: { accepted: boolean } }).purchase_agreement?.accepted, "Alternate flow must include consent")
    }, options)
  }
}
async function existingOrder() {
  await mounted(async () => {
    await click(button("查看本单采购同意书", dialog()))
    check(dialog().textContent?.includes(agreement.content), "Existing order must retain agreement after publication is removed")
    await click(button("返回订单", dialog()))
    check(dialog().textContent?.includes(order.public_id), "Reader must return to existing order")
    check(!calls.length, "Existing order must not require new consent or creation")
  }, { pending: true, missing: true })
}
async function historyAfterRemount() {
  await mounted(async (render) => {
    const pages: (string | undefined)[] = []
    accountHttp.accountListPaymentOrderPage = async (filter) => {
      pages.push(filter?.cursor)
      return filter?.cursor
        ? { orders: [{ ...order, status: "paid", entry_state: "paid", public_id: "old-paid-order", purchase_agreement: { ...order.purchase_agreement!, version: "old-v0", content: "历史订单不可变正文" } }] }
        : { orders: [{ ...order, public_id: "legacy-order", purchase_agreement: undefined }], next_cursor: "older-page" }
    }
    await click(button("采购记录"))
    check(dialog().textContent?.includes("legacy-order"), "History must load old orders after remount")
    await click(button("加载更多", dialog()))
    check(pages.length === 2 && pages[1] === "older-page", "History must follow server pagination")
    check(dialog().textContent?.includes("legacy-order") && dialog().textContent?.includes("old-paid-order"), "Pagination must retain prior orders")
    await click(button("查看本单采购同意书", dialog()))
    check(dialog().textContent?.includes("历史订单不可变正文") && dialog().textContent?.includes("old-v0"), "History must use order snapshot, not current publication")
    check(document.activeElement?.getAttribute("aria-label") === "本单采购同意书正文", "Receipt should receive keyboard focus")
    await click(button("返回采购记录", dialog()))
    check(dialog().textContent?.includes("old-paid-order"), "Returning must retain paginated history")
    await render({ ...overview, active_workspace: { ...workspace, id: 2, uuid: "550e8400-e29b-41d4-a716-446655440001" } })
    check(!dialog(), "Workspace switch must discard previous workspace history")
    check(!calls.length, "Historical receipt must be read-only")
  }, { history: true, missing: true })
}
async function unavailable() { await mounted(async () => { check(submit()?.disabled, `Unpublished agreement must block checkout: ${dialog()?.textContent}`); flushSync(() => dialog().querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }))); await settle(); check(!calls.length, "Missing agreement must block direct submit") }, { missing: true }) }
run.onclick = async () => {
  run.disabled = true; requests.length = 0; const lines: string[] = []
  for (const [name, fn] of [["consent guard, retry and receipt", guards], ["selection and workspace resets", resets], ["renewal and zero-pay consent", alternateFlows], ["unpublished agreement", unavailable], ["existing order snapshot", existingOrder], ["paid history after remount and pagination", historyAfterRemount]] as const) {
    try { await fn(); lines.push(`PASS ${name}`) } catch (error) { lines.push(`FAIL ${name}: ${String(error)}`) }
    results.textContent = lines.join("\n")
  }
  if (requests.length) lines.push(`FAIL unexpected network: ${requests.join(", ")}`)
  results.textContent = lines.join("\n"); results.dataset.result = lines.some((line) => line.startsWith("FAIL")) ? "failed" : "passed"; run.disabled = false
}
if (new URLSearchParams(location.search).has("autorun")) run.click()

if (new URLSearchParams(location.search).has("preview")) void mounted(async () => { await new Promise<void>(() => {}) })

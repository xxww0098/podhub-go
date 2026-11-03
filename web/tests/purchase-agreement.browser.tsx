// Dev-only subscription interactions; every billing call is mocked.
import { flushSync } from "react-dom"
import { createRoot } from "react-dom/client"
import { accountHttp } from "@/bindings/http-account"
import { subscriptionHttp, type SubscriptionQuote, type SubscriptionRequest, type SubscriptionView } from "@/bindings/http-subscription"
import { Toaster } from "@/components/ui/toast"
import { PlansScreen } from "@/features/plans/plans-screen"
import { subscriptionFixture as view, subscriptionOverview as overview } from "./fixtures/subscription"
import "../src/index.css"

const fixture = document.querySelector<HTMLDivElement>("#fixture")!
const results = document.querySelector<HTMLPreElement>("#results")!
const run = document.querySelector<HTMLButtonElement>("#run")!
const requests: string[] = []
window.fetch = async (input) => { requests.push(String(input)); throw new Error(`Unexpected request: ${input}`) }
const frame = () => new Promise<void>((resolve) => {
  const timeout = window.setTimeout(resolve, 10)
  requestAnimationFrame(() => { window.clearTimeout(timeout); resolve() })
})
async function settle() { await frame(); await frame() }
function check(value: unknown, message: string): asserts value { if (!value) throw new Error(message) }
function button(text: string, parent: ParentNode = document) {
  const found = [...parent.querySelectorAll<HTMLButtonElement>("button")].filter((el) => (el.textContent?.trim() === text || el.getAttribute("aria-label") === text) && !el.closest('[aria-hidden="true"]'))
  check(found.length === 1, `Expected one button ${text}, got ${found.length}`)
  return found[0]!
}
async function click(el: HTMLElement) { check(!el.hasAttribute("disabled"), "Control disabled"); flushSync(() => el.click()); await settle() }
const editor = () => document.querySelector<HTMLElement>('[data-slot="subscription-editor"]')!
const originals = { ...subscriptionHttp }
const originalMethods = accountHttp.accountGetPaymentMethods
let calls: { kind: string; payload?: SubscriptionRequest; provider?: string }[] = []
const quoted = (req: SubscriptionRequest): SubscriptionQuote => ({
  quote_id: "quote-test", expires_at: "2026-11-21T03:00:00Z", revision: 1, action: req.action,
  current: { plan_key: "lite", stores: 8, members: 1, term_end: view.current_end },
  target: req.target ?? { plan_key: "lite", stores: 8 },
  amount_cents: req.action === "keep" ? 0 : req.action === "change" ? 4000 : 16000, free_only: req.action === "keep",
  breakdown: [], effective_at: view.current_end, term_end: view.term_end,
  keep_store_ids: req.keep_store_ids ?? null,
})
async function mounted(action: () => Promise<void>, quote: (req: SubscriptionRequest) => Promise<SubscriptionQuote> = async (req) => quoted(req), subscription: SubscriptionView = view) {
  calls = []
  subscriptionHttp.quote = async (req) => { calls.push({ kind: "quote", payload: req }); return quote(req) }
  subscriptionHttp.keep = async () => { calls.push({ kind: "keep" }); return view }
  subscriptionHttp.order = async (_quote, _version, provider) => { calls.push({ kind: "order", provider }); return { order_id: 1, public_id: "po_test", payment_deadline_at: "2026-11-21T03:00:00Z" } }
  subscriptionHttp.getOrder = async (public_id) => ({ public_id, status: "pending", amount_cents: 16000, reconciliation_reason: null, purchase_agreement: { ...view.purchase_agreement, accepted_at: "2026-10-21T02:00:00Z", accepted_by: "test@example.invalid" } })
  subscriptionHttp.view = async () => view
  accountHttp.accountGetPaymentMethods = async () => ({ manual: true, providers: [] })
  const root = createRoot(fixture)
  try { flushSync(() => root.render(<Toaster><PlansScreen overview={overview} subscription={subscription} /></Toaster>)); await settle(); await action() }
  finally { flushSync(() => root.unmount()); Object.assign(subscriptionHttp, originals); accountHttp.accountGetPaymentMethods = originalMethods; await settle() }
}
async function consentAndBuy(label: string) {
  const buy = button(label, editor())
  check(buy.disabled, "Paid purchase requires consent")
  const consent = editor().querySelector<HTMLElement>('[aria-label="我已阅读并同意购买确认"]')!
  check(consent.hasAttribute("disabled") || consent.getAttribute("aria-disabled") === "true", "Unread agreement must block consent")
  await click(button("阅读《订阅购买确认》", editor()))
  check(editor().textContent?.includes(view.purchase_agreement.content), "Agreement must be readable")
  await click(button("返回购买", editor()))
  await click(editor().querySelector<HTMLElement>('[aria-label="我已阅读并同意购买确认"]')!)
  await click(button(label, editor()))
}
async function keepPreviewAndConfirm() {
  await mounted(async () => {
    await click(button("修改保留名单"))
    check(editor().textContent?.includes("只需暂停 1 家"), "Only occupied excess should require suspension")
    await click(button("预览费用与生效日期", editor()))
    check(calls.length === 1 && calls[0]!.kind === "quote", "Preview must not persist configuration")
    check(calls[0]!.payload?.action === "keep" && calls[0]!.payload.period_id === 2, "Keep quotes the future period")
    check(calls[0]!.payload?.keep_store_ids?.length === 6, "Exactly six retained stores")
    check(editor().textContent?.includes("店铺 A"), "Preview should name the paused store")
    await click(button("确认保留名单", editor()))
    check(calls.some((c) => c.kind === "keep"), "Explicit confirmation should save")
  })
}
async function discard() {
  await mounted(async () => {
    await click(button("修改保留名单"))
    await click(button("预览费用与生效日期", editor()))
    await click(button("返回修改", editor()))
    check(!calls.some((c) => c.kind === "keep" || c.kind === "order"), "Back must not buy or save")
  })
}
async function checkoutDialogAndComparison() {
  await mounted(async () => {
    check(!editor(), "Visiting subscription does not open checkout")
    check(!document.querySelector('[aria-label="套餐对比"]'), "Comparison starts collapsed")
    await click(button("查看套餐对比"))
    check(Boolean(document.querySelector('[aria-label="套餐对比"]')), "Comparison opens without a purchase")
    await click(button("收起套餐对比"))
    const renew = button("续费订阅")
    renew.focus()
    await click(renew)
    check(Boolean(editor()?.closest('[role="dialog"]')), "Checkout opens as a dialog")
    await click(button("取消", editor()))
    await settle()
    check(!editor(), "Cancel closes checkout")
    check(document.activeElement?.textContent === "续费订阅", "Cancel restores focus to the purchase action")
    const change = button("本期扩容 / 升级")
    change.focus()
    await click(change)
    await click(button("取消", editor()))
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
    check(document.activeElement === change, "Cancel returns keyboard focus to the initiating action")
    check(calls.length === 0, "Viewing, cancelling, and reopening do not quote or buy")
  })
}
async function planChoicesFollowAvailableWidth() {
  await mounted(async () => {
    await click(button("续费订阅"))
    const popup = editor().closest<HTMLElement>('[role="dialog"]')!
    const previousWidth = popup.style.width
    try {
      const choices = editor().querySelector<HTMLElement>('[role="radiogroup"][aria-label="套餐"]')!
      popup.style.width = "360px"
      await settle()
      const narrow = [...choices.querySelectorAll<HTMLElement>("label")].map((item) => item.getBoundingClientRect())
      check(narrow.length === 3 && narrow[1]!.top > narrow[0]!.top, "narrow pane stacks plan choices")
      check(narrow.every((item) => item.height < 100), "Phone plan choices use compact rows")
      check(choices.scrollWidth <= choices.clientWidth + 1, "plan choices overflow the narrow pane")
      editor().scrollTop = editor().scrollHeight
      const close = popup.querySelector<HTMLElement>('[aria-label="关闭"]')!.getBoundingClientRect()
      const bounds = popup.getBoundingClientRect()
      check(close.top >= bounds.top && close.bottom <= bounds.top + 64, "The close control stays visible after scrolling to the summary")
      popup.style.width = "960px"
      editor().scrollTop = 0
      await settle()
      const wide = [...choices.querySelectorAll<HTMLElement>("label")].map((item) => item.getBoundingClientRect())
      check(Math.abs(wide[0]!.top - wide[2]!.top) < 2, "wide pane compares plans in one row")
    } finally { popup.style.width = previousWidth }
  })
}
async function pendingPreviewLocksOtherActions() {
  let finishQuote: ((quote: SubscriptionQuote) => void) | undefined
  await mounted(async () => {
    await click(button("续费订阅"))
    await click(button("预览费用与生效日期", editor()))
    const screenButtons = [...fixture.querySelectorAll<HTMLButtonElement>("button")]
    check(screenButtons.find((el) => el.textContent === "本期扩容 / 升级")?.disabled, "Another subscription action is locked while a quote is pending")
    check(screenButtons.find((el) => el.textContent === "修改保留名单")?.disabled, "A pending quote cannot be replaced by a keep-list editor")
    check(editor().querySelector<HTMLInputElement>('[aria-label="店铺数量"]')?.matches(":disabled"), "Inputs cannot change while a quote is pending")
    check(calls.length === 1 && Boolean(finishQuote), "Only one quote was sent")
    finishQuote!(quoted(calls[0]!.payload!))
    await settle()
    check(Boolean(editor().textContent?.includes("本次应付")), "The quoted configuration is shown after the request resolves")
  }, () => new Promise<SubscriptionQuote>((resolve) => { finishQuote = resolve }))
}
async function renewAsIs() {
  await mounted(async () => {
    check(document.body.textContent?.includes("按当前配置续费"), "Renewal card shows the as-is configuration")
    await click(button("续费"))
    check(!editor().textContent?.includes("缩小容量从下一个服务期生效"), "No reduction hint at the current capacity")
    await click(button("预览费用与生效日期", editor()))
    const sent = calls[0]!.payload!
    check(sent.action === "renew" && sent.target?.stores === 8 && sent.target.plan_key === "lite" && sent.months === 1, "Renew sends the current target")
    check(sent.keep_store_ids === undefined, "No keep list when live stores fit")
    await consentAndBuy("确认购买")
    check(calls.filter((c) => c.kind === "order").length === 1, "One paid order")
    check(!calls.some((c) => c.kind === "keep"), "A paid renewal cannot use the free keep route")
  })
}
async function renewSmaller() {
  await mounted(async () => {
    await click(button("续费"))
    await click(button("减少店铺数量", editor()))
    await click(button("减少店铺数量", editor()))
    check(editor().textContent?.includes("缩小容量从下一个服务期生效，当前已付容量用到期为止"), "Reduction hint shown")
    check(editor().textContent?.includes("只需暂停 1 家"), "Keep list required when live stores exceed the target")
    await click(button("预览费用与生效日期", editor()))
    const sent = calls[0]!.payload!
    check(sent.action === "renew" && sent.target?.stores === 6 && sent.keep_store_ids?.length === 6, "Reduction sends six kept stores")
  })
}
async function choosePlanAndMonths() {
  await mounted(async () => {
    await click(button("续费"))
    const plan = editor().querySelector<HTMLInputElement>('[role="radiogroup"][aria-label="套餐"] input[value="pro"]')
    const months = editor().querySelector<HTMLInputElement>('[role="radiogroup"][aria-label="购买月数"] input[value="3"]')
    check(plan?.type === "radio" && months?.type === "radio", "Plan and term use native radio controls")
    await click(plan)
    await click(months)
    check(plan.checked && months.checked, "Plan and term selections update")
    check(editor().querySelector('[aria-label="¥600.00"]'), "Order summary immediately estimates the selected plan and term")
    await click(button("预览费用与生效日期", editor()))
    check(calls[0]?.payload?.target?.plan_key === "pro" && calls[0]?.payload?.months === 3, "Quote uses selected plan and term")
    check(!calls.some((c) => c.kind === "order"), "Selecting and previewing does not buy")
    check(editor().querySelector('[aria-label="¥160.00"]'), "The server quote replaces the local estimate")
    await click(button("增加店铺数量", editor()))
    check(!editor().textContent?.includes("本次应付"), "Changing configuration invalidates the previous quote")
    check(editor().querySelector('[aria-label="¥675.00"]'), "The estimate follows the edited store count")
  })
}
async function offeredPlansOnly() {
  const free = { ...view, status: "free" as const, plan_key: "free", plans: view.plans.filter((plan) => plan.key !== "lite"), periods: [], current_end: null, term_end: null }
  await mounted(async () => {
    await click(button("购买套餐"))
    check(editor().querySelector<HTMLInputElement>('input[value="pro"]')?.checked, "The first offered paid plan is selected")
    check(!button("预览费用与生效日期", editor()).disabled, "An offered paid plan can be previewed")
  }, undefined, free)
  await mounted(async () => {
    await click(button("购买套餐"))
    check(editor().textContent?.includes("暂无可用付费套餐"), "Missing paid plans are explained")
    check(button("预览费用与生效日期", editor()).disabled, "A missing paid plan cannot be quoted")
  }, undefined, { ...free, plans: [] })
}
async function paymentMethodsRecoverAndSelect() {
  await mounted(async () => {
    let reads = 0
    accountHttp.accountGetPaymentMethods = async () => {
      if (reads++ === 0) throw new Error("渠道读取失败")
      return { manual: false, providers: ["alipay", "wechat"] }
    }
    await click(button("续费订阅"))
    check(editor().textContent?.includes("支付方式未能读取"), "Payment method failures remain retryable")
    await click(button("重试", editor()))
    const wechat = editor().querySelector<HTMLInputElement>('[aria-label="支付渠道"] input[value="wechat"]')!
    await click(wechat)
    check(wechat.checked, "A configured payment channel can be selected")
    await click(button("预览费用与生效日期", editor()))
    await consentAndBuy("确认购买")
    check(calls.find((call) => call.kind === "order")?.provider === "wechat", "The order receives the selected payment channel")
  })
}
async function annualAndCoupon() {
  await mounted(async () => {
    await click(button("续费订阅"))
    await click(editor().querySelector<HTMLInputElement>('[aria-label="套餐"] input[value="max"]')!)
    await click(editor().querySelector<HTMLInputElement>('[aria-label="购买月数"] input[value="12"]')!)
    await click(button("增加店铺数量", editor()))
    await click(button("增加店铺数量", editor()))
    check(editor().querySelector('[aria-label="¥2,880.00"]'), "Annual estimate applies 20% off before a coupon")
    await click(button("添加优惠码", editor()))
    const input = editor().querySelector<HTMLInputElement>('[aria-label="优惠码"]')!
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!
    flushSync(() => { setter.call(input, "team10"); input.dispatchEvent(new Event("input", { bubbles: true })) })
    await settle()
    await click(button("应用", editor()))
    check(calls[0]?.payload?.coupon_code === "team10", "The coupon is sent to the server with the quote intent")
    check(editor().querySelector('[aria-label="¥2,592.00"]'), "The accepted server quote combines annual and coupon discounts")
    check(editor().textContent?.includes("减免 10%"), "The validated coupon is displayed")
    await click(button("移除优惠码 TEAM10", editor()))
    check(!editor().textContent?.includes("本次应付"), "Removing a coupon invalidates the quoted order")
    check(editor().querySelector('[aria-label="¥2,880.00"]'), "Removing a coupon restores the annual estimate")
    check(!calls.some((call) => call.kind === "order"), "Applying and removing coupons never places an order")
  }, async (req) => ({ ...quoted(req), amount_cents: 259200, coupon: { code: "TEAM10", discount_percent: 10, discount_cents: 28800 }, breakdown: [{ label: "订阅费用", cents: 360000 }, { label: "年付 8 折", cents: -72000 }, { label: "优惠码 TEAM10", cents: -28800 }] }))
}
async function changeNothing() {
  await mounted(async () => {
    await click(button("本期扩容 / 升级"))
    check(button("减少店铺数量", editor()).disabled, "Change cannot go below the running capacity")
    await click(button("预览费用与生效日期", editor()))
    check(editor().textContent?.includes("目标容量不高于已付容量"), "Server refusal is shown inline")
    check(!calls.some((c) => c.kind === "order"), "A refused change buys nothing")
  }, async () => { throw Object.assign(new Error("目标容量不高于已付容量，无需变更；减少容量请在续费时选择"), { code: "NOTHING_TO_CHANGE", status: 409 }) })
}
run.onclick = async () => {
  run.disabled = true; requests.length = 0; const lines: string[] = []
  for (const [name, fn] of [["checkout dialog and comparison", checkoutDialogAndComparison], ["plan choices follow available width", planChoicesFollowAvailableWidth], ["pending preview locks other actions", pendingPreviewLocksOtherActions], ["keep preview then explicit confirmation", keepPreviewAndConfirm], ["discard preview", discard], ["renew as is and consent", renewAsIs], ["renew smaller needs keep list", renewSmaller], ["choose plan and term", choosePlanAndMonths], ["only offered plans can be quoted", offeredPlansOnly], ["payment methods recover and select", paymentMethodsRecoverAndSelect], ["annual and coupon discount", annualAndCoupon], ["change that raises nothing is refused", changeNothing]] as const) {
    try { await fn(); lines.push(`PASS ${name}`) } catch (error) { lines.push(`FAIL ${name}: ${String(error)}`) }
    results.textContent = lines.join("\n")
  }
  if (requests.length) lines.push(`FAIL unexpected network: ${requests.join(", ")}`)
  results.textContent = lines.join("\n"); results.dataset.result = lines.some((line) => line.startsWith("FAIL")) ? "failed" : "passed"; run.disabled = false
}
if (new URLSearchParams(location.search).has("autorun")) run.click()

if (new URLSearchParams(location.search).has("preview")) {
  accountHttp.accountGetPaymentMethods = async () => ({ manual: false, providers: ["alipay", "wechat", "stripe"] })
  subscriptionHttp.quote = async (req) => {
    const base = (view.plans.find((plan) => plan.key === req.target?.plan_key)?.store_monthly_cents ?? 0) * (req.target?.stores ?? 0) * (req.months ?? 1)
    const annual = req.months === 12 ? Math.round(base * .8) : base
    const code = req.coupon_code?.trim().toUpperCase()
    if (code && code !== "TEAM10") throw new Error("优惠码无效、已过期或次数已用完")
    const amount = code ? Math.round(annual * .9) : annual
    const offer = quoted(req)
    if (req.action === "subscribe" || req.action === "renew") {
      const end = new Date(view.term_end!)
      end.setUTCMonth(end.getUTCMonth() + (req.months ?? 1))
      offer.effective_at = view.term_end
      offer.term_end = end.toISOString()
    }
    return { ...offer, amount_cents: req.action === "keep" ? 0 : amount, breakdown: [{ label: "订阅费用", cents: base }, ...(base !== annual ? [{ label: "年付 8 折", cents: annual - base }] : []), ...(code ? [{ label: "优惠码 TEAM10", cents: amount - annual }] : [])], ...(code ? { coupon: { code, discount_percent: 10, discount_cents: annual - amount } } : {}) }
  }
  const root = createRoot(fixture)
  root.render(<Toaster><PlansScreen overview={overview} subscription={view} /></Toaster>)
}

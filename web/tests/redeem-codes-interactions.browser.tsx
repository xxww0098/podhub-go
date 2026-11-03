import { flushSync } from "react-dom"
import { createRoot } from "react-dom/client"
import type { components } from "@/api/schema"
import type { AdminRedeemCodeView, AdminRedeemCodesOverview } from "@/bindings/commands"
import { adminHttp } from "@/bindings/http-admin"
import { RedeemCodesScreen } from "@/features/redeem-codes/redeem-codes-screen"
import { formatDateTimeShort } from "@/lib/format"
import "../src/index.css"

const fixture = document.querySelector<HTMLDivElement>("#fixture")!
const results = document.querySelector<HTMLPreElement>("#results")!
const run = document.querySelector<HTMLButtonElement>("#run")!
const frame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
function check(value: unknown, message: string): asserts value { if (!value) throw new Error(message) }

run.onclick = async () => {
  run.disabled = true
  delete results.dataset.result
  const original = { list: adminHttp.adminListRedeemCodes, create: adminHttp.adminCreateRedeemCodes, remove: adminHttp.adminDeleteRedeemCode, coupons: adminHttp.adminListSubscriptionCoupons, createCoupon: adminHttp.adminCreateSubscriptionCoupon, toggleCoupon: adminHttp.adminSetSubscriptionCouponEnabled, fetch: window.fetch }
  const root = createRoot(fixture)
  let codes: AdminRedeemCodeView[] = Array.from({ length: 12 }, (_, index) => ({
    id: index + 1,
    code_preview: `****${String(index + 1).padStart(4, "0")}`,
    wallet_cents: index === 11 ? 12345 : 10000,
    status: index === 1 ? "redeemed" : index === 2 ? "future_status" : index === 3 ? "expired" : "unused",
    created_at: "2026-10-01T00:00:00Z",
    used_at: index === 1 ? "2026-10-23T00:00:00Z" : null,
    note: `活动${index + 1}`,
    batch_id: "fixture-batch",
  } as AdminRedeemCodeView))
  let deletes = 0
  let reads = 0
  let holdNextRead = false
  let finishOldRead: ((result: AdminRedeemCodesOverview) => void) | undefined
  const settle = async (predicate: () => boolean, message: string) => {
    const deadline = performance.now() + 5000
    while (!predicate()) { check(performance.now() < deadline, message); await frame() }
  }
  const button = (label: string) => [...document.querySelectorAll<HTMLButtonElement>("button")].find((item) => item.textContent?.trim() === label)
  const setInput = (element: HTMLInputElement, value: string) => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(element, value)
    element.dispatchEvent(new Event("input", { bubbles: true }))
  }
  const openDelete = async (preview: string) => {
    fixture.querySelector<HTMLButtonElement>(`[aria-label="${preview} 的更多操作"]`)!.click()
    await settle(() => !!document.querySelector(`[aria-label="删除 ${preview}"]`), "delete menu did not open")
    document.querySelector<HTMLElement>(`[aria-label="删除 ${preview}"]`)!.click()
  }
  try {
    // Mock every request: this fixture must never touch the real ledger.
    window.fetch = async () => { throw new Error("unexpected network request") }
    adminHttp.adminListRedeemCodes = async () => {
      if (++reads === 1) throw new Error("fixture read failed")
      const overview = {
        codes,
        total: codes.length,
        unused: codes.filter((code) => code.status === "unused").length,
        redeemed: codes.filter((code) => code.status === "redeemed").length,
        expired: codes.filter((code) => code.status === "expired").length,
        revoked: 0,
      }
      if (holdNextRead) {
        holdNextRead = false
        return await new Promise<AdminRedeemCodesOverview>((resolve) => { finishOldRead = resolve })
      }
      return overview
    }
    adminHttp.adminCreateRedeemCodes = async () => ({ codes: [] })
    adminHttp.adminDeleteRedeemCode = async (id) => {
      if (++deletes === 1) throw new Error("fixture delete failed")
      codes = codes.filter((code) => code.id !== id)
    }
    flushSync(() => root.render(<RedeemCodesScreen />))
    await settle(() => !!button("重试"), "failed load did not offer retry")
    check(!fixture.textContent?.includes("还没有兑换码") && !fixture.querySelector('[aria-label="筛选全部，0 个"]'), "failed load was presented as an empty ledger")
    button("重试")!.click()
    await settle(() => !!fixture.querySelector('[aria-label="查看 ****0001 详情"]'), "ledger did not load")
    holdNextRead = true
    fixture.querySelector<HTMLButtonElement>('[aria-label="刷新"]')!.click()
    await settle(() => !!finishOldRead, "refresh did not start")
    fixture.querySelector<HTMLButtonElement>('[aria-label="创建兑换码"]')!.click()
    await settle(() => !!button("生成兑换码"), "create form did not open")
    button("生成兑换码")!.click()
    await settle(() => !!button("不保存，直接关闭") && reads >= 4, "create did not trigger a newer read")
    finishOldRead!({
      codes: codes.map((code) => ({ ...code, note: "过期结果" })),
      total: codes.length, unused: 9, redeemed: 1, expired: 1, revoked: 0,
    })
    await frame()
    await frame()
    button("不保存，直接关闭")!.click()
    await settle(() => !document.body.textContent?.includes("完整兑换码"), "created result did not close")
    check(fixture.textContent?.includes("活动1") && !fixture.textContent?.includes("过期结果"), "older refresh overwrote a newer ledger")
    check(!fixture.textContent?.includes("****0011"), "first page exceeded ten rows")
    check(fixture.textContent?.includes("共 12 条") && fixture.querySelector('[aria-label="每页兑换码数"]')?.textContent?.includes("10 条"), "pagination count is wrong")
    const firstRow = fixture.querySelector('[aria-label="查看 ****0001 详情"]')!.closest("tr")!
    check(firstRow.querySelector('button[aria-label="复制 ****0001"]'), "copy action did not identify the first code")
    check(firstRow.querySelector('[data-tone="idle"].bg-st-good-soft')?.textContent?.includes("未使用"), "unused status lost its semantic tone or available color")
    const unknownRow = fixture.querySelector('[aria-label="查看 ****0003 详情"]')!.closest("tr")!
    check(unknownRow.querySelector('[data-tone="unknown"]')?.textContent?.includes("未知"), "unknown status was presented as unused")
    check(!unknownRow.querySelector('[aria-label="删除 ****0003"]'), "unknown status exposed delete")
    const expiredRow = fixture.querySelector('[aria-label="查看 ****0004 详情"]')!.closest("tr")!
    check(expiredRow.querySelector('[data-tone="idle"]')?.textContent?.includes("已过期"), "known expiration was shown as unknown")
    const redeemedRow = fixture.querySelector('[aria-label="查看 ****0002 详情"]')!.closest("tr")!
    check(redeemedRow.querySelector('button[aria-label="复制 ****0002"]'), "copy action did not identify the redeemed code")
    check(redeemedRow.textContent?.includes(formatDateTimeShort("2026-10-01T00:00:00Z")), "created column showed redemption date")
    check(redeemedRow.querySelector('[data-tone="good"].bg-st-flight-soft')?.textContent?.includes("已兑换"), "redeemed status lost its semantic tone or blue color")
    check(!redeemedRow.querySelector('[aria-label="删除 ****0002"]'), "redeemed code exposed delete")

    const pageSize = fixture.querySelector<HTMLButtonElement>('[aria-label="每页兑换码数"]')!
    pageSize.click()
    await settle(() => !!document.querySelector('[role="option"]'), "page-size choices did not open")
    const twenty = [...document.querySelectorAll<HTMLElement>('[role="option"]')].find((item) => item.textContent?.trim() === "20 条")
    check(twenty, "20-row page size was missing")
    twenty.click()
    await settle(() => !!fixture.querySelector('[aria-label="查看 ****0012 详情"]'), "20-row page size did not expose all rows")
    pageSize.click()
    await settle(() => !!document.querySelector('[role="option"]'), "page-size choices did not reopen")
    const ten = [...document.querySelectorAll<HTMLElement>('[role="option"]')].find((item) => item.textContent?.trim() === "10 条")
    check(ten, "10-row page size was missing")
    ten.click()
    await settle(() => !fixture.querySelector('[aria-label="查看 ****0011 详情"]'), "10-row page size did not restore pagination")

    button("下一页")!.click()
    await settle(() => !!fixture.querySelector('[aria-label="查看 ****0011 详情"]'), "next page did not show later rows")
    fixture.querySelector<HTMLButtonElement>('[aria-label="选择本页全部兑换码"]')!.click()
    await settle(() => !!fixture.textContent?.includes("已选 2 个"), "page selection did not select the two visible rows")
    button("上一页")!.click()
    await settle(() => !!fixture.querySelector('[aria-label="查看 ****0001 详情"]'), "previous page did not return")
    check(fixture.textContent?.includes("已选 2 个"), "selection was lost across pages")
    fixture.querySelector<HTMLButtonElement>('[aria-label="清除选择"]')!.click()
    await settle(() => !fixture.textContent?.includes("已选 2 个"), "selection did not clear")

    const search = fixture.querySelector<HTMLInputElement>('[aria-label="搜索兑换码"]')!
    setInput(search, "123.45")
    await settle(() => !!fixture.querySelector('[aria-label="查看 ****0012 详情"]'), "displayed amount could not be searched")
    check(!fixture.querySelector('[aria-label="查看 ****0001 详情"]'), "search did not narrow rows")
    fixture.querySelector<HTMLButtonElement>('[aria-label="清空搜索"]')!.click()
    await settle(() => !!fixture.querySelector('[aria-label="查看 ****0001 详情"]'), "clear did not restore rows")
    fixture.querySelector<HTMLButtonElement>('[aria-label="筛选已兑换，1 个"]')!.click()
    await settle(() => !!fixture.querySelector('[aria-label="查看 ****0002 详情"]') && !fixture.querySelector('[aria-label="查看 ****0001 详情"]'), "status filter did not narrow rows")
    fixture.querySelector<HTMLButtonElement>('[aria-label="筛选全部，12 个"]')!.click()
    await settle(() => !!fixture.querySelector('[aria-label="查看 ****0001 详情"]'), "all filter did not restore rows")

    fixture.querySelector<HTMLButtonElement>('[aria-label="查看 ****0001 详情"]')!.click()
    await settle(() => !!document.body.textContent?.includes("兑换码详情"), "detail did not open")
    check(document.body.textContent?.includes("活动1") && document.body.textContent?.includes("fixture-batch"), "detail omitted ledger fields")
    document.querySelector<HTMLButtonElement>('[aria-label="关闭"]')!.click()
    await settle(() => !document.body.textContent?.includes("兑换码详情"), "detail did not close")
    await openDelete("****0001")
    await settle(() => !!document.body.textContent?.includes("删除兑换码？"), "delete confirmation did not open")
    check(deletes === 0, "delete ran before confirmation")
    button("取消")!.click()
    await settle(() => !document.body.textContent?.includes("删除兑换码？"), "cancel did not close confirmation")
    check(deletes === 0, "cancel deleted the code")
    await openDelete("****0001")
    await settle(() => !!button("删除兑换码"), "delete confirmation did not reopen")
    button("删除兑换码")!.click()
    await settle(() => deletes === 1 && !!button("删除兑换码") && !button("删除兑换码")!.disabled, "failed delete did not remain retryable")
    await frame()
    check(!!fixture.querySelector('[aria-label="查看 ****0001 详情"]'), "failed delete removed the row")
    button("删除兑换码")!.click()
    await settle(() => deletes === 2 && !fixture.querySelector('[aria-label="查看 ****0001 详情"]'), "mock deletion did not refresh the ledger")
    codes = []
    fixture.querySelector<HTMLButtonElement>('[aria-label="刷新"]')!.click()
    await settle(() => !!fixture.textContent?.includes("还没有兑换码"), "empty ledger did not appear")
    check(fixture.textContent?.includes("兑换码尾号") && fixture.textContent?.includes("共 0 条"), "empty ledger hid its column headings or pagination")
    check(fixture.querySelector('[aria-label="选择本页全部兑换码"]')?.getAttribute("aria-disabled") === "true", "empty ledger allowed selecting nonexistent codes")
    codes = [{ id: 88, code_preview: "****WAL1", wallet_cents: 10000, status: "unused", created_at: new Date().toISOString() }]
    const planRequests: components["schemas"]["AdminRedeemCodeCreateRequest"][] = []
    adminHttp.adminCreateRedeemCodes = async (request) => {
      planRequests.push(request)
      codes = [...codes, { id: 89, code_preview: "****PLAN", wallet_cents: 0, plan_key: request.plan_key, plan_stores: request.plan_stores, plan_months: request.plan_months, status: "unused", created_at: new Date().toISOString() }]
      return { codes: [{ id: 89, code: "POD-PLAN-TEST", wallet_cents: 0, plan_key: request.plan_key, plan_stores: request.plan_stores, plan_months: request.plan_months, batch_id: "plan-batch", expires_at: request.expires_at! }] }
    }
    ;[...fixture.querySelectorAll<HTMLElement>('[role="tab"]')].find((item) => item.textContent === "套餐兑换码")!.click()
    await settle(() => !!fixture.textContent?.includes("创建一批兑换码，交付后可兑换套餐"), "plan tab did not show its empty state")
    await settle(() => fixture.querySelectorAll('[aria-label="创建兑换码"]').length === 1, "previous ledger did not close")
    check(!fixture.textContent?.includes("****WAL1"), "plan ledger included wallet codes")
    fixture.querySelector<HTMLButtonElement>('[aria-label="创建兑换码"]')!.click()
    await settle(() => !!document.querySelector("#redeem-plan"), "plan form did not open")
    document.querySelector<HTMLButtonElement>("#redeem-plan")!.click()
    await settle(() => !![...document.querySelectorAll('[role="option"]')].find((item) => item.textContent?.includes("专业版")), "plan options did not open")
    ;[...document.querySelectorAll<HTMLElement>('[role="option"]')].find((item) => item.textContent?.includes("专业版"))!.click()
    setInput(document.querySelector<HTMLInputElement>("#redeem-stores")!, "3")
    document.querySelector<HTMLButtonElement>("#redeem-months")!.click()
    await settle(() => !![...document.querySelectorAll('[role="option"]')].find((item) => item.textContent?.includes("3 个月")), "duration options did not open")
    ;[...document.querySelectorAll<HTMLElement>('[role="option"]')].find((item) => item.textContent?.includes("3 个月"))!.click()
    await settle(() => !!document.querySelector("#redeem-months")?.textContent?.includes("3 个月"), "selected duration did not update")
    button("生成兑换码")!.click()
    await settle(() => !!document.body.textContent?.includes("POD-PLAN-TEST"), "plan code was not displayed")
    check(planRequests[0]?.plan_key === "pro" && planRequests[0]?.plan_stores === 3 && planRequests[0]?.plan_months === 3 && planRequests[0]?.wallet_cents === undefined, `plan grant was sent incorrectly: ${JSON.stringify(planRequests[0])}`)
    check(document.body.textContent?.includes("专业版 · 3 家店铺 · 3 个月"), "created plan grant was not displayed")
    button("不保存，直接关闭")!.click()
    await settle(() => !!fixture.textContent?.includes("****PLAN"), "created plan was missing from ledger")
    check(fixture.textContent?.includes("专业版") && !fixture.textContent?.includes("****WAL1"), "plan ledger was not separated from wallet codes")
    ;[...fixture.querySelectorAll<HTMLElement>('[role="tab"]')].find((item) => item.textContent === "钱包兑换码")!.click()
    await settle(() => !!fixture.textContent?.includes("****WAL1"), "wallet ledger did not reload")
    check(!fixture.textContent?.includes("****PLAN"), "wallet ledger included plan codes")
    type Coupon = components["schemas"]["AdminSubscriptionCoupon"]
    type CouponRequest = components["schemas"]["AdminSubscriptionCouponCreate"]
    const now = Date.now()
    let coupons: Coupon[] = [{ code: "WINDOW10", discount_percent: 10, max_uses: 5, used_count: 0, enabled: true, created_at: new Date(now).toISOString(), starts_at: new Date(now + 2000).toISOString(), expires_at: new Date(now + 5000).toISOString() }]
    const createdRequests: CouponRequest[] = []
    let creates = 0
    adminHttp.adminListSubscriptionCoupons = async () => ({ coupons })
    adminHttp.adminCreateSubscriptionCoupon = async (request) => {
      if (++creates === 1) throw new Error("优惠码已存在")
      createdRequests.push(request)
      const coupon: Coupon = { ...request, used_count: 0, enabled: true, created_at: new Date().toISOString() }
      coupons = [coupon, ...coupons]
      return coupon
    }
    adminHttp.adminSetSubscriptionCouponEnabled = async (code, enabled) => {
      const coupon = { ...coupons.find((item) => item.code === code)!, enabled }
      coupons = coupons.map((item) => item.code === code ? coupon : item)
      return coupon
    }
    const couponTab = [...fixture.querySelectorAll<HTMLElement>('[role="tab"]')].find((item) => item.textContent === "订阅优惠码")!
    couponTab.click()
    const couponRow = (code: string) => [...fixture.querySelectorAll<HTMLTableRowElement>('table[aria-label="订阅优惠码"] tbody tr')].find((row) => row.textContent?.includes(code))
    await settle(() => !!couponRow("WINDOW10")?.textContent?.includes("未开始"), "scheduled coupon was available before its start")
    await settle(() => !!couponRow("WINDOW10")?.textContent?.includes("可用"), "coupon did not become available at its start")
    await settle(() => !!couponRow("WINDOW10")?.textContent?.includes("已结束"), "coupon did not end automatically")
    button("生成优惠码")!.click()
    await settle(() => !!document.querySelector<HTMLInputElement>("#coupon-code")?.value, "opening generation did not produce a code")
    const codeInput = document.querySelector<HTMLInputElement>("#coupon-code")!
    const firstCode = codeInput.value
    check(/^SALE-[A-F0-9]{12}$/.test(firstCode), "generated code did not match its accepted format")
    button("重新生成")!.click()
    await settle(() => codeInput.value !== firstCode && /^SALE-[A-F0-9]{12}$/.test(codeInput.value), "regeneration did not replace the code")
    const code = codeInput.value
    const startInput = document.querySelector<HTMLInputElement>("#coupon-starts")!
    const endInput = document.querySelector<HTMLInputElement>("#coupon-expires")!
    setInput(startInput, "2099-01-02T09:30")
    setInput(endInput, "2099-01-01T18:45")
    setInput(document.querySelector<HTMLInputElement>("#coupon-percent")!, "15")
    setInput(document.querySelector<HTMLInputElement>("#coupon-uses")!, "25")
    codeInput.form!.requestSubmit()
    await settle(() => !!document.body.textContent?.includes("结束时间须晚于开始时间"), "invalid window had no error")
    check(creates === 0, "invalid window reached the API")
    setInput(endInput, "2099-01-02T18:45")
    codeInput.form!.requestSubmit()
    await settle(() => !!document.body.textContent?.includes("优惠码已存在"), "failed creation did not remain retryable")
    check(codeInput.value === code && startInput.value === "2099-01-02T09:30" && endInput.value === "2099-01-02T18:45", "failed creation lost the generated code or schedule")
    codeInput.form!.requestSubmit()
    await settle(() => !!couponRow(code) && !document.querySelector('[role="dialog"]'), "created coupon did not appear in the list")
    const created = createdRequests.at(-1)
    check(created?.starts_at === "2099-01-02T01:30:00.000Z" && created.expires_at === "2099-01-02T10:45:00.000Z" && created.discount_percent === 15 && created.max_uses === 25, "form did not preserve the Beijing window, percent or use cap")
    check(couponRow(code)?.textContent?.includes("未开始"), "future coupon was presented as available")
    couponRow(code)!.querySelector<HTMLButtonElement>(`[aria-label="停用优惠码 ${code}"]`)!.click()
    await settle(() => !!couponRow(code)?.textContent?.includes("已停用"), "disable did not update the coupon")
    couponRow(code)!.querySelector<HTMLButtonElement>(`[aria-label="启用优惠码 ${code}"]`)!.click()
    await settle(() => !!couponRow(code)?.textContent?.includes("未开始"), "enabling bypassed the scheduled start")
    button("生成优惠码")!.click()
    await settle(() => !!document.querySelector<HTMLInputElement>("#coupon-code")?.value, "new coupon form did not open")
    const unlimitedCode = document.querySelector<HTMLInputElement>("#coupon-code")!.value
    const usesInput = document.querySelector<HTMLInputElement>("#coupon-uses")!
    setInput(usesInput, "17")
    await frame()
    const unlimitedButton = document.querySelector<HTMLButtonElement>('button[aria-label="不限次数"]')!
    unlimitedButton.click()
    await settle(() => unlimitedButton.getAttribute("aria-pressed") === "true" && usesInput.value === "不限次数" && usesInput.readOnly, "unlimited choice did not replace the use cap")
    unlimitedButton.click()
    await settle(() => unlimitedButton.getAttribute("aria-pressed") === "false" && usesInput.value === "17" && usesInput.type === "number", "switching back lost the configured use cap")
    unlimitedButton.click()
    await settle(() => unlimitedButton.getAttribute("aria-pressed") === "true", "unlimited choice did not reactivate")
    usesInput.form!.requestSubmit()
    await settle(() => !!couponRow(unlimitedCode) && !document.querySelector('[role="dialog"]'), "unlimited coupon did not save")
    check(createdRequests.at(-1)?.max_uses === 0, "unlimited choice did not reach the API")
    check(couponRow(unlimitedCode)?.textContent?.includes("可用") && couponRow(unlimitedCode)?.querySelector('svg[aria-label="不限次数"]'), "unlimited coupon was exhausted or did not show infinity")
    results.textContent = "PASS: wallet and plan ledgers, plan creation, wallet failure/retry, pagination, selection, status, search, detail, deletion; coupon generation, validation, schedule and unlimited use"
    results.dataset.result = "pass"
  } catch (reason) {
    results.textContent = `FAIL: ${reason instanceof Error ? reason.message : String(reason)} (deletes=${deletes}, codes=${codes.length}, first row=${!!fixture.querySelector('[aria-label="查看 ****0001 详情"]')})`
    results.dataset.result = "fail"
  } finally {
    flushSync(() => root.unmount())
    adminHttp.adminListRedeemCodes = original.list
    adminHttp.adminCreateRedeemCodes = original.create
    adminHttp.adminDeleteRedeemCode = original.remove
    adminHttp.adminListSubscriptionCoupons = original.coupons
    adminHttp.adminCreateSubscriptionCoupon = original.createCoupon
    adminHttp.adminSetSubscriptionCouponEnabled = original.toggleCoupon
    window.fetch = original.fetch
    run.disabled = false
  }
}

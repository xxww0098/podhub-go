import { flushSync } from "react-dom"
import { createRoot } from "react-dom/client"
import type { AdminAgentView, AdminAgentsOverview } from "@/bindings/commands"
import { adminHttp } from "@/bindings/http-admin"
import { Toaster } from "@/components/ui/toast"
import { AgentsScreen } from "@/features/agents/agents-screen"
import "../src/index.css"

const fixture = document.querySelector<HTMLDivElement>("#fixture")!
const results = document.querySelector<HTMLPreElement>("#results")!
const run = document.querySelector<HTMLButtonElement>("#run")!
const names = ["张磊", "王婷", "李浩", "陈晨", "黄莹", "赵明", "孙娜", "高峰", "马超", "刘洋", "新代理", "另一个代理"]
let rows: AdminAgentView[] = names.map((name, index) => ({
  user_uuid: `fixture-${index + 1}`, name, email: `agent${index + 1}@example.invalid`,
  invite_code: `TEST${String(index + 1).padStart(4, "0")}`, status: index === 6 ? "disabled" : index === 9 ? "future" : "active",
  created_at: "2026-10-01T00:00:00Z", payout_account: index % 3 === 0 ? { channel: "alipay", account: `mock-${index}`, real_name: name } : null,
  wallet_balance_cents: index * 100, wallet_held_cents: 0, invitee_count: index, credited_count: index, skipped_count: 0, credited_total_cents: index * 100,
}))
const overview = (agents: AdminAgentView[]): AdminAgentsOverview => ({ agents, default_rebate_bps: 1000, min_order_cents: 10000, attribution_validity_days: 365, min_withdraw_cents: 10000 })
const frame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
function check(value: unknown, message: string): asserts value { if (!value) throw new Error(message) }
async function settle(predicate: () => boolean, message: string) {
  const deadline = performance.now() + 3000
  while (!predicate()) { check(performance.now() < deadline, message); await frame() }
}
function inputValue(element: HTMLInputElement, value: string) {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(element, value)
  element.dispatchEvent(new Event("input", { bubbles: true }))
}

const original = { list: adminHttp.adminListAgents, commissions: adminHttp.adminListAgentCommissions, withdrawals: adminHttp.adminListAgentWithdrawals, create: adminHttp.adminCreateAgent, update: adminHttp.adminUpdateAgent, fetch: window.fetch }
const clipboardDescriptor = Object.getOwnPropertyDescriptor(navigator, "clipboard")
let copied = ""
let holdOld: ((value: AdminAgentsOverview) => void) | undefined
let writes = 0
let reads = 0

function installFixture() {
  // The isolated page blocks every unmocked request and never touches user data.
  window.fetch = async () => { throw new Error("unexpected network request") }
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: async (value: string) => { copied = value } } })
  adminHttp.adminListAgents = async (filters = {}) => {
    reads += 1
    if (filters.query === "old") return await new Promise<AdminAgentsOverview>((resolve) => { holdOld = resolve })
    if (filters.query === "new") return overview([{ ...rows[0], name: "最新结果", email: "new@example.invalid" }])
    const query = filters.query?.toLowerCase() ?? ""
    return overview(rows.filter((row) => (!query || [row.name, row.email, row.invite_code].some((text) => text.toLowerCase().includes(query))) && (!filters.flagged || row.review_flagged_at)))
  }
  adminHttp.adminListAgentCommissions = async () => ({ commissions: [], total: 0, page: 1, page_size: 50 })
  adminHttp.adminListAgentWithdrawals = async () => []
  adminHttp.adminCreateAgent = async ({ email }) => {
    writes += 1
    const row = { ...rows[0], user_uuid: "created", email, name: "新建代理", invite_code: "CREATED1" }
    rows = [row, ...rows]
    return row
  }
  adminHttp.adminUpdateAgent = async (id, request) => {
    writes += 1
    rows = rows.map((row) => row.user_uuid === id ? { ...row, status: request.status, invite_code: request.invite_code ?? row.invite_code } : row)
    return rows.find((row) => row.user_uuid === id)!
  }
}
function restoreFixture() {
  adminHttp.adminListAgents = original.list
  adminHttp.adminListAgentCommissions = original.commissions
  adminHttp.adminListAgentWithdrawals = original.withdrawals
  adminHttp.adminCreateAgent = original.create
  adminHttp.adminUpdateAgent = original.update
  window.fetch = original.fetch
  if (clipboardDescriptor) Object.defineProperty(navigator, "clipboard", clipboardDescriptor)
  else Reflect.deleteProperty(navigator, "clipboard")
}

installFixture()
const root = createRoot(fixture)
if (new URLSearchParams(location.search).has("visual")) {
  run.hidden = true
  results.hidden = true
  fixture.style.cssText = "width:min(900px,100%);height:100vh;margin:0 auto;display:flex;overflow:hidden"
  root.render(<Toaster><AgentsScreen /></Toaster>)
} else {
  run.onclick = async () => {
    run.disabled = true
    delete results.dataset.result
    try {
      flushSync(() => root.render(<Toaster><AgentsScreen /></Toaster>))
      await settle(() => !!fixture.querySelector('[aria-label="编辑 agent1@example.invalid"]'), "代理列表未加载")
      check(!fixture.querySelector('[aria-label="编辑 agent11@example.invalid"]'), "首页超过 10 条")
      check(fixture.querySelector<HTMLButtonElement>('[aria-label="编辑 agent10@example.invalid"]')?.disabled, "未知状态不能直接编辑")
      fixture.querySelector<HTMLButtonElement>('[aria-label="选择 agent1@example.invalid"]')!.click()
      await settle(() => !!fixture.textContent?.includes("本页已选 1 个"), "单行选择未生效")
      ;[...fixture.querySelectorAll<HTMLButtonElement>("button")].find((item) => item.textContent?.trim() === "复制邮箱")!.click()
      await settle(() => copied === "agent1@example.invalid", "复制内容不是选中邮箱")
      fixture.querySelector<HTMLButtonElement>('[aria-label="选择本页全部代理"]')!.click()
      await settle(() => !!fixture.textContent?.includes("本页已选 10 个"), "本页全选未生效")
      fixture.querySelector<HTMLButtonElement>('[aria-label="下一页代理"]')!.click()
      await settle(() => !!fixture.querySelector('[aria-label="编辑 agent11@example.invalid"]'), "下一页未显示")
      check(!fixture.textContent?.includes("本页已选"), "翻页后保留了旧选择")
      fixture.querySelector<HTMLButtonElement>('[aria-label="上一页代理"]')!.click()
      await settle(() => !!fixture.querySelector('[aria-label="编辑 agent1@example.invalid"]'), "上一页未返回")
      fixture.querySelector<HTMLButtonElement>('[aria-label="更多操作 agent1@example.invalid"]')!.click()
      await settle(() => !!document.body.textContent?.includes("累计佣金"), "更多操作未显示佣金信息")
      check(document.body.textContent?.includes("收款账号 mock-0"), "收款账号详情丢失")
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }))

      const search = fixture.querySelector<HTMLInputElement>('input[aria-label="搜索代理"]')!
      inputValue(search, "old")
      fixture.querySelector<HTMLButtonElement>('[aria-label="搜索代理"]')!.click()
      await settle(() => !!holdOld, "旧搜索请求没有开始")
      inputValue(search, "new")
      fixture.querySelector<HTMLButtonElement>('[aria-label="搜索代理"]')!.click()
      await settle(() => !!fixture.textContent?.includes("最新结果"), "新搜索结果未出现")
      holdOld!(overview([{ ...rows[0], name: "过期结果" }]))
      await frame(); await frame()
      check(fixture.textContent?.includes("最新结果") && !fixture.textContent?.includes("过期结果"), "旧请求覆盖了新搜索")
      ;[...fixture.querySelectorAll<HTMLButtonElement>("button")].find((item) => item.textContent?.trim() === "重置")!.click()
      await settle(() => !!fixture.querySelector('[aria-label="编辑 agent1@example.invalid"]'), "重置未恢复列表")

      fixture.querySelector<HTMLButtonElement>('[aria-label="开通代理"]')!.click()
      await settle(() => !!document.querySelector('[role="dialog"] input[type="email"]'), "开通弹窗未打开")
      const email = document.querySelector<HTMLInputElement>('[role="dialog"] input[type="email"]')!
      inputValue(email, "created@example.invalid")
      document.querySelector<HTMLButtonElement>('[role="dialog"] button[type="submit"]')!.click()
      await settle(() => writes === 1 && !!fixture.textContent?.includes("created@example.invalid"), "隔离开通或回读失败")
      fixture.querySelector<HTMLButtonElement>('[aria-label="编辑 created@example.invalid"]')!.click()
      await settle(() => !!document.querySelector('[role="dialog"] input[required]'), "编辑弹窗未打开")
      document.querySelector<HTMLButtonElement>('[role="dialog"] button[type="submit"]')!.click()
      await settle(() => writes === 2, "隔离编辑未调用接口")
      results.textContent = `PASS: selection, copy, paging, unknown state, stale reads, create and edit (${reads} mock reads, ${writes} mock writes)`
      results.dataset.result = "pass"
    } catch (error) {
      results.textContent = `FAIL: ${error instanceof Error ? error.stack ?? error.message : String(error)}`
      results.dataset.result = "fail"
    } finally {
      flushSync(() => root.unmount())
      restoreFixture()
      run.disabled = false
    }
  }
}

import { flushSync } from "react-dom"
import { createRoot } from "react-dom/client"
import { AgentsScreen } from "@/features/agents/agents-screen"
import { Toaster } from "@/components/ui/toast"
import "../src/index.css"

const fixture = document.querySelector<HTMLDivElement>("#fixture")!
const results = document.querySelector<HTMLPreElement>("#results")!
const agent = {
  user_uuid: "11111111-1111-4111-8111-111111111111", name: "测试代理", email: "agent@example.invalid",
  invite_code: "TEST1234", status: "active", created_at: "2026-01-01T00:00:00Z", payout_account: null,
  wallet_balance_cents: 0, wallet_held_cents: 0, invitee_count: 0, credited_count: 0, skipped_count: 0, credited_total_cents: 0,
}
window.fetch = async (input, init) => {
  const url = new URL(input instanceof Request ? input.url : String(input), location.href)
  const method = init?.method ?? (input instanceof Request ? input.method : "GET")
  if (method === "GET" && url.pathname === "/api/admin/agents") return Response.json({ data: { agents: [agent], default_rebate_bps: 1000, min_order_cents: 10000, attribution_validity_days: 365, min_withdraw_cents: 10000 } })
  if (method === "GET" && url.pathname === "/api/admin/agent-commissions") return Response.json({ data: { commissions: [], total: 0 } })
  if (method === "GET" && url.pathname === "/api/admin/agent-withdrawals") return Response.json({ data: { withdrawals: [] } })
  throw new Error(`Fixture blocked ${method} ${url.pathname}`)
}

const frame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
async function waitFor(predicate: () => boolean, message: string) {
  for (let i = 0; i < 180; i++) { if (predicate()) return; await frame() }
  throw new Error(message)
}

document.querySelector<HTMLButtonElement>("#run")!.addEventListener("click", async () => {
  const root = createRoot(fixture)
  try {
    flushSync(() => root.render(<Toaster><AgentsScreen /></Toaster>))
    await waitFor(() => !!fixture.querySelector('[aria-label="编辑 agent@example.invalid"]'), "代理列表未加载")
    const create = fixture.querySelector<HTMLButtonElement>('[aria-label="开通代理"]')!
    const edit = fixture.querySelector<HTMLButtonElement>('[aria-label="编辑 agent@example.invalid"]')!
    if (window.innerWidth < 768) {
      const copy = fixture.querySelector<HTMLButtonElement>('[aria-label="复制 TEST1234"]')!
      const search = fixture.querySelector<HTMLButtonElement>('[aria-label="搜索代理"]')!
      for (const trigger of [create, edit, copy, search]) {
        const bounds = trigger.getBoundingClientRect()
        if (bounds.width < 44 || bounds.height < 44) throw new Error("移动端代理操作的触控区域不足 44px")
      }
    }
    for (const trigger of [create, edit]) {
      flushSync(() => { trigger.focus(); trigger.click() })
      await waitFor(() => {
        const dialog = document.querySelector<HTMLElement>('[role="dialog"]')
        return !!dialog && getComputedStyle(dialog).visibility !== "hidden" && dialog.contains(document.activeElement)
      }, "代理对话框未打开或未接收焦点")
      document.activeElement?.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }))
      await waitFor(() => [...document.querySelectorAll<HTMLElement>('[role="dialog"]')].every((dialog) => getComputedStyle(dialog).visibility === "hidden"), "代理对话框未关闭")
      await waitFor(() => document.activeElement === trigger, "关闭代理对话框后未回到入口")
    }
    results.textContent = "PASS: 创建和编辑弹窗关闭后恢复焦点，移动端操作尺寸合格，未发送写请求。"
  } catch (error) {
    results.textContent = `FAIL: ${String(error)}`
  } finally {
    root.unmount()
  }
})

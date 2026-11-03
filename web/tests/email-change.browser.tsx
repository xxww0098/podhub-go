import { StrictMode } from "react"
import { flushSync } from "react-dom"
import { createRoot } from "react-dom/client"
import { SESSION_REFRESH_EVENT } from "@/api/client"
import { App } from "@/app/App"
import { ChangeEmailDialog } from "@/components/change-email-dialog"
import { Toaster } from "@/components/ui/toast"
import { EmailLinkHost } from "@/features/account/email-link"
import "../src/index.css"

const root = createRoot(document.querySelector<HTMLDivElement>("#fixture")!)
const results = document.querySelector<HTMLPreElement>("#results")!
const calls: { path: string; body?: Record<string, string> }[] = []
let status = 200
let refreshes = 0
let overviewCalls = 0
let otherAccount = false
let resolveOldOverview: ((response: Response) => void) | undefined
let resolveRequest: ((response: Response) => void) | undefined
let hold = false
window.addEventListener(SESSION_REFRESH_EVENT, () => { refreshes += 1 })
window.fetch = async (input, init) => {
  const path = String(input)
  if (path === "/api/auth/email/change" || path === "/api/auth/email/confirm") {
    calls.push({ path, body: JSON.parse(String(init?.body)) })
    if (hold) return new Promise<Response>((resolve) => { resolveRequest = resolve })
    return response(status)
  }
  if (path === "/api/view/account-overview") {
    calls.push({ path })
    overviewCalls += 1
    if (otherAccount) return new Response(JSON.stringify({ data: { session: { authenticated: true, email: "other@example.invalid", name: "Other", role: "user" }, owned_count: 0, owned_limit: 3 } }), { status: 200 })
    if (overviewCalls === 1) return new Promise<Response>((resolve) => { resolveOldOverview = resolve })
    return new Response(JSON.stringify({ data: { session: { authenticated: false }, owned_count: 0, owned_limit: 3 } }), { status: 200 })
  }
  if (path === "/api/supplier/me") return new Response(JSON.stringify({ data: { sources: [] } }), { status: 200 })
  throw new Error(`unexpected request: ${path}`)
}
function response(code = 200) {
  return new Response(JSON.stringify(code === 200 ? { data: { ok: true } } : { code: "VALIDATION", error: "链接已失效" }), { status: code })
}
function check(value: unknown, message: string): asserts value { if (!value) throw new Error(message) }
async function until(condition: () => unknown, message: string) {
  const end = Date.now() + 5000
  while (Date.now() < end) {
    if (condition()) return
    await new Promise((resolve) => setTimeout(resolve, 16))
  }
  throw new Error(message)
}
function input(id: string, value: string) {
  const field = document.querySelector<HTMLInputElement>(`#${id}`)
  check(field, `缺少字段 ${id}`)
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(field, value)
  flushSync(() => field.dispatchEvent(new Event("input", { bubbles: true })))
}
function visibleDialog() { return document.querySelector<HTMLElement>('[data-slot="dialog-content"]:not([data-closed])') }
function button(text: string) {
  const found = [...(visibleDialog()?.querySelectorAll<HTMLButtonElement>("button") ?? [])].find((item) => item.textContent?.includes(text))
  check(found, `缺少按钮 ${text}`)
  return found
}
function mountLink() {
  flushSync(() => root.render(null))
  history.replaceState({}, "", "/tests/email-change.html?keep=1#email_change=one-time-token&other=yes")
  flushSync(() => root.render(<Toaster><StrictMode><EmailLinkHost /></StrictMode></Toaster>))
}

document.querySelector<HTMLButtonElement>("#run")!.addEventListener("click", async () => {
  try {
    let open = true
    flushSync(() => root.render(<Toaster><ChangeEmailDialog open onOpenChange={(next) => { open = next }} /></Toaster>))
    await until(visibleDialog, "没有打开换绑表单")
    const bounds = visibleDialog()!.getBoundingClientRect()
    check(bounds.left >= 0 && bounds.right <= window.innerWidth, "换绑表单超出视口")
    input("change-email-address", "new@example.invalid")
    input("change-email-password", "current-password")
    hold = true
    const form = visibleDialog()?.querySelector("form")
    check(form, "没有换绑表单")
    flushSync(() => {
      form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }))
      form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }))
    })
    await until(() => calls.length === 1, "换绑申请没有发出")
    check(calls[0]?.body?.email === "new@example.invalid" && calls[0]?.body?.current_password === "current-password", "邮箱或密码没有通过请求体提交")
    check(button("正在提交").disabled, "提交中未禁用按钮")
    resolveRequest?.(response())
    hold = false
    await until(() => !open, "申请受理后没有关闭表单")

    mountLink()
    await until(visibleDialog, "确认链接没有打开窗口")
    check(location.search === "?keep=1" && location.hash === "#other=yes", "没有安全移除链接凭证")
    check(Number(calls.length) === 1, "确认前已经提交换绑")
    status = 400
    flushSync(() => button("确认更换").click())
    await until(() => calls.length === 2 && [...(visibleDialog()?.querySelectorAll<HTMLButtonElement>("button") ?? [])].some((item) => item.textContent?.includes("确认更换") && !item.disabled), "失效链接没有完成处理")
    check(visibleDialog() && Number(calls.length) === 2, "失效链接被当作成功")
    status = 200
    hold = true
    flushSync(() => { button("确认更换").click(); button("确认更换").click() })
    await until(() => calls.length === 3, "确认请求未发出")
    check(calls[2]?.body?.token === "one-time-token", "链接凭证没有通过请求体提交")
    resolveRequest?.(response())
    hold = false
    await until(() => refreshes === 1, "换绑成功后未刷新登录状态")
    await until(() => !visibleDialog(), "成功确认后窗口未关闭")
    check(Number(calls.length) === 3, "换绑确认重复发送了请求")

    location.hash = "email_change=one-time-token&other=yes"
    await until(visibleDialog, "同一页面中的第二个确认链接没有打开窗口")
    check(location.hash === "#other=yes", "第二个链接的凭证未从地址清除")
    flushSync(() => button("确认更换").click())
    await until(() => !visibleDialog(), "第二次确认未完成")
    check(refreshes === 2, "第二次确认未刷新会话")

    flushSync(() => root.render(null))
    history.replaceState({}, "", "/supplier#email_change=delayed-token")
    flushSync(() => root.render(<Toaster><App /><EmailLinkHost /></Toaster>))
    await until(() => overviewCalls === 1 && visibleDialog(), "未开始首个会话查询或未显示确认窗口")
    flushSync(() => button("确认更换").click())
    await until(() => overviewCalls === 2, "换绑没有重新查询会话")
    await until(() => document.body.textContent?.includes("工厂登录"), "撤销会话后没有显示登录界面")
    resolveOldOverview?.(new Response(JSON.stringify({ data: { session: { authenticated: true, email: "old@example.invalid" } } }), { status: 200 }))
    await new Promise((resolve) => setTimeout(resolve, 100))
    check(document.body.textContent?.includes("工厂登录"), "过期的会话查询恢复了旧账号")

    flushSync(() => root.render(null))
    otherAccount = true
    history.replaceState({}, "", "/supplier#email_change=other-user-token")
    flushSync(() => root.render(<Toaster><App /><EmailLinkHost /></Toaster>))
    await until(() => visibleDialog() && document.body.textContent?.includes("这不是工厂账号"), "另一个账号未登录")
    const previousCalls = overviewCalls
    flushSync(() => button("确认更换").click())
    await until(() => overviewCalls > previousCalls && document.body.textContent?.includes("这不是工厂账号"), "换绑其他账号后当前登录被清除")
    results.textContent = "PASS 邮箱申请、失败重试、一次性链接和会话刷新"
    document.documentElement.dataset.result = "pass"
  } catch (reason) {
    results.textContent = `FAIL ${reason instanceof Error ? reason.message : String(reason)}`
    document.documentElement.dataset.result = "fail"
  }
})

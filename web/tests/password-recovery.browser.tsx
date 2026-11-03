import { StrictMode } from "react"
import { flushSync } from "react-dom"
import { createRoot } from "react-dom/client"
import { UNAUTHENTICATED_EVENT } from "@/api/client"
import { Toaster } from "@/components/ui/toast"
import { EmailLinkHost } from "@/features/account/email-link"
import { PasswordRecoveryButton, PASSWORD_RECOVERY_ACCEPTED } from "@/features/account/login-screen-password-recovery"
import "../src/index.css"

const fixture = document.querySelector<HTMLDivElement>("#fixture")!
const results = document.querySelector<HTMLPreElement>("#results")!
const root = createRoot(fixture)
const frame = () => new Promise<void>((resolve) => window.setTimeout(resolve, 16))
async function settle() { await frame(); await frame() }
function check(value: unknown, message: string): asserts value { if (!value) throw new Error(message) }
async function until(condition: () => unknown, message: string) {
  const expires = Date.now() + 5_000
  while (Date.now() < expires) { if (condition()) return; await frame() }
  throw new Error(message)
}
function deferred() {
  let resolve!: (value: Response) => void
  const promise = new Promise<Response>((done) => { resolve = done })
  return { promise, resolve }
}
function response(status = 200, message?: string, headers?: HeadersInit) {
  return new Response(JSON.stringify(message ? { code: status === 429 ? "RATE_LIMITED" : "UNAVAILABLE", error: message } : { data: null }), { status, headers: { "content-type": "application/json", ...headers } })
}
const calls: { path: string; body: Record<string, string> }[] = []
const unknown: string[] = []
let forgot = async () => response()
let reset = async () => response()
let overviewStatus = 200
let expiredSessions = 0
window.addEventListener(UNAUTHENTICATED_EVENT, () => { expiredSessions += 1 })
window.fetch = async (input, init) => {
  const path = String(input)
  if (path === "/api/auth/forgot" || path === "/api/auth/reset") {
    calls.push({ path, body: JSON.parse(String(init?.body)) })
    return path.endsWith("/forgot") ? forgot() : reset()
  }
  if (path === "/api/events/inbox") return response()
  if (path === "/api/view/account-overview") return response(overviewStatus, overviewStatus === 401 ? "请重新登录。" : undefined)
  unknown.push(path.split(/[?#]/)[0]!)
  throw new Error("unregistered network request")
}
function dialog() { return document.querySelector<HTMLElement>('[data-slot="dialog-content"]:not([data-closed])') }
function form() { const found = dialog()?.querySelector("form"); check(found, "缺少密码找回表单"); return found }
function submitTwice() {
  const target = form()
  flushSync(() => {
    target.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }))
    target.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }))
  })
}
async function input(id: string, value: string) {
  const field = document.querySelector<HTMLInputElement>(`#${id}`)
  check(field, `缺少字段 ${id}`)
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(field, value)
  flushSync(() => field.dispatchEvent(new Event("input", { bubbles: true })))
  await settle()
}
async function mountReset(hash: string) {
  flushSync(() => root.render(null))
  history.replaceState({}, "", `/tests/password-recovery.html?retained=1${hash}`)
  flushSync(() => root.render(<Toaster><StrictMode><EmailLinkHost /></StrictMode></Toaster>))
  await until(dialog, "fragment 没有打开重置窗口")
  check(!location.href.includes("password_reset"), "重置凭据未立即从地址清除")
  check(location.search === "?retained=1", "清理凭据丢失了原地址参数")
}
function acceptedCount() { return [...document.querySelectorAll('[data-slot="toast-title"]')].filter((item) => item.textContent === PASSWORD_RECOVERY_ACCEPTED).length }
async function openRecovery() {
  const button = [...fixture.querySelectorAll<HTMLButtonElement>("button")].find((item) => item.textContent === "忘记密码？")
  check(button, "缺少找回入口")
  flushSync(() => button.click())
  await until(dialog, "找回入口没有打开表单")
}

document.querySelector<HTMLButtonElement>("#run")!.addEventListener("click", async () => {
  try {
    results.textContent = "运行中：申请受理与重复提交"
    const pending = deferred()
    forgot = async () => pending.promise
    flushSync(() => root.render(<Toaster><PasswordRecoveryButton email="person@example.invalid" /></Toaster>))
    await openRecovery()
    check(document.querySelector<HTMLInputElement>("#password-recovery-email")?.value === "person@example.invalid", "登录邮箱没有带入申请")
    submitTwice()
    await settle()
    check(calls.length === 1 && calls[0]!.body.email === "person@example.invalid", "同一申请被重复提交或邮箱错误")
    check(dialog()?.querySelector<HTMLButtonElement>('button[type="submit"]')?.disabled, "等待时申请按钮未禁用")
    pending.resolve(response())
    await until(() => !dialog(), "受理后未关闭申请窗口")
    await until(() => acceptedCount() > 0, "受理后未显示防枚举提示")

    for (const failure of ["unavailable", "network", "throttled"] as const) {
      results.textContent = `运行中：${failure}`
      await openRecovery()
      const accepted = acceptedCount()
      forgot = async () => {
        if (failure === "network") throw new TypeError("fixture offline")
        return failure === "throttled" ? response(429, "请求过于频繁，请稍后重试。", { "Retry-After": "1" }) : response(503, "邮件服务暂时不可用，请稍后重试。")
      }
      const before: number = calls.length
      submitTwice()
      await until(() => calls.length > before && !dialog()?.querySelector<HTMLButtonElement>('button[type="submit"]')?.textContent?.includes("正在申请"), `${failure} 没有结束等待`)
      check(calls.length === before + 1 && acceptedCount() <= accepted && dialog(), `${failure} 被当成成功或重复提交`)
      check(document.querySelector<HTMLInputElement>("#password-recovery-email")?.value === "person@example.invalid", `${failure} 清空了邮箱`)
      if (failure === "throttled") {
        check(dialog()?.querySelector<HTMLButtonElement>('button[type="submit"]')?.disabled, "429没有遵守Retry-After")
        submitTwice()
        await settle()
        check(calls.length === before + 1, "节流等待期仍然提交请求")
        await until(() => !dialog()?.querySelector<HTMLButtonElement>('button[type="submit"]')?.disabled, "Retry-After后无法重试")
      }
      flushSync(() => dialog()?.querySelector<HTMLButtonElement>('[data-slot="dialog-close"]')?.click())
      await until(() => !dialog(), "失败后无法关闭申请")
    }

    results.textContent = "运行中：fragment 与重置失败"
    await mountReset("#password_reset=fixture-token&keep=yes")
    check(location.hash === "#keep=yes", "清理token破坏其他fragment")
    await input("reset-password", "1234567")
    const beforeInvalid: number = calls.length
    submitTwice()
    await settle()
    check(calls.length === beforeInvalid, "短密码调用了重置接口")
    await input("reset-password", "密".repeat(25))
    submitTwice()
    await settle()
    check(calls.length === beforeInvalid, "超过72字节密码调用了重置接口")

    await input("reset-password", "密码重置中文验证")
    const resetPending = deferred()
    reset = async () => resetPending.promise
    submitTwice()
    await settle()
    check(calls.length === beforeInvalid + 1, "重置请求被重复提交")
    const request = calls.at(-1)!
    check(request.path === "/api/auth/reset" && request.body.token === "fixture-token" && request.body.password === "密码重置中文验证", "fragment凭据或Unicode密码没有通过body送出")
    resetPending.resolve(response(400, "重置链接已失效，请重新申请。"))
    await until(() => !dialog()?.querySelector<HTMLButtonElement>('button[type="submit"]')?.disabled, "失效链接没有结束保存状态")
    check(dialog() && document.querySelector<HTMLInputElement>("#reset-password")?.value === "密码重置中文验证", "失效链接被当成功或清空密码")
    check(!document.body.textContent?.includes("密码已重置，请使用新密码登录。"), "失效链接显示重置成功")
    reset = async () => response()
    flushSync(() => form().dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })))
    await until(() => !dialog(), "有效重置未关闭窗口")
    check(document.body.textContent?.includes("密码已重置，请使用新密码登录。"), "有效重置缺少成功反馈")
    check(expiredSessions === 0, "重置其他账户密码使当前有效会话退出")
    await mountReset("#password_reset=revoked-session-token")
    overviewStatus = 401
    await input("reset-password", "new-password")
    flushSync(() => form().dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })))
    await until(() => !dialog(), "会话过期把已完成重置当成失败")
    check(Number(expiredSessions) === 1, "重置后的过期会话未触发现有退出流程")
    flushSync(() => root.render(null))
    flushSync(() => root.render(<Toaster><EmailLinkHost /></Toaster>))
    await settle()
    check(!dialog(), "fragment在重新挂载后被重复消费")
    check(unknown.length === 0, `出现未注册请求：${unknown.join(",")}`)
    flushSync(() => root.render(<Toaster><PasswordRecoveryButton email="person@example.invalid" /></Toaster>))
    results.textContent = `PASS ${JSON.stringify({ cases: 14, forgotRequests: calls.filter((item) => item.path.endsWith("/forgot")).length, resetRequests: calls.filter((item) => item.path.endsWith("/reset")).length, unknownRequests: unknown.length })}`
    document.documentElement.dataset.result = "pass"
  } catch (reason) {
    results.textContent = `FAIL ${reason instanceof Error ? reason.message : String(reason)}`
    document.documentElement.dataset.result = "fail"
  }
})

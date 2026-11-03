import { StrictMode } from "react"
import { flushSync } from "react-dom"
import { createRoot } from "react-dom/client"
import { accountHttp } from "@/bindings/http-account"
import type { NotificationsView } from "@/bindings/commands"
import { NotificationsProvider } from "@/features/notifications/notifications"
import { NotificationsScreen } from "@/features/notifications/notifications-screen"
import { toast } from "@/components/ui/toast"
import { overview } from "./account-fixtures"
import "../src/index.css"

const fixture = document.querySelector<HTMLDivElement>("#fixture")!
const results = document.querySelector<HTMLPreElement>("#results")!
const run = document.querySelector<HTMLButtonElement>("#run")!
const frame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
function check(value: unknown, message: string): asserts value { if (!value) throw new Error(message) }

run.onclick = async () => {
  run.disabled = true
  results.textContent = "运行中"
  delete results.dataset.result
  const originalRead = accountHttp.accountListNotifications
  const originalMarkAll = accountHttp.accountMarkAllNotificationsRead
  const originalOverview = accountHttp.accountGetOverview
  const root = createRoot(fixture)
  let unmounted = false
  let reads = 0
  let read!: (view: NotificationsView) => void
  let rejectRead!: (reason: unknown) => void
  const addedToasts: unknown[] = []
  const unsubscribe = toast[" subscribe"]((event) => { if (event.action === "add") addedToasts.push(event) })
  let current: NotificationsView = { notifications: [], total: 0, unread: 0 }
  accountHttp.accountListNotifications = async () => {
    reads++
    return new Promise<NotificationsView>((resolve, reject) => { read = resolve; rejectRead = reject })
  }
  accountHttp.accountMarkAllNotificationsRead = async () => {
    current = { ...current, unread: 0, notifications: current.notifications.map((row) => ({ ...row, read_at_ms: Date.now() })) }
    return { ok: true, unread: 0 }
  }
  accountHttp.accountGetOverview = async () => overview
  const settle = async (predicate: () => boolean, message: string) => {
    const deadline = performance.now() + 1500
    while (!predicate()) {
      check(performance.now() < deadline, message)
      await frame()
    }
  }
  try {
    flushSync(() => root.render(<StrictMode><NotificationsProvider><NotificationsScreen /></NotificationsProvider></StrictMode>))
    await frame()
    check(reads === 1, "StrictMode must share the pending first read")
    check(fixture.textContent?.includes("正在读取通知"), "first read must show loading")
    read(current)
    await settle(() => fixture.textContent?.includes("还没有通知") === true, "first successful read was dropped until the next poll")
    check(reads === 1, "empty inbox required another read")

    current = { notifications: [{ uuid: "qa-notification", kind: "delegate_order_event", created_at_ms: Date.now() }], total: 1, unread: 1 }
    fixture.querySelector<HTMLButtonElement>('[aria-label="刷新通知"]')!.click()
    await settle(() => reads === 2, "refresh did not read")
    read(current)
    await settle(() => fixture.textContent?.includes("1 条未读") === true, "refresh did not replace the empty inbox")
    const markAll = [...fixture.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.getAttribute("aria-label") === "全部已读")!
    markAll.click()
    await settle(() => reads === 3, "mark-all-read did not reload")
    read(current)
    await settle(() => !fixture.textContent?.includes("1 条未读"), "mark-all-read did not settle")
    fixture.querySelector<HTMLButtonElement>('[aria-label="刷新通知"]')!.click()
    await settle(() => reads === 4, "final refresh did not read")
    flushSync(() => root.unmount())
    unmounted = true
    const toastCount = addedToasts.length
    rejectRead(new Error("late notification read"))
    await frame()
    check(addedToasts.length === toastCount, "unmounted reader reported a stale failure")

    results.textContent = "PASS: StrictMode initial empty read, refresh, mark all read, unmount fencing"
    results.dataset.result = "pass"
  } catch (reason) {
    results.textContent = `FAIL: ${reason instanceof Error ? reason.message : String(reason)}`
    results.dataset.result = "fail"
  } finally {
    if (!unmounted) flushSync(() => root.unmount())
    unsubscribe()
    accountHttp.accountListNotifications = originalRead
    accountHttp.accountMarkAllNotificationsRead = originalMarkAll
    accountHttp.accountGetOverview = originalOverview
    run.disabled = false
  }
}

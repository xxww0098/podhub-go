import { flushSync } from "react-dom"
import { createRoot } from "react-dom/client"

import type { MessageCenterChatItem, MessageCenterHistoryView, MessageCenterInboxView, MessageCenterSendRequest, MessageCenterSendView, OzonStoreView } from "@/bindings/commands"
import { opsHttp } from "@/bindings/http-ops"
import { Toaster } from "@/components/ui/toast"
import { MessageCenterScreen } from "@/features/message-center/message-center-screen"
import { forgetStoreRoster, rememberStoreRoster } from "@/features/stores/store-roster-cache"
import "../src/index.css"

const fixture = document.querySelector<HTMLDivElement>("#fixture")!
const results = document.querySelector<HTMLPreElement>("#results")!
const root = createRoot(fixture)
const originalInbox = opsHttp.messageCenterInbox
const originalHistory = opsHttp.messageCenterHistory
const originalSend = opsHttp.messageCenterSend
window.fetch = async () => { throw new Error("network disabled in interaction test") }
const storeId = "11111111-1111-4111-8111-111111111111"
const frame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
async function settle() { await frame(); await frame() }
async function until(condition: () => unknown, message: string) {
  for (let i = 0; i < 120; i += 1) {
    if (condition()) return
    await frame()
  }
  throw new Error(message)
}
function check(value: unknown, message: string): asserts value { if (!value) throw new Error(message) }
function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail })
  return { promise, resolve, reject }
}
function chat(id: string): MessageCenterChatItem {
  return { store_id: storeId, chat_id: id, chat_status: "OPENED", chat_type: "BUYER_SELLER", session_kind: "buyer", created_at: "2026-01-01T00:00:00Z", unread_count: 0, last_message_id: "", preview: "" }
}
function history(id: string, text: string): MessageCenterHistoryView {
  return { store_id: storeId, chat_id: id, has_next: false, messages: [{ message_id: "1", user_type: "Support", created_at: "2026-01-01T00:00:00Z", is_read: false, is_image: false, data: [text] }] }
}
function inbox(name: string, chats = [chat("chat-A"), chat("chat-B")]): MessageCenterInboxView {
  return {
    stores: [{ store_id: storeId, name, store_number: "1", fetched: true, fail_reason: "", unread_count: 0, session_count: chats.length, waiting_reply: false, chats }],
    failed_stores: [], waiting_reply_count: 0, platform_notification_count: 0, store_count: 1, waiting_reply_store_count: 0, session_count: chats.length, failed_store_count: 0,
  }
}
function remember(workspaceId: number) {
  rememberStoreRoster({ stores: [{ id: storeId, cloud_store_uuid: storeId, label: "测试店", client_id: "1", configured: true, cloud_status: "active" } as OzonStoreView] }, workspaceId)
}
function option(id: string) {
  const button = fixture.querySelector<HTMLButtonElement>(`button[role="option"][title="${id}"]`)
  check(button, `缺少会话 ${id}`)
  return button
}
function button(text: string) {
  const found = [...fixture.querySelectorAll<HTMLButtonElement>("button")].find((item) => item.textContent?.includes(text))
  check(found, `缺少按钮 ${text}`)
  return found
}
async function click(element: HTMLElement) { flushSync(() => element.click()); await settle() }
async function draft(value: string) {
  const input = fixture.querySelector<HTMLTextAreaElement>("#mc-draft-ru")
  check(input, "缺少俄文输入框")
  Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(input, value)
  input.dispatchEvent(new Event("input", { bubbles: true }))
  await settle()
}
function draftValue() { return fixture.querySelector<HTMLTextAreaElement>("#mc-draft-ru")?.value }
async function reset() { flushSync(() => root.render(null)); await settle() }

document.querySelector<HTMLButtonElement>("#run")!.addEventListener("click", async () => {
  try {
    remember(501)
    remember(502)
    const sendRead = deferred<MessageCenterHistoryView>()
    let aReads = 0
    let sends = 0
    opsHttp.messageCenterInbox = async () => inbox("测试店")
    opsHttp.messageCenterHistory = async ({ chat_id }) => {
      if (chat_id === "chat-A" && ++aReads === 2) return sendRead.promise
      return history(chat_id, `${chat_id}-正常内容`)
    }
    opsHttp.messageCenterSend = async (request) => {
      sends += 1
      return { store_id: request.store_id, chat_id: request.chat_id, result: "ok" }
    }
    flushSync(() => root.render(<MessageCenterScreen workspaceId={501} />))
    await until(() => fixture.textContent?.includes("chat-A-正常内容"), "初始会话未加载")
    await draft("第一条消息")
    await click(button("发送俄文"))
    await until(() => aReads === 2, "发送后的读取未开始")
    await click(option("chat-B"))
    await until(() => fixture.textContent?.includes("chat-B-正常内容"), "第二个会话未加载")
    check(draftValue() === "", "新会话显示了旧会话草稿")
    await draft("第二个会话的新草稿")
    sendRead.resolve(history("chat-A", "旧发送的迟到读取"))
    await settle()
    await settle()
    check(sends === 1, "消息被重复发送")
    check(fixture.textContent?.includes("chat-B-正常内容") && !fixture.textContent?.includes("旧发送的迟到读取"), "旧回读覆盖了新会话")
    check(draftValue() === "第二个会话的新草稿", "旧发送清空了新会话草稿")
    await click(option("chat-A"))
    await until(() => fixture.textContent?.includes("chat-A-正常内容"), "未返回第一个会话")
    check(draftValue() === "", "已发送草稿没有清空")
    await click(option("chat-B"))
    check(draftValue() === "第二个会话的新草稿", "切回会话后草稿丢失")
    await reset()

    const oldEmptyRead = deferred<MessageCenterHistoryView>()
    const freshRead = deferred<MessageCenterHistoryView>()
    aReads = 0
    opsHttp.messageCenterInbox = async () => inbox("测试店", [chat("chat-A")])
    opsHttp.messageCenterHistory = async () => (++aReads === 1 ? oldEmptyRead.promise : freshRead.promise)
    flushSync(() => root.render(<MessageCenterScreen workspaceId={501} />))
    await until(() => aReads === 1, "第一个历史读取未开始")
    await click(button("平台通知"))
    oldEmptyRead.resolve(history("chat-A", "已失效的历史"))
    await settle()
    await click(button("买家消息"))
    await until(() => aReads === 2, "重新选择会话未读取")
    check(!fixture.textContent?.includes("已失效的历史"), "空会话后的旧读取重新出现")
    freshRead.resolve(history("chat-A", "重新读取的历史"))
    await until(() => fixture.textContent?.includes("重新读取的历史"), "新历史未显示")
    await reset()

    const oldWorkspaceRead = deferred<MessageCenterHistoryView>()
    let workspace = 501
    opsHttp.messageCenterInbox = async () => inbox(workspace === 501 ? "旧空间店铺" : "新空间店铺", [chat("chat-A")])
    opsHttp.messageCenterHistory = async () => workspace === 501 ? oldWorkspaceRead.promise : history("chat-A", "新空间历史")
    flushSync(() => root.render(<MessageCenterScreen workspaceId={501} />))
    await until(() => fixture.textContent?.includes("旧空间店铺"), "旧空间未加载")
    workspace = 502
    flushSync(() => root.render(<MessageCenterScreen workspaceId={502} />))
    await until(() => fixture.textContent?.includes("新空间历史"), "新空间未加载")
    await draft("新空间草稿")
    oldWorkspaceRead.resolve(history("chat-A", "旧空间迟到历史"))
    await settle()
    await settle()
    check(fixture.textContent?.includes("新空间历史") && !fixture.textContent?.includes("旧空间迟到历史"), "旧空间历史覆盖了新空间")
    check(draftValue() === "新空间草稿", "旧空间结果清空了新空间草稿")
    await reset()

    const oldWorkspaceSend = deferred<MessageCenterSendView>()
    let workspaceReads = 0
    workspace = 501
    opsHttp.messageCenterInbox = async () => inbox(workspace === 501 ? "旧空间店铺" : "新空间店铺", [chat("chat-A")])
    opsHttp.messageCenterHistory = async () => {
      workspaceReads += 1
      return history("chat-A", workspace === 501 ? "旧空间历史" : "新空间历史")
    }
    opsHttp.messageCenterSend = async () => oldWorkspaceSend.promise
    flushSync(() => root.render(<MessageCenterScreen workspaceId={501} />))
    await until(() => fixture.textContent?.includes("旧空间历史"), "旧空间发送前的历史未加载")
    await draft("旧空间待发送")
    await click(button("发送俄文"))
    workspace = 502
    flushSync(() => root.render(<MessageCenterScreen workspaceId={502} />))
    await until(() => fixture.textContent?.includes("新空间历史"), "发送后新空间未加载")
    await draft("新空间的新草稿")
    check(!button("发送俄文").disabled, "旧空间的发送阻塞了新空间")
    oldWorkspaceSend.resolve({ store_id: storeId, chat_id: "chat-A", result: "ok" })
    await settle()
    await settle()
    check(workspaceReads === 2, "切换空间后仍读取了旧会话")
    check(fixture.textContent?.includes("新空间历史") && draftValue() === "新空间的新草稿", "旧空间发送结果覆盖了新空间")
    await reset()

    const sameSessionSend = deferred<MessageCenterSendView>()
    opsHttp.messageCenterInbox = async () => inbox("测试店", [chat("chat-A")])
    opsHttp.messageCenterHistory = async () => history("chat-A", "同会话历史")
    opsHttp.messageCenterSend = async () => sameSessionSend.promise
    flushSync(() => root.render(<MessageCenterScreen workspaceId={501} />))
    await until(() => fixture.textContent?.includes("同会话历史"), "同会话测试未加载")
    await draft("已提交的内容")
    await click(button("发送俄文"))
    await draft("等待期间输入的新内容")
    sameSessionSend.resolve({ store_id: storeId, chat_id: "chat-A", result: "ok" })
    await settle()
    await settle()
    check(draftValue() === "等待期间输入的新内容", "发送完成时清空了同会话的新草稿")
    await reset()

    for (const code of ["cloud_ozon_auth_failed", "cloud_ozon_message_center_failed", "cloud_unavailable", "cloud_internal"]) {
      const requests: MessageCenterSendRequest[] = []
      opsHttp.messageCenterInbox = async () => inbox("测试店", [chat("chat-A")])
      opsHttp.messageCenterHistory = async () => history("chat-A", "发送标识回归")
      opsHttp.messageCenterSend = async (request) => {
        requests.push({ ...request })
        if (requests.length === 1) throw Object.assign(new Error("fixture refusal"), { code })
        return { store_id: request.store_id, chat_id: request.chat_id, result: "ok" }
      }
      flushSync(() => root.render(<MessageCenterScreen workspaceId={501} />))
      await until(() => fixture.textContent?.includes("发送标识回归"), "发送标识测试未加载")
      await draft("Спасибо")
      await click(button("发送俄文"))
      check(requests.length === 1 && draftValue() === "Спасибо", `${code} 后原稿没有保留`)
      await click(button("发送俄文"))
      check(Number(requests.length) === 2 && draftValue() === "", `${code} 后重试未完成`)
      const decided = code === "cloud_ozon_auth_failed" || code === "cloud_ozon_message_center_failed"
      check((requests[0]!.operation_id !== requests[1]!.operation_id) === decided, `${code} 的重试标识策略错误`)
      await draft("Спасибо")
      await click(button("发送俄文"))
      check(Number(requests.length) === 3 && requests[1]!.operation_id !== requests[2]!.operation_id, "连续成功发送同文复用了旧标识")
      await reset()
    }

    const unknownSend = deferred<MessageCenterSendView>()
    opsHttp.messageCenterInbox = async () => inbox("测试店")
    opsHttp.messageCenterHistory = async ({ chat_id }) => history(chat_id, `${chat_id}-未知结果测试`)
    opsHttp.messageCenterSend = async () => unknownSend.promise
    flushSync(() => root.render(<Toaster><MessageCenterScreen workspaceId={501} /></Toaster>))
    await until(() => fixture.textContent?.includes("chat-A-未知结果测试"), "未知结果测试未加载")
    await draft("可能已发送的内容")
    await click(button("发送俄文"))
    await click(option("chat-B"))
    await until(() => fixture.textContent?.includes("chat-B-未知结果测试"), "未知结果测试的第二会话未加载")
    await draft("第二会话草稿")
    unknownSend.reject({ code: "cloud_seller_result_unknown" })
    await until(() => document.body.textContent?.includes("请勿重发"), "未知结果没有提示不要重发")
    check(draftValue() === "第二会话草稿", "旧会话未知结果清空了当前草稿")
    await click(option("chat-A"))
    check(draftValue() === "", "未知结果保留了可能已发送的原草稿")
    results.textContent = "PASS: 发送回读、会话/工作空间隔离、已拒绝与不确定失败重试标识、同文独立发送"
  } catch (error) {
    results.textContent = `FAIL: ${error instanceof Error ? error.message : String(error)}`
  } finally {
    opsHttp.messageCenterInbox = originalInbox
    opsHttp.messageCenterHistory = originalHistory
    opsHttp.messageCenterSend = originalSend
    forgetStoreRoster(501)
    forgetStoreRoster(502)
    flushSync(() => root.render(null))
  }
})

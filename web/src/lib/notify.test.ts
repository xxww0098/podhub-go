import { renderToStaticMarkup } from "react-dom/server"
import type { ReactNode } from "react"
import assert from "node:assert/strict"
import test from "node:test"
import { toast } from "@/components/ui/toast"
import { route } from "@/api/routes"
import { setErrorTelemetryContext } from "./error-telemetry"
import { diagLog, reportError } from "./diag-log"
import { clearLive, notifyCommandError, notifyError, notifyInfo, notifyLive, notifySuccess } from "./notify"

test("every error entry point exposes a unique receipt and keeps its code, copy and trace searchable", () => {
  const notices: Parameters<typeof toast.add>[0][] = []
  const lines: string[] = [], closed: string[] = []
  const originalAdd = toast.add, originalClose = toast.close, originalLog = console.log
  toast.add = ((notice) => { notices.push(notice); return notice.id ?? "notice" }) as typeof toast.add
  toast.close = ((id) => { if (id) closed.push(id) }) as typeof toast.close
  console.log = (line) => { lines.push(String(line)) }
  const reason = Object.assign(new Error("raw token=secret"), {
    code: "cloud_offer_busy", serverCode: "offer_busy", traceId: "http-request-1", requestId: "ocr-request-1",
  })
  try {
    reportError("[api]", reason)
    notifyCommandError(reason, "本次整块未入队")
    notifyError("图片上传失败", { reason, description: "请核对图片。", id: "upload", timeout: 10_000 })
    const retry = () => undefined
    notifyLive({ id: "media", type: "error", title: "读取媒体失败", reason, action: { label: "重试", onClick: retry } })
    notifyError("请填写名称。")
    notifyCommandError({ code: "LOCAL_IO", message: "本地文件读取失败" }, "读取失败")
    notifyError("无法完成操作", { reason: { serverCode: "password=secret", code: "https://invalid", traceId: "Bearer secret" } })

    const ids = new Set<string>()
    for (const [index, notice] of notices.entries()) {
      assert.equal(notice.type, "error")
      const description = renderToStaticMarkup(notice.description as ReactNode)
      const id = />([0-9]{20})</.exec(description)?.[1]
      assert.ok(id)
      ids.add(id)
      const code = index < 3 ? "offer_busy" : index === 4 ? "LOCAL_IO" : "operation_failed"
      assert.ok(!description.includes(`错误代码：${code}`))
      const log = lines.find((line) => line.includes(`errorId=${id}`))
      assert.ok(log, "even an already reported exception must log the displayed receipt")
      assert.ok(log.includes(`code=${code}`))
      if (index < 3) {
        assert.ok(!description.includes("http-request-1"))
        assert.ok(log.includes("traceId=http-request-1"))
      }
    }
    assert.equal(ids.size, 6)
    assert.equal(notices[0]!.title, "本次整块未入队")
    assert.match(renderToStaticMarkup(notices[1]!.description as ReactNode), /请核对图片。/)
    assert.equal(notices[1]!.id, "upload")
    assert.equal(notices[1]!.timeout, 10_000)
    assert.equal(notices[2]!.id, "media")
    assert.equal(notices[2]!.timeout, 0)
    assert.equal(notices[2]!.actionProps?.onClick, retry)
    assert.ok(!JSON.stringify(notices).includes("secret"))
    assert.ok(!JSON.stringify(notices).includes("ocr-request-1"))
    clearLive("media")
    assert.deepEqual(closed, ["media"])

    notifyInfo("处理中")
    notifySuccess("已保存")
    notifyLive({ id: "loading", type: "loading", title: "正在上传", description: "1/2" })
    assert.deepEqual(notices.slice(6).map((notice) => notice.description), [undefined, undefined, "1/2"])

    const logCount = lines.length
    notifyError("请填写名称。")
    assert.equal(renderToStaticMarkup(notices.at(-1)!.description as ReactNode), renderToStaticMarkup(notices[3]!.description as ReactNode), "repeat within the existing 30s window reuses its searchable receipt")
    assert.equal(lines.length, logCount)

    diagLog("[notify]", "error", { code: "LOCAL_IO", message: "本地数据未保存" })
    const beforeReceipt = lines.filter(line => line.startsWith("[notify]")).length
    notifyError("本地数据未保存", { reason: { code: "LOCAL_IO" } })
    assert.equal(lines.filter(line => line.startsWith("[notify]")).length, beforeReceipt + 1, "an earlier unnumbered log cannot hide the new receipt")
    const id = />([0-9]{20})</.exec(renderToStaticMarkup(notices.at(-1)!.description as ReactNode))![1]!
    assert.ok(lines.at(-1)!.includes(`errorId=${id}`))

    const originalNow = Date.now
    try {
      Date.now = () => originalNow() + 30_001
      notifyError("本地数据未保存", { reason: { code: "LOCAL_IO" } })
      assert.ok(!renderToStaticMarkup(notices.at(-1)!.description as ReactNode).includes(id), "a later occurrence gets a new receipt")
      assert.equal(lines.filter(line => line.startsWith("[notify]")).length, beforeReceipt + 2)
    } finally { Date.now = originalNow }
  } finally { toast.add = originalAdd; toast.close = originalClose; console.log = originalLog }
})

test("displayed numeric receipt reaches the backend without UI copy and is fenced on account switch", async () => {
  const notices: Parameters<typeof toast.add>[0][] = []
  const payloads: Array<{ errorId: string; code: string; traceId: string }> = []
  const originalFetch = globalThis.fetch, originalAdd = toast.add, originalLog = console.log
  toast.add = ((notice) => { notices.push(notice); return "notice" }) as typeof toast.add
  console.log = () => undefined
  globalThis.fetch = (async (url, init) => {
    assert.equal(String(url), route("eventsInbox"))
    const body = JSON.parse(String(init?.body))
    for (const event of body.events) {
      assert.equal(event.kind, "error_feedback.v1")
      assert.doesNotMatch(event.payload_json, /secret|private|message|remediation/)
      payloads.push(JSON.parse(event.payload_json))
    }
    return Response.json({ data: { accepted: body.events.map((event: { id: string }) => event.id), rejected: [] } })
  }) as typeof fetch
  try {
    const reason = { code: "cloud_request_failed", status: 502, traceId: "request-502", message: "云端未确认本次操作结果", cause: "token=secret" }
    setErrorTelemetryContext({ sessionKey: "feedback-account-a" })
    notifyError("上传失败", { reason })
    await new Promise(resolve => setTimeout(resolve, 10))
    assert.equal(payloads.length, 1)
    assert.match(renderToStaticMarkup(notices[0]!.description as ReactNode), new RegExp(payloads[0]!.errorId))
    assert.equal(payloads[0]!.traceId, "request-502")
    setErrorTelemetryContext({ sessionKey: "feedback-account-b" })
    notifyError("上传失败", { reason })
    await new Promise(resolve => setTimeout(resolve, 10))
    assert.equal(payloads.length, 2)
    assert.notEqual(payloads[0]!.errorId, payloads[1]!.errorId)
  } finally {
    setErrorTelemetryContext({ sessionKey: null })
    globalThis.fetch = originalFetch; toast.add = originalAdd; console.log = originalLog
  }
})

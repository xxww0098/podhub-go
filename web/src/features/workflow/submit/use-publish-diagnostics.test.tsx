import assert from "node:assert/strict"
import test from "node:test"
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { route } from "@/api/routes"
import { toast } from "@/components/ui/toast"
import { getDiagnosticDetail, openDiagnosticPublishWindow, setErrorTelemetryContext, resumeErrorTelemetry } from "@/lib/error-telemetry"
import { capturePublishDiagnostic } from "../model/publish-diagnostic"
import { createPublishDiagnosticAction } from "./queue/diagnostics"
import { createPublishDiagnosticRoute, usePublishDiagnostics } from "./use-publish-diagnostics"

test("mounted route owner goes inactive without admitting a report; only a later explicit current gesture may deliver held diagnostics", async () => {
  let active = false
  const owner = createPublishDiagnosticRoute(() => active)
  const original = globalThis.fetch, beforeToast = toast.add
  const notices: string[] = [], requests: string[] = []
  setErrorTelemetryContext({ sessionKey: "route-activity" })
  toast.add = (notice) => { notices.push(String(notice.title)); return "route-notice" }
  globalThis.fetch = async (input, init) => {
    requests.push(String(input))
    assert.equal(String(input), route("eventsInbox"), "explicit report has no business operation")
    const events = JSON.parse(String(init?.body)).events as Array<{ id: string }>
    return Response.json({ data: { accepted: events.map((event) => event.id), rejected: [] } })
  }
  try {
    const held = await capturePublishDiagnostic({ platform: "ozon", stage: "freeze", code: "core_unavailable" })
    assert.ok(held?.event)
    owner.enter()
    assert.equal(await owner.report(held.diagnosticId), false)
    assert.equal(notices.length, 1)
    active = true; owner.enter()
    active = false // Same owner still mounted, before effect cleanup can run.
    assert.equal(await owner.report(held.diagnosticId), false)
    resumeErrorTelemetry()
    assert.equal(requests.length, 0)
    active = true
    const reporting = owner.report(held.diagnosticId)
    assert.equal(requests.length, 1, "the claim/fetch starts synchronously at the gesture")
    assert.equal(await owner.report(held.diagnosticId), false, "same-frame double click joins no new action")
    assert.equal(await reporting, true)
    assert.equal(await owner.report(held.diagnosticId), true, "a later explicit click is an independent report gesture")
    assert.equal(requests.length, 1, "an acknowledged diagnostic is not queued again by that gesture")
    owner.leave(); active = false
    resumeErrorTelemetry()
    assert.deepEqual(requests, [route("eventsInbox")])
    assert.equal(notices.some((notice) => /上报成功|已上传/.test(notice)), false)
  } finally { owner.leave(); setErrorTelemetryContext({ sessionKey: null }); globalThis.fetch = original; toast.add = beforeToast }
})

test("real inactive hook render, six pure local producer stages and general online recovery make zero inbox calls", async () => {
  const original = globalThis.fetch, beforeToast = toast.add
  const owners: Array<ReturnType<typeof usePublishDiagnostics>> = []
  let requests = 0
  setErrorTelemetryContext({ sessionKey: "local-stage-counter" })
  globalThis.fetch = async () => { requests++; throw new Error("pure local action cannot deliver any inbox kind") }
  toast.add = () => "local-stage-notice"
  try {
    for (const stage of ["import", "edit", "prepare", "validate", "build", "repair"]) {
      function Capture() { owners.push(usePublishDiagnostics(false, () => true)); return null }
      assert.equal(renderToStaticMarkup(createElement(Capture)), "")
      const detail = await capturePublishDiagnostic({ platform: "ozon", stage, code: "unexpected-local-contract" })
      assert.ok(detail?.event)
      owners.at(-1)!.enter()
      assert.equal(await owners.at(-1)!.report(detail.diagnosticId), false)
      resumeErrorTelemetry()
    }
    assert.equal(requests, 0)
  } finally { for (const owner of owners) owner.leave(); setErrorTelemetryContext({ sessionKey: null }); globalThis.fetch = original; toast.add = beforeToast }
})

test("explicit held report failure never claims success, resubmits business data or resets its bounded action", async () => {
  const owner = createPublishDiagnosticRoute(() => true), original = globalThis.fetch, beforeToast = toast.add
  const notices: string[] = [], requests: Array<{ url: string; body: string }> = []
  setErrorTelemetryContext({ sessionKey: "report-held-failure" })
  toast.add = (notice) => { notices.push(String(notice.title)); return "failure-notice" }
  globalThis.fetch = async (input, init) => {
    requests.push({ url: String(input), body: String(init?.body) })
    assert.equal(String(input), route("eventsInbox"))
    if (requests.length === 1) return new Response("", { status: 500 })
    const events = JSON.parse(String(init?.body)).events as Array<{ id: string }>
    return Response.json({ data: { accepted: events.map((event) => event.id), rejected: [] } })
  }
  try {
    const held = await capturePublishDiagnostic({ platform: "ozon", stage: "submit", family: "control", code: "result_unconfirmed" })
    assert.ok(held?.event)
    owner.enter()
    const first = owner.report(held.diagnosticId)
    assert.equal(await owner.report(held.diagnosticId), false, "a pending double click gets no second window")
    assert.equal(await first, true, "true means admission, not Cloud acceptance")
    resumeErrorTelemetry()
    assert.equal(requests.length, 1)
    assert.equal(notices.length, 1)
    assert.match(notices[0]!, /开启.*上报窗口.*仅发送脱敏诊断/)
    assert.doesNotMatch(notices.join(""), /上报成功|已上传/)

    assert.equal(await owner.report(held.diagnosticId), true, "a new explicit gesture may replace the failed window immediately")
    assert.equal(requests.length, 2)
    assert.deepEqual(requests.map((request) => request.url), [route("eventsInbox"), route("eventsInbox")])
    assert.equal(requests[1]!.body, requests[0]!.body, "the failed delivery retains the same normalized diagnostic")
    const events = JSON.parse(requests[1]!.body).events as Array<{ id: string; payload_json: string }>
    assert.equal(events.length, 1)
    assert.equal(events[0]!.id, held.diagnosticId)
    assert.equal(events[0]!.payload_json, JSON.stringify(held.event))
    createPublishDiagnosticAction("stop-owner", () => true).close()
    resumeErrorTelemetry()
    assert.equal(requests.length, 2, "Stop and general resume cannot send or reopen anything")
    assert.equal(await owner.report(held.diagnosticId), true, "a report after Stop is its own explicit gesture")
    assert.equal(requests.length, 2, "successful acknowledgement removed the held envelope")
    assert.doesNotMatch(notices.join(""), /上报成功|已上传/)
  } finally { owner.leave(); setErrorTelemetryContext({ sessionKey: null }); globalThis.fetch = original; toast.add = beforeToast }
})

test("Stop and offline preserve held diagnostics for a later explicit report without reviving the business action", async () => {
  for (const closure of ["Stop", "offline"] as const) {
    let active = true
    const connection = { onLine: true }
    const beforeNavigator = Object.getOwnPropertyDescriptor(globalThis, "navigator")
    const original = globalThis.fetch, beforeToast = toast.add
    const owner = createPublishDiagnosticRoute(() => active)
    let business: ReturnType<typeof createPublishDiagnosticAction> | undefined
    const requests: Array<{ url: string; method: string | undefined; body: string; signal: AbortSignal | null | undefined }> = []
    Object.defineProperty(globalThis, "navigator", { configurable: true, value: connection })
    setErrorTelemetryContext({ sessionKey: `explicit-report-after-${closure}` })
    toast.add = () => "closure-notice"
    globalThis.fetch = (input, init) => {
      requests.push({ url: String(input), method: init?.method, body: String(init?.body), signal: init?.signal })
      // The singleton must retire even an in-flight transport that ignores AbortSignal.
      if (requests.length === 1) return new Promise<Response>(() => {})
      const events = JSON.parse(String(init?.body)).events as Array<{ id: string }>
      return Promise.resolve(Response.json({ data: { accepted: events.map((event) => event.id), rejected: [] } }))
    }
    try {
      owner.enter()
      business = createPublishDiagnosticAction(`business-${closure}`, () => active)
      const token = business.context.action
      assert.ok(token)
      business.context.onDispatch()
      assert.equal(openDiagnosticPublishWindow(token, new AbortController().signal), null, "the original S16 token is already spent")
      const held = await capturePublishDiagnostic({ platform: "ozon", stage: "submit", family: "control", code: "result_unconfirmed" })
      assert.ok(held?.event)
      assert.equal(requests.length, 0, "capture alone cannot join the unrelated business window")
      const first = owner.report(held.diagnosticId)
      assert.equal(requests.length, 1)
      assert.equal(await owner.report(held.diagnosticId), false, "same-frame duplicate has no request or window")
      if (closure === "Stop") business.close()
      else {
        connection.onLine = false
        resumeErrorTelemetry() // The singleton's actual offline check closes its current window.
      }
      assert.equal(requests[0]!.signal?.aborted, true)
      assert.equal(await first, true, "admission is not an acknowledgement of the interrupted delivery")
      assert.equal(getDiagnosticDetail(held.diagnosticId).event?.diagnostic_id, held.diagnosticId)
      if (closure === "offline") assert.equal(await owner.report(held.diagnosticId), false, "an offline gesture cannot claim admission")
      assert.equal(requests.length, 1)
      connection.onLine = true
      business.context.onDispatch()
      resumeErrorTelemetry()
      assert.equal(requests.length, 1, "online/Continue/resume cannot revive the stopped action")
      assert.equal(openDiagnosticPublishWindow(token, new AbortController().signal), null)
      owner.leave(); active = false
      resumeErrorTelemetry()
      assert.equal(await owner.report(held.diagnosticId), false, "leaving the route denies even an explicit gesture")
      assert.equal(requests.length, 1)
      active = true; owner.enter()
      resumeErrorTelemetry()
      assert.equal(requests.length, 1, "returning to the route also remains local")
      const retry = owner.report(held.diagnosticId)
      assert.equal(requests.length, 2, "only this new explicit gesture reclaims the held envelope")
      assert.equal(await owner.report(held.diagnosticId), false)
      assert.equal(await retry, true)
      assert.equal(requests[1]!.body, requests[0]!.body)
      const events = JSON.parse(requests[1]!.body).events as Array<{ id: string; payload_json: string }>
      assert.deepEqual(events.map((event) => event.id), [held.diagnosticId])
      assert.equal(events[0]!.payload_json, JSON.stringify(held.event))
      assert.deepEqual(requests.map((request) => [request.url, request.method]), [[route("eventsInbox"), "POST"], [route("eventsInbox"), "POST"]],
        "report performs zero product send, release or Intent query requests")
      business.context.onDispatch()
      assert.equal(openDiagnosticPublishWindow(token, new AbortController().signal), null, "new report tokens do not reset business credit")
      assert.equal(requests.length, 2)
    } finally {
      business?.close(); owner.leave(); setErrorTelemetryContext({ sessionKey: null })
      globalThis.fetch = original; toast.add = beforeToast
      if (beforeNavigator) Object.defineProperty(globalThis, "navigator", beforeNavigator)
      else Reflect.deleteProperty(globalThis, "navigator")
    }
  }
})

test("identity switch before an explicit report fences its old detail and emits one useful denial", async () => {
  const owner = createPublishDiagnosticRoute(() => true), beforeToast = toast.add, original = globalThis.fetch
  const notices: string[] = []
  let calls = 0
  setErrorTelemetryContext({ sessionKey: "report-original-identity" })
  toast.add = (notice) => { notices.push(String(notice.title)); return "identity-notice" }
  globalThis.fetch = async () => { calls++; throw new Error("old identity must not report") }
  try {
    const held = await capturePublishDiagnostic({ platform: "ozon", stage: "submit", family: "control", code: "result_unconfirmed" })
    assert.ok(held?.event)
    owner.enter()
    setErrorTelemetryContext({ sessionKey: "report-new-identity" })
    assert.equal(await owner.report(held.diagnosticId), false)
    assert.equal(calls, 0)
    assert.equal(notices.length, 1)
    assert.match(notices[0]!, /原账户.*当前诊断.*明确上报/)
  } finally { owner.leave(); setErrorTelemetryContext({ sessionKey: null }); globalThis.fetch = original; toast.add = beforeToast }
})

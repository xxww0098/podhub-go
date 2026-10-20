import assert from "node:assert/strict"
import test from "node:test"
import { route } from "@/api/routes"
import type { AccountOverview } from "@/bindings/commands"
import { reportErrorFeedback } from "@/lib/error-feedback-reporting"
import { invalidateAllSessionCaches } from "@/lib/session-cache"
import {
  captureDiagnostic, createDiagnosticPublishAction, enterDiagnosticWorkflowRoute,
  getDiagnosticCopyData, getDiagnosticDetail, openDiagnosticPublishWindow, setErrorTelemetryContext,
} from "@/lib/error-telemetry"
import { normalizedProblem } from "@/lib/diagnostic-test-support"
import { invalidateAccountOverview, peekAccountOverview, rememberAccountOverview } from "./account-overview-cache"

function overview(): AccountOverview {
  const workspace = { id: 7, uuid: "workspace-7", name: "Test", plan: "free", role: "owner", is_owned: true }
  return { session: { authenticated: true, email: "op@example.invalid" },
    active_workspace: workspace, workspaces: [workspace], owned_count: 1, owned_limit: 3 }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}

for (const boundary of ["invalidate", "session-sweep", "anonymous-overview"] as const) {
  test(`${boundary} aborts old feedback and revokes diagnostic authority until a fresh overview`, async () => {
    const previousFetch = globalThis.fetch
    const started = deferred<void>()
    const held = deferred<Response>()
    const calls: Array<{ signal: AbortSignal; ids: string[] }> = []
    const leaveRoute = enterDiagnosticWorkflowRoute()
    const feedback = { errorId: "00000000000000000001", code: "cloud_unavailable" }
    globalThis.fetch = (async (input, init) => {
      assert.equal(String(input), route("eventsInbox"))
      const ids = JSON.parse(String(init?.body)).events.map((event: { id: string }) => event.id)
      calls.push({ signal: init!.signal!, ids })
      if (calls.length === 1) { started.resolve(); return held.promise }
      return Response.json({ data: { accepted: ids, rejected: [] } })
    }) as typeof fetch
    try {
      invalidateAccountOverview()
      rememberAccountOverview(overview())
      const diagnostic = await captureDiagnostic(normalizedProblem({
        exactOperation: { provenance: "native_freeze", jsonText: '{"name":"old session private"}' },
      }))
      assert.ok(diagnostic)
      const action = createDiagnosticPublishAction("before-" + boundary)
      assert.ok(action)
      reportErrorFeedback(feedback)
      await started.promise
      assert.equal(calls[0]!.signal.aborted, false)

      if (boundary === "invalidate") invalidateAccountOverview()
      else if (boundary === "session-sweep") invalidateAllSessionCaches()
      else rememberAccountOverview({ ...overview(), session: { authenticated: false } })

      assert.equal(peekAccountOverview(), null)
      assert.equal(calls[0]!.signal.aborted, true, "cache invalidation must abort old receipt delivery")
      assert.equal(getDiagnosticDetail(diagnostic.diagnosticId).event, null)
      assert.equal(getDiagnosticCopyData(diagnostic.diagnosticId).originalJson, null)
      assert.equal(await captureDiagnostic(normalizedProblem()), null)
      assert.equal(createDiagnosticPublishAction("after-" + boundary), null)
      assert.equal(openDiagnosticPublishWindow(action, new AbortController().signal), null)
      reportErrorFeedback({ ...feedback, errorId: "00000000000000000002" })
      held.resolve(Response.json({ data: { accepted: [], rejected: [] } }))
      await new Promise(resolve => setTimeout(resolve, 10))
      assert.equal(calls.length, 1, "late acknowledgements and new errors cannot revive the revoked session")

      rememberAccountOverview(overview())
      assert.ok(await captureDiagnostic(normalizedProblem()))
      reportErrorFeedback(feedback)
      await new Promise(resolve => setTimeout(resolve, 10))
      assert.equal(calls.length, 2, "a fresh overview restores reporting even for the same identity")
      assert.deepEqual(calls[1]!.ids, [feedback.errorId])
    } finally {
      setErrorTelemetryContext({ sessionKey: null })
      invalidateAccountOverview()
      leaveRoute()
      held.resolve(Response.json({ data: { accepted: [], rejected: [] } }))
      globalThis.fetch = previousFetch
    }
  })
}

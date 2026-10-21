import assert from "node:assert/strict"
import test from "node:test"
import { route } from "@/api/routes"
import { invalidateAccountOverview, peekAccountOverview, rememberAccountOverview } from "@/features/account/account-overview-cache"
import { diagnosticTestClock } from "@/lib/diagnostic-test-support"
import { reportErrorFeedback } from "@/lib/error-feedback-reporting"
import { overview } from "../../../../tests/account-fixtures"
import { record, withStubbedDevice } from "./executor-test-support"

for (const signedIn of [false, true]) {
  test(`preparation transport teardown retires queued feedback before restoring ${signedIn ? "the prior account" : "the anonymous context"}`, async () => {
    invalidateAccountOverview()
    const previousOverview = signedIn ? overview : null
    if (previousOverview) rememberAccountOverview(previousOverview)
    const previousFetch = globalThis.fetch
    const previousSetTimeout = globalThis.setTimeout, previousClearTimeout = globalThis.clearTimeout
    const time = diagnosticTestClock()
    globalThis.setTimeout = time.clock.setTimer as typeof setTimeout
    globalThis.clearTimeout = time.clock.clearTimer as typeof clearTimeout
    const stub = record(call => {
      assert.equal(call.url, route("eventsInbox"))
      return { accepted: call.body.events.map((event: { id: string }) => event.id), rejected: [] }
    })
    let restored = false
    try {
      await withStubbedDevice(async () => {
        assert.ok(peekAccountOverview()?.active_workspace?.uuid)
        reportErrorFeedback({ errorId: "00000000000000000001", code: "preparation_failed" })
      })
      assert.equal(stub.calls.length, 0, "the receipt is still queued while the fixture owns fetch")
      stub.restore()
      restored = true
      assert.equal(globalThis.fetch, previousFetch)
      // The original network guard is live here. A leaked timer must fail the
      // test even though best-effort receipt delivery catches fetch rejection.
      await time.advance(0)
      assert.deepEqual(peekAccountOverview(), previousOverview)
      assert.equal(stub.calls.length, 0)
    } finally {
      if (!restored) stub.restore()
      invalidateAccountOverview()
      globalThis.setTimeout = previousSetTimeout
      globalThis.clearTimeout = previousClearTimeout
    }
  })
}

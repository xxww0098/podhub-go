import assert from "node:assert/strict"
import test from "node:test"

import { BUSY_RETRY_DEFAULTS, busyDelayMs, isBusyRefusal, retryWhenBusy } from "./busy-retry"

function refusal(status: number, retryAfterMs?: number): Error {
  return Object.assign(new Error(`HTTP ${status}`), { code: "cloud_internal", remediation: null, status, retryAfterMs })
}

test("429 is busy; 503 only when Cloud said how long to wait", () => {
  assert.equal(isBusyRefusal(refusal(429)), true)
  assert.equal(isBusyRefusal(refusal(429, 1000)), true)
  assert.equal(isBusyRefusal(refusal(503, 1000)), true)
  assert.equal(isBusyRefusal(refusal(503)), false, "an origin refusal or unconfigured storage is not congestion")
  assert.equal(isBusyRefusal(refusal(400, 1000)), false)
  assert.equal(isBusyRefusal(new Error("network")), false)
  assert.equal(isBusyRefusal(undefined), false)
})

test("server hints are never shortened, including long hints and zero", () => {
  const fixed = () => 0.5
  for (const hint of [1000, 30_000, 120_000]) {
    for (const random of [0, 0.5, 0.999]) {
      const delay = busyDelayMs(refusal(429, hint) as never, 4, { random: () => random })
      assert.ok(delay >= hint && delay <= hint * 1.2)
    }
  }
  assert.equal(busyDelayMs(refusal(429, 0) as never, 0, { random: () => 0 }), BUSY_RETRY_DEFAULTS.baseDelayMs)
  assert.equal(busyDelayMs(refusal(429) as never, 0, { random: fixed }), BUSY_RETRY_DEFAULTS.baseDelayMs)
  assert.equal(busyDelayMs(refusal(429) as never, 2, { random: fixed }), BUSY_RETRY_DEFAULTS.baseDelayMs * 4)
  assert.equal(busyDelayMs(refusal(429) as never, 10, { random: fixed }), BUSY_RETRY_DEFAULTS.maxDelayMs)
  assert.equal(busyDelayMs(refusal(429, 1000) as never, 0, { random: () => 0 }), 1000)
})

test("complete and prepare grow a short hint and never undercut it", () => {
  const hint = 1000
  assert.equal(
    busyDelayMs(refusal(429, hint) as never, 0, { random: () => 0, paceShortHints: true }),
    hint,
  )
  const later = busyDelayMs(refusal(429, hint) as never, 4, { random: () => 0, paceShortHints: true })
  assert.ok(later > hint && later <= BUSY_RETRY_DEFAULTS.maxDelayMs)
  for (const random of [0, 0.5, 0.999]) {
    const delay = busyDelayMs(refusal(429, hint) as never, 3, { random: () => random, paceShortHints: true })
    assert.ok(delay >= hint && delay <= BUSY_RETRY_DEFAULTS.maxDelayMs)
  }
})

test("a long hint stays within 20% when short hints are paced", () => {
  for (const hint of [30_000, 120_000, 3_600_000]) {
    for (const random of [0, 0.5, 0.999]) {
      const delay = busyDelayMs(refusal(429, hint) as never, 4, {
        random: () => random,
        paceShortHints: true,
      })
      assert.ok(delay >= hint && delay <= hint * 1.2, `${hint} @ ${random} -> ${delay}`)
    }
  }
})

test("a busy answer is waited out and the same request asked again", async () => {
  const waits: number[] = []
  let calls = 0
  const value = await retryWhenBusy(
    async () => {
      calls += 1
      if (calls < 3) throw refusal(calls === 1 ? 429 : 503, 1000)
      return "ok"
    },
    { sleep: async (ms) => { waits.push(ms) }, random: () => 0.5 },
  )
  assert.equal(value, "ok")
  assert.equal(calls, 3)
  assert.deepEqual(waits, [1100, 1100])
})

test("Stop during a wait cannot run another request", async () => {
  let stopped = false
  let calls = 0
  await assert.rejects(retryWhenBusy(async () => {
    calls += 1
    throw refusal(429, 120_000)
  }, { maxWaitMs: Infinity, cancelled: () => stopped, sleep: async () => { stopped = true } }))
  assert.equal(calls, 1)
  await assert.rejects(retryWhenBusy(async () => { calls += 1 }, { cancelled: () => true }))
  assert.equal(calls, 1, "already stopped work never starts")
})

test("Stop surfaces as workflow_cancelled, not as the refusal it was waiting on", async () => {
  const cancelled = (reason: unknown) => (reason as { code?: string }).code === "workflow_cancelled"
  let stopped = false
  await assert.rejects(retryWhenBusy(async () => {
    throw refusal(429, 120_000)
  }, { maxWaitMs: Infinity, cancelled: () => stopped, sleep: async () => { stopped = true } }), cancelled)
  await assert.rejects(retryWhenBusy(async () => {
    stopped = true
    throw refusal(429, 1000)
  }, { cancelled: () => stopped, sleep: async () => {} }), cancelled)
  await assert.rejects(retryWhenBusy(async () => {}, { cancelled: () => true }), cancelled)
})

test("a continuing workflow retains server cooldown beyond the short retry budget", async () => {
  let calls = 0
  const waits: number[] = []
  const result = await retryWhenBusy(async () => {
    if (++calls <= 8) throw refusal(429, 30_000)
    return "done"
  }, { attempts: Infinity, maxWaitMs: Infinity, random: () => 0, sleep: async (ms) => { waits.push(ms) } })
  assert.equal(result, "done")
  assert.equal(calls, 9)
  assert.deepEqual(waits, Array(8).fill(30_000))
})

test("attempts and the total wait are both ceilings; the last refusal is what surfaces", async () => {
  let calls = 0
  await assert.rejects(
    retryWhenBusy(async () => { calls += 1; throw refusal(429, 1000) }, { attempts: 3, sleep: async () => {}, random: () => 0.5 }),
    (reason: unknown) => (reason as { status?: number }).status === 429,
  )
  assert.equal(calls, 3)

  calls = 0
  await assert.rejects(
    retryWhenBusy(
      async () => { calls += 1; throw refusal(429, 10_000) },
      { attempts: 10, maxWaitMs: 25_000, sleep: async () => {}, random: () => 0.5 },
    ),
  )
  assert.equal(calls, 3, "two 10 s waits fit under 25 s, a third does not")
})

test("a refusal that is not busy is thrown at once, and Stop ends the waiting", async () => {
  let calls = 0
  await assert.rejects(
    retryWhenBusy(async () => { calls += 1; throw refusal(400) }, { sleep: async () => {} }),
  )
  assert.equal(calls, 1)

  calls = 0
  let stopped = false
  await assert.rejects(
    retryWhenBusy(
      async () => { calls += 1; stopped = calls >= 2; throw refusal(429, 0) },
      { cancelled: () => stopped, sleep: async () => {} },
    ),
  )
  assert.equal(calls, 2)
})

test("a hint longer than the whole budget surfaces at once instead of being spun on", async () => {
  let calls = 0
  const waits: number[] = []
  await assert.rejects(
    retryWhenBusy(async () => { calls += 1; throw refusal(429, 3_600_000) },
      { sleep: async (ms) => { waits.push(ms) }, random: () => 0.5 }),
    (reason: unknown) => (reason as { status?: number }).status === 429,
  )
  assert.equal(calls, 1, "the first refusal is the answer")
  assert.deepEqual(waits, [], "an hour does not fit the default 60 s budget")
})

test("an unlimited budget waits out the relay's one-hour cooldown", async () => {
  let calls = 0
  const waits: number[] = []
  // The preparation rail's PREPARATION_BUSY_RETRY: the AI relay's hourly
  // unbilled ceiling must pause the row, not fail it, so the rail waits the
  // whole hint before asking again.
  const value = await retryWhenBusy(async () => {
    if (++calls <= 2) throw refusal(429, 3_600_000)
    return "done"
  }, { attempts: Infinity, maxWaitMs: Infinity, random: () => 0, sleep: async (ms) => { waits.push(ms) } })
  assert.equal(value, "done")
  assert.deepEqual(waits, [3_600_000, 3_600_000])
})

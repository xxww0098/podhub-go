import assert from "node:assert/strict"
import { test } from "node:test"
import { setImmediate as tick } from "node:timers/promises"
import { createLeaseScheduler } from "./lease-scheduler"
import { keepCommandLease, type LeaseReply } from "./command-lease"

type Scheduled = { run: () => void; ms: number; cancelled: boolean }

function harness(
  renew: (runtimeId: string, claims: Array<{ operationId: string; claimEpoch: number }>) => Promise<LeaseReply[]>,
  leaseSeconds = 90,
) {
  const scheduled: Scheduled[] = []
  const controls: string[] = []
  let clock = 0
  const lease = keepCommandLease({
    runtimeId: "runtime-1",
    operationId: "op-1",
    claimEpoch: 3,
    leaseSeconds,
    renew,
    onControl: (control) => controls.push(control),
    schedule: (run, ms) => {
      const item = { run, ms, cancelled: false }
      scheduled.push(item)
      return () => { item.cancelled = true }
    },
    now: () => clock,
  })
  return {
    lease,
    scheduled,
    controls,
    advance: (ms: number) => { clock += ms },
    run: async () => {
      for (let i = scheduled.length - 1; i >= 0; i -= 1) {
        const item = scheduled[i]
        if (item && !item.cancelled) {
          item.run()
          break
        }
      }
      await tick()
    },
  }
}

const reply = (control: LeaseReply["control"], leaseSeconds = 90): LeaseReply[] => [
  { operationId: "op-1", control, leaseSeconds },
]

test("renews at a third of the lease and stays in control", async () => {
  const h = harness(async () => reply("continue"))
  assert.equal(h.scheduled.length, 1)
  assert.equal(h.scheduled[0].ms, 30_000)
  await h.run()
  assert.equal(h.lease.control(), "continue")
  assert.deepEqual(h.controls, [])
})

test("a lost reply stops the timer and reports once", async () => {
  const h = harness(async () => reply("lost", 0))
  await h.run()
  assert.equal(h.lease.control(), "lost")
  assert.deepEqual(h.controls, ["lost"])
  assert.equal(h.scheduled[0].cancelled, true)
})

test("a cancel reply reports cancel but keeps the lease extendable", async () => {
  const h = harness(async () => reply("cancel"))
  await h.run()
  assert.equal(h.lease.control(), "cancel")
  assert.deepEqual(h.controls, ["cancel"])
  await h.run()
  assert.deepEqual(h.controls, ["cancel"])
})

test("an unconfirmed renewal before the deadline keeps the last confirmed lease", async () => {
  const h = harness(async () => { throw new Error("offline") })
  h.advance(1_000)
  await h.run()
  assert.equal(h.lease.control(), "continue")
  assert.deepEqual(h.controls, [])
})

test("an unconfirmed renewal past the deadline is treated as lost", async () => {
  const h = harness(async () => { throw new Error("offline") })
  h.advance(90_001)
  await h.run()
  assert.equal(h.lease.control(), "lost")
  assert.deepEqual(h.controls, ["lost"])
})

test("a reply that omits the claim is lost rather than silently continued", async () => {
  const h = harness(async () => [{ operationId: "someone-else", control: "continue", leaseSeconds: 90 }])
  await h.run()
  assert.equal(h.lease.control(), "lost")
  assert.deepEqual(h.controls, ["lost"])
})

test("two command leases on one runtime renew in one call", async () => {
  const scheduled: Array<{ run: () => void, ms: number, cancelled: boolean }> = []
  const scheduler = createLeaseScheduler((run, ms) => {
    const item = { run, ms, cancelled: false }
    scheduled.push(item)
    return () => { item.cancelled = true }
  })
  const batches: string[][] = []
  const renew = async (_runtimeId: string, claims: Array<{ operationId: string }>): Promise<LeaseReply[]> => {
    batches.push(claims.map((claim) => claim.operationId))
    return claims.map((claim) => ({ operationId: claim.operationId, control: "continue", leaseSeconds: 90 }))
  }
  const controls: string[] = []
  const shared = {
    runtimeId: "runtime-1",
    claimEpoch: 3,
    leaseSeconds: 90,
    renew,
    scheduler,
    onControl: (control: string) => controls.push(control),
    now: () => 0,
  }
  keepCommandLease({ ...shared, operationId: "op-1" })
  keepCommandLease({ ...shared, operationId: "op-2" })
  assert.equal(scheduled.length, 1)
  scheduled[0]?.run()
  await tick()
  assert.deepEqual(batches, [["op-1", "op-2"]])
  assert.deepEqual(controls, [])
})

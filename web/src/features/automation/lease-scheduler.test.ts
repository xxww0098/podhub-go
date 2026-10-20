import assert from "node:assert/strict"
import { test } from "node:test"
import { setImmediate as tick } from "node:timers/promises"
import { createLeaseScheduler } from "./lease-scheduler"

type Scheduled = { run: () => void, ms: number, cancelled: boolean }

function harness() {
  const scheduled: Scheduled[] = []
  const scheduler = createLeaseScheduler((run, ms) => {
    const item = { run, ms, cancelled: false }
    scheduled.push(item)
    return () => { item.cancelled = true }
  })
  return {
    scheduler,
    scheduled,
    fire: () => scheduled.find((item) => !item.cancelled)?.run(),
  }
}

test("one timer renews every due lease once", async () => {
  const h = harness()
  const seen: string[] = []
  h.scheduler.keep("a", 1_000, () => { seen.push("a") })
  h.scheduler.keep("b", 1_000, () => { seen.push("b") })
  assert.equal(h.scheduled.length, 1)
  assert.equal(h.scheduled[0]?.ms, 1_000)
  h.fire()
  await tick()
  assert.deepEqual(seen, ["a", "b"])
  h.fire()
  await tick()
  assert.deepEqual(seen, ["a", "b", "a", "b"])
})

test("a longer lease is not dropped and is not renewed on the short period", async () => {
  const h = harness()
  const seen: string[] = []
  h.scheduler.keep("short", 10, () => { seen.push("s") })
  h.scheduler.keep("long", 30, () => { seen.push("l") })
  assert.equal(h.scheduled.length, 1)
  assert.equal(h.scheduled[0]?.ms, 10)
  h.fire()
  await tick()
  h.fire()
  await tick()
  assert.deepEqual(seen, ["s", "s"])
  h.fire()
  await tick()
  assert.deepEqual(seen, ["s", "s", "s", "l"])
})

test("an in-flight renewal is not started again", async () => {
  const h = harness()
  let started = 0
  let release!: () => void
  const gate = new Promise<void>((resolve) => { release = resolve })
  h.scheduler.keep("a", 1_000, () => {
    started += 1
    return gate
  })
  h.fire()
  h.fire()
  assert.equal(started, 1)
  release()
  await tick()
  h.fire()
  await tick()
  assert.equal(started, 2)
})

test("stopping a lease renews nothing and the last stop releases the timer", async () => {
  const h = harness()
  let started = 0
  const stopA = h.scheduler.keep("a", 1_000, () => { started += 1 })
  const stopB = h.scheduler.keep("b", 1_000, () => { started += 1 })
  stopA()
  assert.equal(h.scheduled[0]?.cancelled, false)
  h.fire()
  await tick()
  assert.equal(started, 1)
  stopB()
  assert.equal(h.scheduled.filter((item) => !item.cancelled).length, 0)
})

test("a shorter lease joined later is not held for the longer period", () => {
  let clock = 1_000
  const scheduled: Scheduled[] = []
  const scheduler = createLeaseScheduler((run, ms) => {
    const item = { run, ms, cancelled: false }
    scheduled.push(item)
    return () => { item.cancelled = true }
  }, () => clock)
  const seen: string[] = []
  scheduler.keep("long", 30, () => { seen.push("l") })
  clock = 1_019
  scheduler.keep("short", 10, () => { seen.push("s") })
  const live = scheduled.filter((item) => !item.cancelled)
  assert.equal(live.length, 1)
  assert.equal(live[0]?.ms, 10)
  live[0]?.run()
  assert.deepEqual(seen, ["s"])
  const next = scheduled.filter((item) => !item.cancelled)
  assert.equal(next.length, 1)
  assert.equal(next[0]?.ms, 1)
})

test("a stopped lease's id can be kept again", () => {
  const h = harness()
  const stop = h.scheduler.keep("a", 1_000, () => {})
  stop()
  h.scheduler.keep("a", 1_000, () => {})
  assert.equal(h.scheduled.filter((item) => !item.cancelled).length, 1)
})

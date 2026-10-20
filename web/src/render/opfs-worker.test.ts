import assert from "node:assert/strict"
import test from "node:test"
import { OPFS_IO_PARALLEL, enqueueOpfsIo } from "./opfs-worker"

async function flush(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
}

test("serializes overlapping OPFS operations on one file and recovers after an error", async () => {
  const events: string[] = []
  let release!: () => void
  const first = enqueueOpfsIo("same", async () => {
    events.push("first-start")
    await new Promise<void>((resolve) => { release = resolve })
    events.push("first-end")
    throw new Error("expected failure")
  })
  const second = enqueueOpfsIo("same", async () => {
    events.push("second")
    return 2
  })
  await flush()
  assert.deepEqual(events, ["first-start"])
  release()
  await assert.rejects(first, /expected failure/)
  assert.equal(await second, 2)
  assert.deepEqual(events, ["first-start", "first-end", "second"])

  assert.equal(await enqueueOpfsIo("same", async () => 3), 3)
})

test("different files overlap and the cap holds the next one", async () => {
  const events: string[] = []
  const release: Array<() => void> = []
  const jobs = Array.from({ length: OPFS_IO_PARALLEL + 1 }, (_, index) => enqueueOpfsIo(`file-${index}`, async () => {
    events.push(`start-${index}`)
    await new Promise<void>((resolve) => { release[index] = resolve })
    events.push(`end-${index}`)
    return index
  }))
  try {
    await flush()
    assert.deepEqual(events, Array.from({ length: OPFS_IO_PARALLEL }, (_, index) => `start-${index}`))
    release[0]!()
    await flush()
    assert.ok(events.includes(`start-${OPFS_IO_PARALLEL}`), events.join(","))
    assert.equal(events.filter((event) => event.startsWith("start-")).length, OPFS_IO_PARALLEL + 1)
  } finally {
    for (const done of release) done?.()
    await Promise.all(jobs)
  }
})

test("a slice wave's files are in flight together", async () => {
  let active = 0
  let peak = 0
  const release: Array<() => void> = []
  const jobs = Array.from({ length: 8 }, (_, index) => enqueueOpfsIo(`wave-${index}`, async () => {
    active += 1
    peak = Math.max(peak, active)
    await new Promise<void>((resolve) => { release[index] = resolve })
    active -= 1
  }))
  try {
    await flush()
    assert.equal(active, OPFS_IO_PARALLEL)
    assert.equal(peak, OPFS_IO_PARALLEL)
  } finally {
    // Releasing the in-flight wave starts the rest. Drain each wave or the
    // held jobs never settle.
    for (let wave = 0; wave < jobs.length; wave++) {
      const pending = release.splice(0, release.length)
      for (const done of pending) done?.()
      await flush()
    }
    await Promise.all(jobs)
  }
})

import { enqueueOpfsPreview, readAll, storeAll, writeAll } from "./opfs-worker"

type FakeAccess = {
  reads: number
  writes: number
  truncates: number[]
  flushes: number
  read: (buffer: Uint8Array, options?: { at?: number }) => number
  write: (buffer: Uint8Array, options?: { at?: number }) => number
  truncate: (size: number) => void
  flush: () => void
}

function fakeAccess(behavior: {
  readChunks?: number[]
  writeChunks?: number[]
  writeError?: Error
}): FakeAccess {
  const access: FakeAccess = {
    reads: 0,
    writes: 0,
    truncates: [],
    flushes: 0,
    read(buffer) {
      access.reads += 1
      const granted = behavior.readChunks?.[access.reads - 1] ?? buffer.length
      return Math.min(granted, buffer.length)
    },
    write(buffer) {
      access.writes += 1
      if (behavior.writeError) throw behavior.writeError
      const granted = behavior.writeChunks?.[access.writes - 1] ?? buffer.length
      return Math.min(granted, buffer.length)
    },
    truncate(size) {
      access.truncates.push(size)
    },
    flush() {
      access.flushes += 1
    },
  }
  return access
}

test("a short read is rejected instead of cached as a complete entry", () => {
  const access = fakeAccess({ readChunks: [2, 0] })
  assert.throws(() => readAll(access as never, 5), /short read: 2 of 5/)
})

test("a partial read is completed by following reads", () => {
  const access = fakeAccess({ readChunks: [2, 3] })
  assert.equal(readAll(access as never, 5).length, 5)
  assert.equal(access.reads, 2)
})

test("a short write is retried and a stalled write fails", () => {
  const access = fakeAccess({ writeChunks: [2, 3] })
  writeAll(access as never, new Uint8Array(5))
  assert.equal(access.writes, 2)

  const stalled = fakeAccess({ writeChunks: [2, 0] })
  assert.throws(() => writeAll(stalled as never, new Uint8Array(5)), /short write: 2 of 5/)
})

test("a failed write truncates the partial file and keeps the error name", () => {
  const quota = Object.assign(new Error("disk is full"), { name: "QuotaExceededError" })
  const access = fakeAccess({ writeError: quota })
  assert.throws(
    () => storeAll(access as never, new Uint8Array(5)),
    (error: Error) => error === quota && error.name === "QuotaExceededError",
  )
  assert.deepEqual(access.truncates, [0, 0])
  assert.equal(access.flushes, 0)
})

test("a stalled store truncates the partial file before failing", () => {
  const access = fakeAccess({ writeChunks: [2, 0] })
  assert.throws(() => storeAll(access as never, new Uint8Array(5)), /short write: 2 of 5/)
  assert.deepEqual(access.truncates, [0, 0])
})

test("previews use their own lane: ioQueue work is never queued behind them", async () => {
  const events: string[] = []
  let release!: () => void
  const gate = new Promise<void>((resolve) => { release = resolve })
  const previews = [
    enqueueOpfsPreview(async () => { events.push("p1-start"); await gate; events.push("p1-end") }),
    enqueueOpfsPreview(async () => { events.push("p2-start"); await gate; events.push("p2-end") }),
    enqueueOpfsPreview(async () => { events.push("p3-start"); await gate; events.push("p3-end") }),
  ]
  // The third preview waits on a preview slot, but critical I/O runs now.
  const read = enqueueOpfsIo("read", async () => { events.push("read"); return 1 })
  await Promise.resolve()
  await Promise.resolve()
  assert.deepEqual(events, ["p1-start", "p2-start", "read"])
  assert.equal(await read, 1)
  release()
  await Promise.all(previews)
  assert.deepEqual(events.slice(3), ["p1-end", "p2-end", "p3-start", "p3-end"])
})

test("a saturated preview backlog refuses instead of growing without bound", async () => {
  const gate = new Promise<void>(() => {})
  const held = Array.from({ length: 2 }, () => enqueueOpfsPreview(() => gate))
  const queued = Array.from({ length: 32 }, () => enqueueOpfsPreview(() => gate))
  await assert.rejects(
    enqueueOpfsPreview(async () => 1),
    (error: Error) => error.name === "PreviewBusyError",
  )
  for (const promise of [...held, ...queued]) void promise.catch(() => undefined)
})

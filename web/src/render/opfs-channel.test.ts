import assert from "node:assert/strict"
import test from "node:test"
import { openOpfsChannel, OpfsChannelDead } from "./opfs-channel"

/**
 * A fake Worker good enough to drive the channel end to end: it answers
 * `probe` immediately so `openOpfsChannel` resolves to the real channel, and
 * lets a test name which ops never get a reply at all — the "wedged inside a
 * sync OPFS lock" case the watchdog exists for. Modelled on the
 * `RuntimeWorker` fake in `client.test.ts`, minus the message-transform
 * machinery this channel does not need.
 */
class FakeWorker extends EventTarget {
  calls: { id: number, op: string }[] = []
  terminated = false
  silent = new Set<string>()
  postMessage(message: { id: number, op: string }) {
    this.calls.push(message)
    if (this.silent.has(message.op)) return
    queueMicrotask(() => this.emit({ id: message.id, ok: true, value: message.op === "probe" ? true : null }))
  }
  emit(data: unknown) {
    this.dispatchEvent(new MessageEvent("message", { data }))
  }
  terminate() {
    this.terminated = true
  }
}

/** Swap the fake in for the ambient `Worker` the module constructs directly. */
function installFakeWorker(worker: FakeWorker): () => void {
  const previous = Object.getOwnPropertyDescriptor(globalThis, "Worker")
  Object.defineProperty(globalThis, "Worker", {
    configurable: true,
    value: function (this: unknown) { return worker } as unknown as typeof Worker,
  })
  return () => {
    if (previous) Object.defineProperty(globalThis, "Worker", previous)
    else Reflect.deleteProperty(globalThis, "Worker")
  }
}

/** A minimal stand-in for a big write's payload: only `.length` is read. */
function bytesOfLength(length: number): Uint8Array {
  return { length } as unknown as Uint8Array
}

test("a call past its deadline dies the channel and rejects every other pending call with it", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] })
  const worker = new FakeWorker()
  worker.silent.add("write")
  worker.silent.add("preview")
  const restore = installFakeWorker(worker)
  try {
    const channel = await openOpfsChannel()
    assert.ok(channel, "probe answers immediately, so the channel must open")

    const stuckWrite = channel.write(["templates"], "a.psd", bytesOfLength(0))
    const stuckPreview = channel.preview(["sources", "d1"], "b.jpg", 64)
    await Promise.resolve()
    assert.equal(worker.terminated, false, "neither call has missed its deadline yet")

    t.mock.timers.tick(30_000)

    await assert.rejects(stuckWrite, OpfsChannelDead)
    await assert.rejects(stuckPreview, OpfsChannelDead, "a wedged worker fails every pending call, not just the one that timed out")
    assert.equal(worker.terminated, true, "a timeout must kill the worker thread, not just the pending promises")

    // A dead channel must not hang the next caller either.
    await assert.rejects(
      channel.read(["templates"], "c.psd"),
      OpfsChannelDead,
      "a call made after the channel died must fail immediately, never hang",
    )
  } finally {
    restore()
  }
})

test("a normal reply before the deadline clears the timer and resolves as usual", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] })
  const worker = new FakeWorker()
  const restore = installFakeWorker(worker)
  try {
    const channel = await openOpfsChannel()
    assert.ok(channel)
    const write = channel.write(["templates"], "a.psd", bytesOfLength(3))
    await write
    // If the write's timer had not been cleared, ticking past its deadline
    // would call `die()` and terminate a worker that already finished cleanly.
    t.mock.timers.tick(60_000)
    assert.equal(worker.terminated, false)
  } finally {
    restore()
  }
})

test("a 254 MiB write keeps the documented ~55s budget: neither too eager nor unbounded", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] })
  const worker = new FakeWorker()
  worker.silent.add("write")
  const restore = installFakeWorker(worker)
  try {
    const channel = await openOpfsChannel()
    assert.ok(channel)
    const write = channel.write(["templates"], "big.psd", bytesOfLength(254 * 1024 * 1024))
    let settled = false
    write.catch(() => { settled = true })

    // 30s base + 254 MiB / 10 MiB/s = 30s + 25.4s = 55.4s, per the slice's own worked example.
    t.mock.timers.tick(55_399)
    await Promise.resolve()
    assert.equal(settled, false, "a 254 MiB write must not time out a moment before its budget")

    t.mock.timers.tick(1)
    await assert.rejects(write, OpfsChannelDead)
  } finally {
    restore()
  }
})

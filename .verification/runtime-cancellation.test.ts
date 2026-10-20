import assert from "node:assert/strict"
import test from "node:test"
import { createRuntimeHost } from "./threaded-client"
import type { RenderLane } from "./client"

type Request = { id: number; op: string; owner?: number; leaseId?: number; key?: string }
const tick = () => new Promise<void>(resolve => setTimeout(resolve, 0))
async function flush() { for (let i = 0; i < 4; i++) await tick() }
function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((ok, no) => { resolve = ok; reject = no })
  return { promise, resolve, reject }
}

// Protocol fixture only: it does not implement admission or copy Rust state.
class WorkerFixture extends EventTarget {
  calls: Request[] = []
  terminated = false
  holdInit = true
  holdRelease = false
  postMessage(message: Request, transfer: Transferable[] = []) {
    const input = structuredClone(message, { transfer })
    this.calls.push(input)
    if (input.op === "external" || input.op === "shutdown") return
    if (input.op === "init" && this.holdInit) return
    if (input.op === "release" && this.holdRelease) return
    queueMicrotask(() => this.reply(input))
  }
  reply(input: Request, error?: string) {
    this.dispatchEvent(new MessageEvent("message", { data: {
      id: input.id, ok: !error, ...(error ? { code: "RENDER_RUNTIME_CONFIG", message: error } : {}),
      value: input.op === "acquire" ? { leaseId: input.id, template: { sha256: input.key, id: 7 } } : undefined,
      stats: { memoryBytes: 100, occupiedBytes: 100, active: 0, queued: 0, templates: 0, peaks: {} },
    } }))
  }
  init(error?: string) {
    this.holdInit = false
    const request = this.calls.find(call => call.op === "init")
    if (request) this.reply(request, error)
  }
  terminate() { this.terminated = true }
  worker() { return this as unknown as Worker }
}

function fixture(worker = new WorkerFixture()) {
  const host = createRuntimeHost({ spawn: () => worker.worker(), maxLanes: 2, budgetBytes: 1000, requestTimeoutMs: 1000 })
  return { worker, host, a: host.createBatch(), b: host.createBatch() }
}

test("disposing one owner rejects every init waiter without stopping shared initialization", async () => {
  const { worker, a, b } = fixture()
  let enteredA = 0, settledA = 0, settledB = false
  const stopped = Array.from({ length: 4 }, () => a.withLane("T", async () => { enteredA++; return 1 })
    .then(() => { throw new Error("cancelled init returned a value") }, error => {
      assert.equal(error.code, "RENDER_CANCELLED"); settledA++
    }))
  const survivor = b.withLane("T", async () => 7).then(value => { settledB = true; return value })
  void survivor.catch(() => {})
  try {
    await flush()
    assert.equal(worker.calls.filter(call => call.op === "init").length, 1)
    a.dispose(); a.dispose()
    await flush()
    assert.equal(settledA, 4, "cancelled callers must settle before init reply")
    assert.equal(settledB, false)
    assert.equal(enteredA, 0)
    assert.equal(worker.terminated, false)
    assert.equal(worker.calls.some(call => call.op === "acquire"), false)
    worker.init()
    assert.equal(await survivor, 7)
    await Promise.all(stopped)
    assert.equal(worker.calls.filter(call => call.op === "acquire").length, 1)
  } finally {
    worker.init()
    a.dispose(); b.dispose()
    await Promise.allSettled([...stopped, survivor])
  }
})

test("late shared init failure cannot replace the disposed owner's cancellation", async () => {
  const { worker, a, b } = fixture()
  const outcomes: string[] = []
  const stopped = a.withLane("T", async () => 1).then(() => outcomes.push("success"), error => outcomes.push(error.code))
  const survivor = b.withLane("T", async () => 7)
  const failed = assert.rejects(survivor)
  try {
    await flush()
    a.dispose()
    await flush()
    assert.deepEqual(outcomes, ["RENDER_CANCELLED"], "cancellation must precede a late init error")
    worker.init("fixture initialization failed")
    await Promise.all([stopped, failed])
    assert.deepEqual(outcomes, ["RENDER_CANCELLED"])
    assert.equal(worker.terminated, true)
  } finally {
    worker.init("cleanup")
    a.dispose(); b.dispose()
    await Promise.allSettled([stopped, failed])
  }
})

for (const ending of ["resolve", "reject"] as const) {
  test(`disposed callback cannot deliver a late ${ending} and releases its lease once`, async () => {
    const worker = new WorkerFixture(); worker.holdInit = false
    const { a, b } = fixture(worker)
    const work = deferred<number>()
    let lane: RenderLane | undefined, settled = false
    const job = a.withLane("T", async value => { lane = value; return work.promise })
    const stopped = assert.rejects(job, { code: "RENDER_CANCELLED" }).then(() => { settled = true })
    try {
      await flush()
      assert.ok(lane)
      a.dispose()
      await flush()
      assert.equal(settled, true, "disposed callback must settle before its external work")
      assert.equal(lane!.heldTemplate(), undefined)
      const bytes = new Uint8Array([1, 2, 3])
      await assert.rejects(lane!.retainTemplate("T", bytes), { code: "RENDER_CANCELLED" })
      assert.equal(bytes.length, 3, "revoked cached fast path must not transfer inputs")
      if (ending === "resolve") work.resolve(123)
      else work.reject(new Error("late callback rejection"))
      await stopped
      await flush()
      assert.equal(worker.calls.filter(call => call.op === "release").length, 1)
      assert.equal(await b.withLane("T", async () => 7), 7)
      assert.equal(worker.terminated, false)
    } finally {
      work.resolve(0)
      a.dispose(); b.dispose()
      await Promise.allSettled([job, stopped])
    }
  })
}

test("cancelling while release waits does not wait for its acknowledgement", async () => {
  const worker = new WorkerFixture(); worker.holdInit = false; worker.holdRelease = true
  const { a, b } = fixture(worker)
  let outcome = "waiting"
  const job = a.withLane("T", async () => 123).then(() => { outcome = "success" }, error => { outcome = error.code })
  try {
    await flush()
    assert.equal(worker.calls.filter(call => call.op === "release").length, 1)
    a.dispose()
    await flush()
    assert.equal(outcome, "RENDER_CANCELLED", "cleanup acknowledgement must not delay cancellation")
    assert.equal(worker.terminated, false)
    worker.reply(worker.calls.find(call => call.op === "release")!)
    await job
    assert.equal(outcome, "RENDER_CANCELLED")
    assert.equal(worker.calls.filter(call => call.op === "release").length, 1)
  } finally {
    a.dispose(); b.dispose()
    await Promise.allSettled([job])
  }
})

test("normal callback errors keep their identity and still release once", async () => {
  const worker = new WorkerFixture(); worker.holdInit = false
  const { a, b } = fixture(worker)
  const error = new Error("original callback error")
  try {
    await assert.rejects(a.withLane("T", async () => { throw error }), actual => actual === error)
    assert.equal(worker.calls.filter(call => call.op === "release").length, 1)
    assert.equal(await b.withLane("T", async () => 7), 7)
  } finally { a.dispose(); b.dispose() }
})

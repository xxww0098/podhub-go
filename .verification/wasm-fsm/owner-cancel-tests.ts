import assert from "node:assert/strict"
import test from "node:test"
import { createRuntimeHost } from "./threaded-client"
import type { RenderLane } from "./client"

type Request = { id: number; op: string; owner?: number; leaseId?: number }
const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve() }
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}

// Only transport/lifetime behavior is simulated. Admission and resource
// ownership are verified against the real Rust state machine separately.
class HeldWorker extends EventTarget {
  calls: Request[] = []
  held = new Set<string>()
  terminated = false
  postMessage(input: Request, transfer: Transferable[] = []) {
    if (this.terminated) throw new Error("terminated")
    const request = structuredClone(input, { transfer })
    this.calls.push(request)
    if (["external", "shutdown", "listing-log-collect"].includes(request.op) || this.held.has(request.op)) return
    queueMicrotask(() => this.reply(request))
  }
  reply(request: Request, ok = true) {
    this.dispatchEvent(new MessageEvent("message", { data: {
      id: request.id, ok,
      value: request.op === "acquire" ? { leaseId: request.id, template: null } : undefined,
      ...(ok ? {} : { code: "RENDER_FAILED", message: "initialization failed" }),
    } }))
  }
  terminate() { this.terminated = true }
  asWorker() { return this as unknown as Worker }
}

function observed<T>(promise: Promise<T>) {
  const state = { result: "pending" as string }
  const done = promise.then(
    () => { state.result = "resolved" },
    (error: { code?: string }) => { state.result = error.code ?? "rejected" },
  )
  return { state, done }
}

test("disposing during shared initialization rejects before initialization completes", async () => {
  const worker = new HeldWorker()
  worker.held.add("init")
  const host = createRuntimeHost({ spawn: () => worker.asWorker(), maxLanes: 2, budgetBytes: 1000 })
  const a = host.createBatch(), b = host.createBatch()
  let read = false
  const stopped = observed(a.withLane("T", async () => { read = true }))
  try {
    await flush()
    assert.ok(worker.calls.some(request => request.op === "init"))
    a.dispose(); a.dispose()
    await flush()
    assert.equal(stopped.state.result, "RENDER_CANCELLED", "owner must not wait for shared initialization")
    assert.equal(read, false)
    assert.equal(worker.terminated, false, "another owner retains the runtime")
    worker.reply(worker.calls.find(request => request.op === "init")!)
    await b.withLane("T", async () => {})
    assert.equal(worker.calls.filter(request => request.op === "acquire").length, 1)
    assert.equal(worker.calls.find(request => request.op === "acquire")?.owner, 2)
    assert.equal(read, false, "late readiness cannot admit the disposed owner")
  } finally { a.dispose(); b.dispose(); await stopped.done }
})

test("disposing while a callback awaits rejects its caller and suppresses its late result", async () => {
  const worker = new HeldWorker()
  const host = createRuntimeHost({ spawn: () => worker.asWorker(), maxLanes: 2, budgetBytes: 1000 })
  const a = host.createBatch(), b = host.createBatch()
  const gate = deferred<number>()
  let lane: RenderLane | undefined
  const stopped = observed(a.withLane("T", async value => { lane = value; return gate.promise }))
  try {
    await flush()
    assert.ok(lane)
    a.dispose()
    await flush()
    assert.equal(stopped.state.result, "RENDER_CANCELLED", "owner must not wait for a caller callback")
    const bytes = new Uint8Array([1, 2, 3])
    await assert.rejects(async () => lane!.prepareAiImage(bytes), { code: "RENDER_CANCELLED" })
    assert.equal(bytes.byteLength, 3, "cancelled calls must not detach input buffers")
    await b.withLane("T", async () => {})
    assert.equal(worker.terminated, false)
    gate.resolve(42)
    await flush()
    assert.equal(stopped.state.result, "RENDER_CANCELLED", "late callback success cannot revive the owner")
    const lease = worker.calls.find(request => request.op === "acquire" && request.owner === 1)!.id
    assert.equal(worker.calls.filter(request => request.op === "release" && request.leaseId === lease).length, 1)
  } finally { gate.resolve(42); a.dispose(); b.dispose(); await stopped.done }
})

test("disposing while release is acknowledged does not hold the caller behind cleanup", async () => {
  const worker = new HeldWorker()
  worker.held.add("release")
  const host = createRuntimeHost({ spawn: () => worker.asWorker(), maxLanes: 2, budgetBytes: 1000 })
  const a = host.createBatch(), b = host.createBatch()
  const stopped = observed(a.withLane("T", async () => 42))
  try {
    await flush()
    const release = worker.calls.find(request => request.op === "release")
    assert.ok(release)
    a.dispose()
    await flush()
    assert.equal(stopped.state.result, "RENDER_CANCELLED", "owner must not wait for the release acknowledgement")
    assert.equal(worker.terminated, false)
    worker.held.delete("release")
    worker.reply(release)
    await b.withLane("T", async () => {})
    assert.equal(stopped.state.result, "RENDER_CANCELLED")
  } finally { a.dispose(); b.dispose(); await stopped.done }
})

test("late initialization failure remains observed after one owner cancels", async () => {
  const worker = new HeldWorker()
  worker.held.add("init")
  const host = createRuntimeHost({ spawn: () => worker.asWorker(), maxLanes: 2, budgetBytes: 1000 })
  const a = host.createBatch(), b = host.createBatch()
  const stopped = observed(a.withLane("T", async () => {}))
  const remaining = observed(b.withLane("T", async () => {}))
  try {
    await flush()
    a.dispose()
    await flush()
    assert.equal(stopped.state.result, "RENDER_CANCELLED")
    worker.reply(worker.calls.find(request => request.op === "init")!, false)
    await remaining.done
    assert.notEqual(remaining.state.result, "resolved")
    assert.notEqual(remaining.state.result, "pending")
    assert.equal(stopped.state.result, "RENDER_CANCELLED")
    assert.equal(worker.terminated, true)
  } finally { a.dispose(); b.dispose(); await Promise.all([stopped.done, remaining.done]) }
})

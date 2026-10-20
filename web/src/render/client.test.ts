import assert from "node:assert/strict"
import { test } from "node:test"
import { createPreparationClient } from "./client"
import { createRuntimeHost } from "./threaded-client"

type Request = { id: number; op: string; owner?: number; key?: string; leaseId?: number; bytes?: Uint8Array<ArrayBuffer> | number }
const tick = () => new Promise(resolve => setTimeout(resolve, 0))
async function until(check: () => boolean) {
  for (let i = 0; i < 50 && !check(); i++) await tick()
  assert.ok(check(), "expected message did not arrive")
}

/** Protocol stub, not a duplicate scheduler: admission decisions are supplied
 * by each test. Rust's actual FIFO/budget/cancellation tests live in scheduler.rs. */
class RuntimeWorker extends EventTarget {
  calls: Request[] = []
  silent = new Set<string>()
  throwOp = ""
  terminated = false
  memory = 100
  held = false
  postMessage(input: Request, transfer: Transferable[] = []) {
    if (input.op === this.throwOp) throw new Error("postMessage failed")
    if (this.terminated) return
    const message = structuredClone(input, { transfer })
    this.calls.push(message)
    if (message.op === "external" || message.op === "shutdown" || this.silent.has(message.op)) return
    queueMicrotask(() => this.reply(message))
  }
  reply(message: Request) {
    let value: unknown
    if (message.op === "acquire") value = { leaseId: message.id, template: this.held ? { sha256: message.key, id: 7 } : null }
    if (message.op === "retain") { this.held = true; value = 7 }
    if (message.op === "prepare") value = message.bytes
    if (message.op === "render") value = { slices: [], manifest: {} }
    this.emit({ id: message.id, ok: true, value, stats: { memoryBytes: this.memory, occupiedBytes: this.memory, active: 0, queued: 0, templates: this.held ? 1 : 0, peaks: {} } })
  }
  emit(data: unknown) { this.dispatchEvent(new MessageEvent("message", { data })) }
  terminate() { this.terminated = true }
  asWorker() { return this as unknown as Worker }
}

test("batch creation is lazy and Rust admission precedes reading image bytes", async () => {
  const worker = new RuntimeWorker()
  worker.silent.add("acquire")
  let spawned = 0
  const host = createRuntimeHost({ spawn: () => { spawned++; return worker.asWorker() }, maxLanes: 2, budgetBytes: 1000 })
  const batch = host.createBatch()
  assert.equal(spawned, 0)
  let read = false
  const job = batch.withLane("T", async lane => {
    read = true
    const bytes = new Uint8Array([1, 2, 3])
    assert.equal(await lane.retainTemplate("T", bytes), 7)
    assert.equal(bytes.byteLength, 0, "inputs cross the Worker boundary by transfer")
  })
  await until(() => worker.calls.some(c => c.op === "acquire"))
  assert.equal(read, false)
  worker.reply(worker.calls.find(c => c.op === "acquire")!)
  await job
  assert.equal(read, true)
  batch.dispose()
  assert.equal(worker.terminated, true)
  assert.equal(host.measure().residentBytes, 0)
})

test("shared template grants skip retain and do not detach unused bytes", async () => {
  const worker = new RuntimeWorker()
  worker.held = true
  const host = createRuntimeHost({ spawn: () => worker.asWorker(), maxLanes: 2, budgetBytes: 1000 })
  const a = host.createBatch(), b = host.createBatch()
  await a.withLane("T", async lane => {
    const bytes = new Uint8Array(9)
    assert.equal(await lane.retainTemplate("T", bytes), 7)
    assert.equal(bytes.length, 9)
    await assert.rejects(lane.retainTemplate("other", bytes), { code: "RENDER_TEMPLATE_FINGERPRINT" })
  })
  a.dispose()
  assert.equal(worker.terminated, false, "B still owns the shared runtime")
  await b.withLane("T", async lane => assert.equal(lane.heldTemplate()?.id, 7))
  assert.equal(worker.calls.filter(c => c.op === "retain").length, 0)
  b.dispose()
  assert.equal(worker.terminated, true)
})

test("disposing a Rust waiter rejects it without reading PSD or cancelling another owner", async () => {
  const worker = new RuntimeWorker()
  worker.silent.add("acquire")
  const host = createRuntimeHost({ spawn: () => worker.asWorker(), maxLanes: 1, budgetBytes: 1000 })
  const a = host.createBatch(), b = host.createBatch()
  let read = false
  const stopped = assert.rejects(a.withLane("T", async () => { read = true }), { code: "RENDER_CANCELLED" })
  await until(() => worker.calls.some(c => c.op === "acquire"))
  a.dispose()
  await stopped
  await assert.rejects(a.withLane("T", async () => {}), { code: "RENDER_CANCELLED" })
  assert.equal(read, false)
  assert.equal(worker.terminated, false)
  worker.silent.clear()
  await b.withLane("T", async () => {})
  b.dispose()
})

for (const mode of ["fatal", "error", "messageerror", "send"] as const) {
  test(`${mode} destroys the whole runtime, invalidates handles and permits fresh work`, async () => {
    const workers: RuntimeWorker[] = []
    const host = createRuntimeHost({ spawn: () => { const w = new RuntimeWorker(); workers.push(w); return w.asWorker() }, maxLanes: 2, budgetBytes: 1000 })
    const batch = host.createBatch()
    await assert.rejects(batch.withLane("T", async lane => {
      const id = await lane.retainTemplate("T", new Uint8Array(3))
      const worker = workers[0]
      worker.silent.add("render")
      if (mode === "send") worker.throwOp = "render"
      const job = lane.renderProduct(id, new Uint8Array(2), "x.png")
      if (mode === "fatal") worker.emit({ fatal: true, message: "compute trap" })
      else if (mode !== "send") worker.dispatchEvent(new Event(mode))
      try { await job } finally { assert.equal(lane.heldTemplate(), undefined) }
    }))
    assert.equal(workers[0].terminated, true)
    await batch.withLane("T", async lane => {
      assert.equal(lane.heldTemplate(), undefined)
      await lane.retainTemplate("T", new Uint8Array(3))
    })
    assert.equal(workers.length, 2)
    workers[0].emit({ id: 1, ok: true, stats: { memoryBytes: 99999 } })
    assert.equal(host.measure().residentBytes, 100, "late old-generation replies cannot revive memory or handles")
    batch.dispose()
  })
}

test("abandoning running compute keeps its watchdog so other owners cannot hang forever", async () => {
  const worker = new RuntimeWorker()
  worker.silent.add("render")
  const host = createRuntimeHost({ spawn: () => worker.asWorker(), maxLanes: 2, budgetBytes: 1000, requestTimeoutMs: 30 })
  const a = host.createBatch(), b = host.createBatch()
  const stopped = assert.rejects(a.withLane("T", lane => lane.renderProduct(7, new Uint8Array(2), "x")), { code: "RENDER_CANCELLED" })
  await until(() => worker.calls.some(c => c.op === "render"))
  a.dispose()
  await stopped
  await until(() => worker.terminated)
  assert.equal(host.measure().residentBytes, 0)
  b.dispose()
})

test("failed construction and initialization leave no runtime that can trap later work", async () => {
  let attempts = 0
  const workers: RuntimeWorker[] = []
  const host = createRuntimeHost({ maxLanes: 1, budgetBytes: 1000, requestTimeoutMs: 20, spawn: () => {
    if (++attempts === 1) throw new Error("cannot construct")
    const worker = new RuntimeWorker()
    if (attempts === 2) worker.silent.add("init")
    workers.push(worker)
    return worker.asWorker()
  } })
  const batch = host.createBatch()
  await assert.rejects(batch.withLane("T", async () => {}), /cannot construct/)
  await assert.rejects(batch.withLane("T", async () => {}), { code: "RENDER_WATCHDOG" })
  await batch.withLane("T", async () => {})
  assert.equal(attempts, 3)
  assert.equal(workers[0].terminated, true)
  batch.dispose()
})

test("AI lifetime is independent and both WASM schedulers receive external memory changes", async () => {
  const workers: RuntimeWorker[] = []
  const client = createPreparationClient({ maxLanes: 2, budgetBytes: 1000, spawn: () => {
    const worker = new RuntimeWorker(); worker.memory = workers.length ? 200 : 450
    workers.push(worker); return worker.asWorker()
  } })
  const batch = client.createBatch()
  await batch.withLane("T", async () => {})
  assert.deepEqual(await batch.prepareAiImage(new Uint8Array([3, 8])), new Uint8Array([3, 8]))
  const release = batch.occupy(100)
  assert.equal(client.measure().residentBytes, 750)
  assert.equal(workers[0].calls.filter(c => c.op === "external").at(-1)?.bytes, 300)
  assert.equal(workers[1].calls.filter(c => c.op === "external").at(-1)?.bytes, 550)
  release(); release()
  assert.equal(client.measure().tempBytes, 0)
  batch.disposeRender()
  assert.deepEqual(workers.map(w => w.terminated), [true, false])
  await batch.prepareAiImage(new Uint8Array([9]))
  assert.equal(workers.length, 2)
  batch.dispose()
  assert.equal(client.measure().residentBytes, 0)
})

test("a stopped AI request checks cancellation after Rust grants admission", async () => {
  const worker = new RuntimeWorker()
  worker.silent.add("acquire")
  const host = createRuntimeHost({ spawn: () => worker.asWorker(), maxLanes: 1, budgetBytes: 1000 })
  const batch = host.createBatch()
  let stopped = false
  const result = assert.rejects(batch.prepareAiImage(new Uint8Array([1]), () => stopped), { code: "RENDER_CANCELLED" })
  await until(() => worker.calls.some(c => c.op === "acquire"))
  stopped = true
  worker.reply(worker.calls.find(c => c.op === "acquire")!)
  await result
  assert.equal(worker.calls.some(c => c.op === "prepare"), false)
  batch.dispose()
})

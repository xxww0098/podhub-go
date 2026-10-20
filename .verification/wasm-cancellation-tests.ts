
function held<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}

test("disposing one owner during shared initialization stops its wait before init replies", async () => {
  const worker = new RuntimeWorker()
  worker.silent.add("init")
  const host = createRuntimeHost({ spawn: () => worker.asWorker(), maxLanes: 2, budgetBytes: 1000 })
  const a = host.createBatch(), b = host.createBatch()
  let entered = false
  let failure: unknown
  const abandoned = a.withLane("T", async () => { entered = true }).catch(error => { failure = error })
  try {
    await until(() => worker.calls.some(c => c.op === "init"))
    a.dispose()
    await tick()
    assert.equal((failure as { code?: string } | undefined)?.code, "RENDER_CANCELLED", "disposed owner must settle before shared init")
    assert.equal(worker.terminated, false, "B still owns initialization")
    assert.equal(entered, false)
    assert.equal(worker.calls.some(c => c.op === "acquire"), false)
    worker.reply(worker.calls.find(c => c.op === "init")!)
    await b.withLane("T", async () => {})
    await abandoned
    assert.equal(entered, false, "late initialization must not read A's input")
  } finally {
    a.dispose(); b.dispose()
    await abandoned
  }
})

test("disposing during caller IO stops waiting and fences late input without cancelling another owner", async () => {
  const worker = new RuntimeWorker()
  const host = createRuntimeHost({ spawn: () => worker.asWorker(), maxLanes: 2, budgetBytes: 1000 })
  const a = host.createBatch(), b = host.createBatch()
  const input = held<void>()
  const bytes = new Uint8Array([1, 2, 3])
  let entered = false
  let failure: unknown
  let lateFailure: unknown
  const abandoned = a.withLane("T", async lane => {
    entered = true
    await input.promise
    try { await lane.retainTemplate("T", bytes) }
    catch (error) { lateFailure = error }
    return "must not be delivered"
  }).catch(error => { failure = error })
  try {
    await until(() => entered)
    a.dispose()
    await tick()
    assert.equal((failure as { code?: string } | undefined)?.code, "RENDER_CANCELLED", "disposed owner must not wait for caller IO")
    assert.equal(worker.terminated, false)
    input.resolve()
    await until(() => lateFailure !== undefined)
    assert.equal((lateFailure as { code: string }).code, "RENDER_CANCELLED")
    assert.equal(bytes.byteLength, 3, "late input must not be transferred")
    assert.equal(worker.calls.some(c => c.op === "retain"), false)
    await b.withLane("T", async () => {})
    await abandoned
  } finally {
    input.resolve()
    a.dispose(); b.dispose()
    await abandoned
  }
})

test("a successful reply racing disposal never delivers a cancelled owner's result", async () => {
  const worker = new RuntimeWorker()
  worker.silent.add("render")
  const host = createRuntimeHost({ spawn: () => worker.asWorker(), maxLanes: 2, budgetBytes: 1000 })
  const a = host.createBatch(), b = host.createBatch()
  const result = a.withLane("T", lane => lane.renderProduct(7, new Uint8Array(2), "x"))
  const rejected = assert.rejects(result, { code: "RENDER_CANCELLED" })
  try {
    await until(() => worker.calls.some(c => c.op === "render"))
    worker.reply(worker.calls.find(c => c.op === "render")!)
    a.dispose()
    await rejected
    assert.equal(worker.terminated, false)
    await b.withLane("T", async () => {})
  } finally {
    a.dispose(); b.dispose()
    await rejected.catch(() => {})
  }
})

test("disposal during release acknowledgement stops delivery but keeps cleanup supervised", async () => {
  const worker = new RuntimeWorker()
  worker.silent.add("release")
  const host = createRuntimeHost({ spawn: () => worker.asWorker(), maxLanes: 2, budgetBytes: 1000 })
  const a = host.createBatch(), b = host.createBatch()
  let failure: unknown
  const result = a.withLane("T", async () => "old result").catch(error => { failure = error })
  try {
    await until(() => worker.calls.some(c => c.op === "release"))
    a.dispose()
    await tick()
    assert.equal((failure as { code?: string } | undefined)?.code, "RENDER_CANCELLED")
    assert.equal(worker.terminated, false)
    worker.reply(worker.calls.find(c => c.op === "release")!)
    worker.silent.clear()
    await result
    await b.withLane("T", async () => {})
  } finally {
    a.dispose(); b.dispose()
    await result
  }
})

test("disposed owners cannot reuse a cached template handle in a live shared runtime", async () => {
  const worker = new RuntimeWorker()
  worker.held = true
  const host = createRuntimeHost({ spawn: () => worker.asWorker(), maxLanes: 2, budgetBytes: 1000 })
  const a = host.createBatch(), b = host.createBatch()
  let saved: Parameters<Parameters<typeof a.withLane>[1]>[0] | undefined
  try {
    await a.withLane("T", async lane => { saved = lane })
    a.dispose()
    assert.equal(saved!.heldTemplate(), undefined)
    const bytes = new Uint8Array(8)
    await assert.rejects(saved!.retainTemplate("T", bytes), { code: "RENDER_CANCELLED" })
    assert.equal(bytes.byteLength, 8)
    assert.equal(worker.terminated, false)
    await b.withLane("T", async lane => assert.equal(lane.heldTemplate()?.id, 7))
  } finally { a.dispose(); b.dispose() }
})


test("disposal between a scoped wait resolving and its continuation still rejects delivery", async () => {
  const worker = new RuntimeWorker()
  const host = createRuntimeHost({ spawn: () => worker.asWorker(), maxLanes: 2, budgetBytes: 1000 })
  const a = host.createBatch(), b = host.createBatch()
  try {
    await assert.rejects(a.withLane("T", async () => {
      queueMicrotask(() => queueMicrotask(() => a.dispose()))
      return "cancelled result"
    }), { code: "RENDER_CANCELLED" })
    assert.equal(worker.terminated, false)
    await b.withLane("T", async () => {})
  } finally { a.dispose(); b.dispose() }
})

test("disposal between cleanup acknowledgement and final continuation prevents delivery", async () => {
  let dispose = () => {}
  class CleanupWorker extends RuntimeWorker {
    reply(message: Request) {
      super.reply(message)
      if (message.op === "release") queueMicrotask(() => queueMicrotask(dispose))
    }
  }
  const worker = new CleanupWorker()
  const host = createRuntimeHost({ spawn: () => worker.asWorker(), maxLanes: 2, budgetBytes: 1000 })
  const a = host.createBatch(), b = host.createBatch()
  dispose = a.dispose
  try {
    await assert.rejects(a.withLane("T", async () => "cancelled result"), { code: "RENDER_CANCELLED" })
    assert.equal(worker.terminated, false)
    dispose = () => {}
    await b.withLane("T", async () => {})
  } finally { a.dispose(); b.dispose() }
})

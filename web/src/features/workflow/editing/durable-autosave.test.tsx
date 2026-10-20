import assert from "node:assert/strict"
import test from "node:test"
import { DurableAutosave, type DurableAutosavePhase } from "./durable-autosave"

test("durable autosave serializes a newer edit behind the in-flight snapshot", async () => {
  let releaseFirst!: () => void
  const firstWrite = new Promise<void>((resolve) => {
    releaseFirst = resolve
  })
  const writes: string[] = []
  const phases: DurableAutosavePhase[] = []
  const autosave = new DurableAutosave(
    async (value: string) => {
      writes.push(value)
      if (value === "first") await firstWrite
      return value
    },
    () => {},
    (phase) => phases.push(phase),
  )

  autosave.markDirty("first")
  const flush = autosave.flush()
  await Promise.resolve()
  autosave.markDirty("second")
  releaseFirst()

  assert.equal(await flush, true)
  assert.deepEqual(writes, ["first", "second"])
  assert.equal(autosave.hasPendingChanges(), false)
  assert.equal(phases.at(-1), "saved")
})

test("durable autosave keeps a failed edit pending until an explicit retry succeeds", async () => {
  let attempts = 0
  const phases: DurableAutosavePhase[] = []
  const autosave = new DurableAutosave(
    async (value: string) => {
      attempts += 1
      if (attempts === 1) throw new Error("disk unavailable")
      return value
    },
    () => {},
    (phase) => phases.push(phase),
  )

  autosave.markDirty("draft")
  assert.equal(await autosave.flush(), false)
  assert.equal(autosave.hasPendingChanges(), true)
  assert.equal(phases.at(-1), "error")

  assert.equal(await autosave.flush(), true)
  assert.equal(attempts, 2)
  assert.equal(autosave.hasPendingChanges(), false)
  assert.equal(phases.at(-1), "saved")
})

test("host-assigned draft id is reused when an edit races the first save", async () => {
  type Payload = { draftId?: string; value: string }
  type Saved = { draftId: string }
  let releaseFirst!: () => void
  const firstWrite = new Promise<void>((resolve) => {
    releaseFirst = resolve
  })
  const writes: Payload[] = []
  let autosave!: DurableAutosave<Payload, Saved>
  autosave = new DurableAutosave(
    async (payload) => {
      writes.push(payload)
      if (writes.length === 1) await firstWrite
      return { draftId: "workflow_instance_1" }
    },
    (saved) => {
      autosave.rebaseLatest((payload) => ({
        ...payload,
        draftId: saved.draftId,
      }))
    },
    () => {},
  )

  autosave.markDirty({ value: "9" })
  const flush = autosave.flush()
  await Promise.resolve()
  autosave.markDirty({ value: "90" })
  releaseFirst()

  assert.equal(await flush, true)
  assert.deepEqual(writes, [
    { value: "9" },
    { draftId: "workflow_instance_1", value: "90" },
  ])
})

test("a stale save resolving after reset cannot mark the new edit as saved", async () => {
  let releaseFirst!: () => void
  const firstWrite = new Promise<void>((resolve) => {
    releaseFirst = resolve
  })
  const writes: string[] = []
  const phases: DurableAutosavePhase[] = []
  const autosave = new DurableAutosave(
    async (value: string) => {
      writes.push(value)
      if (value === "A") await firstWrite
      return value
    },
    () => {},
    (phase) => phases.push(phase),
  )

  autosave.markDirty("A")
  const flushA = autosave.flush()
  await Promise.resolve()
  autosave.reset()
  autosave.markDirty("B")
  releaseFirst()

  // The in-flight "A" save resolved against the old generation: it must not
  // acknowledge B, flip the phase, or satisfy the flush it was carrying.
  assert.equal(await flushA, false)
  assert.equal(autosave.hasPendingChanges(), true)
  assert.notEqual(phases.at(-1), "saved")

  assert.equal(await autosave.flush(), true)
  assert.deepEqual(writes, ["A", "B"])
  assert.equal(autosave.hasPendingChanges(), false)
  assert.equal(phases.at(-1), "saved")
})

test("a stale save failing after reset leaves the new edit pending, not errored", async () => {
  let rejectFirst!: (reason: unknown) => void
  const firstWrite = new Promise<void>((_resolve, reject) => {
    rejectFirst = reject
  })
  const phases: DurableAutosavePhase[] = []
  const autosave = new DurableAutosave(
    async (value: string) => {
      if (value === "A") await firstWrite
      return value
    },
    () => {},
    (phase) => phases.push(phase),
  )

  autosave.markDirty("A")
  const flushA = autosave.flush()
  await Promise.resolve()
  autosave.reset()
  autosave.markDirty("B")
  rejectFirst(new Error("connection dropped"))

  assert.equal(await flushA, false)
  assert.equal(autosave.hasPendingChanges(), true)
  assert.equal(phases.at(-1), "dirty")
})

test("a flush queued before a reset still persists the new edit", async () => {
  let releaseFirst!: () => void
  const firstWrite = new Promise<void>((resolve) => {
    releaseFirst = resolve
  })
  const writes: string[] = []
  const autosave = new DurableAutosave(
    async (value: string) => {
      writes.push(value)
      if (value === "A") await firstWrite
      return value
    },
    () => {},
    () => {},
  )

  autosave.markDirty("A")
  const flushA = autosave.flush()
  await Promise.resolve()
  // Queued behind the in-flight save; the reset lands before this drain runs,
  // so it must pick up the new generation's edit rather than report success.
  const flushB = autosave.flush()
  autosave.reset()
  autosave.markDirty("B")
  releaseFirst()

  assert.equal(await flushA, false)
  assert.equal(await flushB, true)
  assert.deepEqual(writes, ["A", "B"])
})

test("a disposed autosave never fires its queued save", async () => {
  const writes: string[] = []
  const autosave = new DurableAutosave(
    async (value: string) => {
      writes.push(value)
      return value
    },
    () => {},
    () => {},
  )
  autosave.markDirty("A")
  autosave.dispose()
  assert.equal(await autosave.flush(), false)
  assert.equal(autosave.hasPendingChanges(), false)
  assert.deepEqual(writes, [])
})

test("dispose prevents a flush that was queued but had not started", async () => {
  const writes: string[] = []
  const phases: DurableAutosavePhase[] = []
  const autosave = new DurableAutosave(
    async (value: string) => {
      writes.push(value)
      return value
    },
    () => {},
    (phase) => phases.push(phase),
  )

  autosave.markDirty("edit-1")
  const flush = autosave.flush()
  // The drain is queued on the tail and has not started: dispose lands first.
  autosave.dispose()

  assert.equal(await flush, false)
  assert.deepEqual(writes, [])
  assert.deepEqual(phases, ["dirty"])
  assert.equal(autosave.hasPendingChanges(), false)
})

test("dispose lets the in-flight save finish but never starts the queued one", async () => {
  let releaseFirst!: () => void
  const firstWrite = new Promise<void>((resolve) => {
    releaseFirst = resolve
  })
  const writes: string[] = []
  const saved: string[] = []
  const phases: DurableAutosavePhase[] = []
  const autosave = new DurableAutosave(
    async (value: string) => {
      writes.push(value)
      if (value === "A") await firstWrite
      return value
    },
    (result) => saved.push(result),
    (phase) => phases.push(phase),
  )

  autosave.markDirty("A")
  const flushA = autosave.flush()
  await Promise.resolve()
  autosave.markDirty("B")
  const flushB = autosave.flush()
  autosave.dispose()
  const phaseCountAtDispose = phases.length
  releaseFirst()

  // "A" had already started, so its receipt still lands; "B" must never start
  // and the disposed instance must not acknowledge either save.
  assert.equal(await flushA, false)
  assert.equal(await flushB, false)
  assert.deepEqual(writes, ["A"])
  assert.deepEqual(saved, ["A"])
  assert.deepEqual(phases.slice(phaseCountAtDispose), [])
  assert.equal(autosave.hasPendingChanges(), false)
})

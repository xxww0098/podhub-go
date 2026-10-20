import assert from "node:assert/strict"
import test from "node:test"
import {
  createSlicePreviewScheduler,
  isSourcePreview,
  SLICE_PREVIEW_MAX_IN_FLIGHT,
  SlicePreviewScheduler,
  type PreviewRequest,
  type SlicePreviewRequest,
} from "./slice-preview-scheduler"

function request(index: number, overrides: Partial<SlicePreviewRequest> = {}): SlicePreviewRequest {
  return {
    draftId: `draft-${Math.floor(index / 8)}`,
    index: index % 8,
    contentHash: `sha256:${index}`,
    fileName: `slice-${(index % 8) + 1}.jpg`,
    edge: 512,
    ...overrides,
  }
}

function asSlice(item: PreviewRequest): SlicePreviewRequest {
  if (isSourcePreview(item)) throw new Error("expected a slice preview request")
  return item
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

async function nextTurn() {
  await new Promise<void>((resolve) => setImmediate(resolve))
}

test("10 rows x 8 cold previews share one table-wide in-flight budget", async () => {
  let active = 0
  let peak = 0
  const scheduler = createSlicePreviewScheduler(
    async (item) => {
      const { index, draftId } = asSlice(item)
      active += 1
      peak = Math.max(peak, active)
      await new Promise<void>((resolve) => setTimeout(resolve, 1))
      active -= 1
      return `data:${draftId}:${index}`
    },
  )

  const previews = Array.from({ length: 80 }, (_, index) => scheduler.request(request(index)).promise)
  const results = await Promise.all(previews)

  assert.equal(results.length, 80)
  assert.equal(
    peak,
    SLICE_PREVIEW_MAX_IN_FLIGHT,
    "all mounted rows must spend one process-wide preview budget",
  )
})

test("the stable draft/index/hash/edge key is singleflight and then cached", async () => {
  const gate = deferred<string>()
  let calls = 0
  const scheduler = new SlicePreviewScheduler({
    maxInFlight: 2,
    maxCacheEntries: 16,
    load: async () => {
      calls += 1
      return gate.promise
    },
  })
  const input = request(0)

  const first = scheduler.request(input)
  const second = scheduler.request({ ...input })
  await nextTurn()
  assert.equal(calls, 1, "identical in-flight previews must share one load call")

  gate.resolve("data:shared")
  assert.deepEqual(await Promise.all([first.promise, second.promise]), ["data:shared", "data:shared"])
  assert.equal(await scheduler.request(input).promise, "data:shared")
  assert.equal(calls, 1, "a settled preview must be served from the process cache")
})

test("a failed preview releases its global slot", async () => {
  const gates = [deferred<string>(), deferred<string>(), deferred<string>()]
  const started: number[] = []
  const scheduler = new SlicePreviewScheduler({
    maxInFlight: 2,
    maxCacheEntries: 16,
    load: async (item) => {
      const { index } = asSlice(item)
      started.push(index)
      return gates[index].promise
    },
  })

  const first = scheduler.request(request(0)).promise
  const second = scheduler.request(request(1)).promise
  const third = scheduler.request(request(2)).promise
  await nextTurn()
  assert.deepEqual(started, [0, 1])

  gates[0].reject(new Error("missing artifact"))
  await assert.rejects(first, /missing artifact/)
  await nextTurn()
  assert.deepEqual(started, [0, 1, 2], "failure must immediately admit the next queued preview")

  gates[1].resolve("data:1")
  gates[2].resolve("data:2")
  assert.deepEqual(await Promise.all([second, third]), ["data:1", "data:2"])
})

test("cancelling the last subscriber removes work that has not started", async () => {
  const firstGate = deferred<string>()
  const started: number[] = []
  const scheduler = new SlicePreviewScheduler({
    maxInFlight: 1,
    maxCacheEntries: 16,
    load: async (item) => {
      const { index } = asSlice(item)
      started.push(index)
      if (index === 0) return firstGate.promise
      return `data:${index}`
    },
  })

  const first = scheduler.request(request(0))
  const cancelled = scheduler.request(request(1))
  const third = scheduler.request(request(2))
  await nextTurn()
  assert.deepEqual(started, [0])

  cancelled.cancel()
  assert.equal(await cancelled.promise, undefined)
  firstGate.resolve("data:0")
  assert.equal(await first.promise, "data:0")
  assert.equal(await third.promise, "data:2")
  assert.deepEqual(started, [0, 2], "cancelled queued work must never start a load")
})

test("an interactive detail preview jumps ahead of queued table thumbnails", async () => {
  const gates = [deferred<string>(), deferred<string>(), deferred<string>()]
  const started: number[] = []
  const scheduler = new SlicePreviewScheduler({
    maxInFlight: 1,
    maxCacheEntries: 16,
    load: async (item) => {
      const { index } = asSlice(item)
      started.push(index)
      return gates[index].promise
    },
  })

  const activeThumbnail = scheduler.request(request(0))
  const queuedThumbnail = scheduler.request(request(1))
  await nextTurn()
  const detail = scheduler.request(request(2, { priority: "interactive", edge: 2_048 }))

  gates[0].resolve("data:0")
  assert.equal(await activeThumbnail.promise, "data:0")
  await nextTurn()
  assert.deepEqual(
    started,
    [0, 2],
    "a click must not wait behind every thumbnail mounted by the table",
  )

  gates[2].resolve("data:2")
  assert.equal(await detail.promise, "data:2")
  await nextTurn()
  gates[1].resolve("data:1")
  assert.equal(await queuedThumbnail.promise, "data:1")
})

test("interactive detail previews do not occupy the thumbnail LRU", async () => {
  let calls = 0
  const scheduler = new SlicePreviewScheduler({
    maxInFlight: 1,
    maxCacheEntries: 16,
    load: async () => {
      calls += 1
      return `data:detail-${calls}`
    },
  })
  const detail = request(0, { priority: "interactive", edge: 2_048 })

  assert.equal(await scheduler.request(detail).promise, "data:detail-1")
  assert.equal(await scheduler.request(detail).promise, "data:detail-2")
  assert.equal(calls, 2, "large detail data URLs must not accumulate in the 256-entry LRU")
})

test("source and slice previews spend the same preview slots", async () => {
  let active = 0
  let peak = 0
  const scheduler = createSlicePreviewScheduler(async () => {
    active += 1
    peak = Math.max(peak, active)
    await new Promise<void>((resolve) => setTimeout(resolve, 1))
    active -= 1
    return "data:shared-budget"
  })

  // Enough of each kind to overrun the ceiling on its own: a second budget for
  // source thumbs would show up here as a peak above it.
  const each = SLICE_PREVIEW_MAX_IN_FLIGHT + 2
  const work = [
    ...Array.from({ length: each }, (_, index) => scheduler.request(request(index)).promise),
    ...Array.from(
      { length: each },
      (_, index) => scheduler.request({ kind: "source", handle: `handle-${index}` }).promise,
    ),
  ]
  await Promise.all(work)
  assert.equal(
    peak,
    SLICE_PREVIEW_MAX_IN_FLIGHT,
    "source thumbs must not open a second JPEG budget",
  )
})

test("a thousand queued thumbnails cancel down to the visible window before a load runs", async () => {
  let calls = 0
  const started: number[] = []
  const scheduler = createSlicePreviewScheduler(async (item) => {
    const { index } = asSlice(item)
    calls += 1
    started.push(index)
    return `data:${index}`
  })

  const subscriptions = Array.from({ length: 1000 }, (_, index) => scheduler.request(request(index)))
  for (const subscription of subscriptions.slice(20)) subscription.cancel()
  await Promise.all(subscriptions.slice(0, 20).map((item) => item.promise))
  await nextTurn()

  assert.equal(calls, 20, "off-viewport rows must withdraw before occupying a preview slot")
  assert.equal(started.length, 20)
})

test("peek returns a cached thumbnail without another load call", async () => {
  let calls = 0
  const scheduler = new SlicePreviewScheduler({
    maxInFlight: 1,
    maxCacheEntries: 16,
    load: async () => {
      calls += 1
      return "data:cached"
    },
  })
  const input = request(0)
  assert.equal(await scheduler.request(input).promise, "data:cached")
  assert.equal(scheduler.peek(input), "data:cached")
  assert.equal(calls, 1)
})

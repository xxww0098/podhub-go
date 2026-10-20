export interface SlicePreviewRequest {
  draftId: string
  index: number
  contentHash: string
  /** The renderer file name filed under `renders/{rowId}/`, e.g. `{stem}-1.jpg`. */
  fileName: string
  edge: number
  priority?: "background" | "interactive"
}

export interface SourcePreviewRequest {
  kind: "source"
  handle: string
  edge?: number
  priority?: "background" | "interactive"
}

export type PreviewRequest = SlicePreviewRequest | SourcePreviewRequest

export function isSourcePreview(request: PreviewRequest): request is SourcePreviewRequest {
  return "kind" in request && request.kind === "source"
}

interface SlicePreviewSubscription {
  promise: Promise<string | undefined>
  cancel: () => void
}

interface Subscriber {
  settled: boolean
  resolve: (value: string | undefined) => void
  reject: (reason: unknown) => void
}

interface PreviewTask {
  key: string
  request: PreviewRequest
  state: "queued" | "active"
  subscribers: Set<Subscriber>
}

export function slicePreviewKey(request: PreviewRequest): string {
  if (isSourcePreview(request)) {
    return JSON.stringify(["source", request.handle, request.edge ?? 0])
  }
  return JSON.stringify([
    request.draftId,
    request.index,
    request.contentHash,
    request.fileName,
    request.edge,
  ])
}

/**
 * How many OPFS thumbnail reads the whole table may have in flight.
 *
 * These previews never enter the wasm worker: they are decoded and
 * downscaled in the OPFS worker (`render/opfs-worker.ts`) and land here as
 * thumbnail bytes. Two fills the visible chips without a decode stampede that
 * would fight the render workers for the tab.
 */
export const SLICE_PREVIEW_MAX_IN_FLIGHT = 2

export function createSlicePreviewScheduler(
  load: (request: PreviewRequest) => Promise<string>,
): SlicePreviewScheduler {
  return new SlicePreviewScheduler({
    maxInFlight: SLICE_PREVIEW_MAX_IN_FLIGHT,
    maxCacheEntries: 256,
    load,
  })
}

/**
 * One renderer-wide queue for best-effort OPFS thumbnails.
 *
 * A subscription can withdraw queued work. An in-flight object-URL decode
 * cannot be aborted, so withdrawing an active subscription only suppresses
 * its result; the occupied slot is released when that read settles.
 */
export class SlicePreviewScheduler {
  private readonly maxInFlight: number
  private readonly maxCacheEntries: number
  private readonly load: (request: PreviewRequest) => Promise<string>
  private readonly cache = new Map<string, string>()
  private readonly tasks = new Map<string, PreviewTask>()
  private readonly queue: PreviewTask[] = []
  private active = 0
  private pumpScheduled = false

  constructor(options: {
    maxInFlight: number
    maxCacheEntries: number
    load: (request: PreviewRequest) => Promise<string>
  }) {
    if (!Number.isInteger(options.maxInFlight) || options.maxInFlight < 1) {
      throw new Error("slice preview maxInFlight must be a positive integer")
    }
    if (!Number.isInteger(options.maxCacheEntries) || options.maxCacheEntries < 1) {
      throw new Error("slice preview maxCacheEntries must be a positive integer")
    }
    this.maxInFlight = options.maxInFlight
    this.maxCacheEntries = options.maxCacheEntries
    this.load = options.load
  }

  peek(request: PreviewRequest): string | undefined {
    return this.readCache(slicePreviewKey(request))
  }

  request(request: PreviewRequest): SlicePreviewSubscription {
    const key = slicePreviewKey(request)
    const cached = this.readCache(key)
    if (cached !== undefined) {
      return { promise: Promise.resolve(cached), cancel: () => undefined }
    }

    let task = this.tasks.get(key)
    if (!task) {
      task = { key, request: { ...request }, state: "queued", subscribers: new Set() }
      this.tasks.set(key, task)
      if (request.priority === "interactive") this.queue.unshift(task)
      else this.queue.push(task)
    } else if (
      request.priority === "interactive"
      && task.state === "queued"
      && task.request.priority !== "interactive"
    ) {
      task.request.priority = "interactive"
      const queuedAt = this.queue.indexOf(task)
      if (queuedAt >= 0) this.queue.splice(queuedAt, 1)
      this.queue.unshift(task)
    }

    let resolve!: Subscriber["resolve"]
    let reject!: Subscriber["reject"]
    const promise = new Promise<string | undefined>((resolvePromise, rejectPromise) => {
      resolve = resolvePromise
      reject = rejectPromise
    })
    const subscriber: Subscriber = { settled: false, resolve, reject }
    task.subscribers.add(subscriber)
    this.schedulePump()

    return {
      promise,
      cancel: () => {
        if (subscriber.settled) return
        subscriber.settled = true
        subscriber.resolve(undefined)
        task?.subscribers.delete(subscriber)
        if (task?.state === "queued" && task.subscribers.size === 0) {
          if (this.tasks.get(key) === task) this.tasks.delete(key)
        }
      },
    }
  }

  /**
   * Release every cached object URL. The scheduler owns the thumbnail LRU —
   * a displayed `<img>` keeps its decoded bitmap after revoke, while a
   * dropped URL frees its Blob. Interactive results are never cached here;
   * they belong to the caller, which revokes them.
   */
  dispose() {
    for (const url of this.cache.values()) URL.revokeObjectURL(url)
    this.cache.clear()
  }

  private readCache(key: string): string | undefined {
    const cached = this.cache.get(key)
    if (cached === undefined) return undefined
    this.cache.delete(key)
    this.cache.set(key, cached)
    return cached
  }

  private writeCache(key: string, value: string) {
    this.cache.delete(key)
    this.cache.set(key, value)
    while (this.cache.size > this.maxCacheEntries) {
      const oldest = this.cache.keys().next().value
      if (oldest === undefined) return
      const evicted = this.cache.get(oldest)
      this.cache.delete(oldest)
      if (evicted !== undefined) URL.revokeObjectURL(evicted)
    }
  }

  private schedulePump() {
    if (this.pumpScheduled) return
    this.pumpScheduled = true
    queueMicrotask(() => {
      this.pumpScheduled = false
      this.pump()
    })
  }

  private pump() {
    while (this.active < this.maxInFlight) {
      const task = this.queue.shift()
      if (!task) return
      if (
        task.state !== "queued"
        || this.tasks.get(task.key) !== task
        || task.subscribers.size === 0
      ) {
        continue
      }

      task.state = "active"
      this.active += 1
      void Promise.resolve()
        .then(() => this.load(task.request))
        .then(
          (value) => {
            // Background thumbnails stay scheduler-owned in the LRU, where
            // eviction is a revoke. An interactive detail can carry megabytes,
            // so ownership passes to its caller instead — except when every
            // subscriber withdrew mid-decode, which leaves the URL unowned and
            // it dies here.
            if (task.request.priority !== "interactive") {
              this.writeCache(task.key, value)
            } else if (![...task.subscribers].some((s) => !s.settled)) {
              URL.revokeObjectURL(value)
            }
            this.settleTask(task, { value })
          },
          (error: unknown) => this.settleTask(task, { error }),
        )
        .finally(() => {
          this.active -= 1
          this.schedulePump()
        })
    }
  }

  private settleTask(task: PreviewTask, outcome: { value: string } | { error: unknown }) {
    if (this.tasks.get(task.key) === task) this.tasks.delete(task.key)
    for (const subscriber of task.subscribers) {
      if (subscriber.settled) continue
      subscriber.settled = true
      if ("value" in outcome) subscriber.resolve(outcome.value)
      else subscriber.reject(outcome.error)
    }
    task.subscribers.clear()
  }
}

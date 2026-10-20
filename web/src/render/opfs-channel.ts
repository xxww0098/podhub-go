/**
 * The Window-thread end of the OPFS worker (`./opfs-worker.ts`).
 *
 * `openOpfsChannel` resolves to the channel once the worker has proven it can
 * take sync access handles, and to `null` — the caller's own Window-API
 * fallback — on engines that cannot. Errors come back as DOMExceptions with
 * the worker's original `name`, so `NotFoundError` / `QuotaExceededError`
 * handling is unchanged whether the bytes moved through the worker or not.
 */
import type { OpfsPreviewResult, OpfsWorkerOp, OpfsWorkerResponse } from "./opfs-worker"

/**
 * The worker is gone — a dead or terminated Worker drops postMessages
 * silently, so pending and later calls fail with this instead of hanging.
 * Callers degrade to their Window-API path permanently.
 */
export class OpfsChannelDead extends Error {
  constructor() {
    super("the OPFS worker is gone")
    this.name = "OpfsChannelDead"
  }
}

/**
 * A worker reply-less deadline, per call. A hung `createSyncAccessHandle`
 * lock (stuck OPFS state, the reason this exists) never posts back, so
 * nothing else notices the worker is gone. 30s covers ordinary I/O latency
 * with room to spare; `write` adds a byte-proportional term at 10 MiB/s
 * because its payload size is known upfront — a 254 MiB template gets
 * 30s + 254/10 ≈ 55.4s. `read`/`preview` don't know their response size
 * before it arrives, so they get the base only.
 */
const CALL_BASE_TIMEOUT_MS = 30_000
const CALL_BYTES_PER_SECOND = 10 * 1024 * 1024

function callTimeoutMs(request: OpfsWorkerOp): number {
  const bytes = request.op === "write" ? request.bytes.length : 0
  return CALL_BASE_TIMEOUT_MS + Math.ceil((bytes / CALL_BYTES_PER_SECOND) * 1000)
}

export interface OpfsChannel {
  /** `null` when the file is absent — same contract as the Window path. */
  read(path: string[], name: string): Promise<Uint8Array | null>
  write(path: string[], name: string, bytes: Uint8Array): Promise<void>
  preview(path: string[], name: string, edge: number, mime?: string): Promise<OpfsPreviewResult | null>
}

export function openOpfsChannel(): Promise<OpfsChannel | null> {
  if (typeof Worker === "undefined") return Promise.resolve(null)
  let worker: Worker
  try {
    worker = new Worker(new URL("./opfs-worker.ts", import.meta.url), { type: "module" })
  } catch {
    return Promise.resolve(null)
  }

  const pending = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (reason: unknown) => void; timer: ReturnType<typeof setTimeout> }
  >()
  let nextId = 1
  let alive = true

  worker.addEventListener("message", (event: MessageEvent<OpfsWorkerResponse>) => {
    const response = event.data
    const entry = pending.get(response.id)
    if (!entry) return
    pending.delete(response.id)
    clearTimeout(entry.timer)
    if (response.ok) {
      entry.resolve(response.value)
    } else {
      entry.reject(new DOMException(response.message, response.name))
    }
  })
  // A dead channel means no more OPFS work may run on this worker thread,
  // whether the cause was its own crash (`error` / `messageerror`) or a
  // deadline that a reply never beat: either way something may still be
  // holding a sync access handle's lock, so termination is unconditional
  // here rather than only on the timeout path.
  const die = () => {
    if (!alive) return
    alive = false
    worker.terminate()
    for (const entry of pending.values()) {
      clearTimeout(entry.timer)
      entry.reject(new OpfsChannelDead())
    }
    pending.clear()
  }
  worker.addEventListener("error", die)
  worker.addEventListener("messageerror", die)

  function call<T>(request: OpfsWorkerOp, transfer: Transferable[] = []): Promise<T> {
    if (!alive) return Promise.reject(new OpfsChannelDead())
    const id = nextId++
    return new Promise<T>((resolve, reject) => {
      // No response by the deadline is treated exactly like a worker crash:
      // `die()` rejects this call and every other one still pending, not
      // just this one — a wedged worker is wedged for all of them.
      const timer = setTimeout(die, callTimeoutMs(request))
      pending.set(id, { resolve: resolve as (value: unknown) => void, reject, timer })
      try {
        worker.postMessage({ ...request, id }, { transfer })
      } catch (reason) {
        clearTimeout(timer)
        pending.delete(id)
        reject(reason)
      }
    })
  }

  const channel: OpfsChannel = {
    read: async (path, name) => {
      try {
        return await call<Uint8Array>({ op: "read", path, name })
      } catch (reason) {
        if ((reason as DOMException).name === "NotFoundError") return null
        throw reason
      }
    },
    write: async (path, name, bytes) => {
      // The bytes are cloned, not transferred: callers keep using the arrays
      // they hand in (`renderedImage` still reads `slice.bytes.length` after
      // `putRender`), so nothing is detached mid-batch.
      await call<null>({ op: "write", path, name, bytes })
    },
    preview: async (path, name, edge, mime) => {
      try {
        return await call<OpfsPreviewResult>({ op: "preview", path, name, edge, mime })
      } catch (reason) {
        if ((reason as DOMException).name === "NotFoundError") return null
        throw reason
      }
    },
  }

  return call<boolean>({ op: "probe" }).then(
    (ok) => {
      if (ok) return channel
      worker.terminate()
      return null
    },
    () => {
      worker.terminate()
      return null
    },
  )
}

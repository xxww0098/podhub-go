import { ingestRenderListingLog, listingLogCollectEnabled, subscribeListingLogCollect } from "@/lib/listing-log"
import type { RenderBatch, RenderLane } from "./client"
import type { RenderBytes, RenderResult } from "./wasm"
import { renderFailure } from "./psd-admission"

export interface RuntimeHostOptions {
  spawn: () => Worker
  maxLanes: number
  budgetBytes: number
  requestTimeoutMs?: number
  foreignBytes?: () => number
  memoryChanged?: () => void
}

interface Stats { memoryBytes: number; occupiedBytes: number; active: number; queued: number; templates: number; peaks: Record<string, number> }
interface Reply { id: number; ok: boolean; value?: unknown; code?: string; message?: string; fatal?: boolean; stats?: Stats }
interface Pending { owner?: number; reject: (error: Error) => void; resolve: (value: unknown) => void; timer?: ReturnType<typeof setTimeout> }
interface Runtime { worker: Worker; pending: Map<number, Pending>; ready: Promise<unknown>; dead: boolean; stats: Stats }

/** Host lifecycle only. Rust owns the FIFO, leases, template cache and admission. */
export function createRuntimeHost(options: RuntimeHostOptions) {
  let current: Runtime | undefined
  let nextRequest = 1
  let nextOwner = 1
  const owners = new Set<number>()
  const failure = (message: string, code = "RENDER_WORKER_ERROR") => Object.assign(new Error(message), { code })
  subscribeListingLogCollect((enabled) => {
    if (!current || current.dead) return
    try { current.worker.postMessage({ op: "listing-log-collect", enabled }) } catch { /* already gone */ }
  })

  function destroy(runtime: Runtime, error: Error) {
    if (runtime.dead) return
    runtime.dead = true
    // terminate() also terminates this Worker's descendants. The shutdown
    // message gives a responsive coordinator an explicit child cleanup path.
    try { runtime.worker.postMessage({ op: "shutdown" }) } catch { /* already failed */ }
    runtime.worker.terminate()
    for (const entry of runtime.pending.values()) {
      if (entry.timer) clearTimeout(entry.timer)
      entry.reject(error)
    }
    runtime.pending.clear()
    if (current === runtime) current = undefined
    options.memoryChanged?.()
  }

  function call(runtime: Runtime, op: string, args: Record<string, unknown> = {}, transfer: Transferable[] = [], owner?: number): Promise<unknown> {
    if (runtime.dead) return Promise.reject(failure("The render runtime was destroyed", "RENDER_TRAP"))
    const id = nextRequest++
    return new Promise((resolve, reject) => {
      const entry: Pending = { owner, resolve, reject }
      // Admission is metadata-only waiting, not running compute. Every active
      // initialization / compute request has an external watchdog instead.
      if (op !== "acquire") entry.timer = setTimeout(() => {
        destroy(runtime, failure("The render runtime request timed out", "RENDER_WATCHDOG"))
      }, options.requestTimeoutMs ?? 180_000)
      runtime.pending.set(id, entry)
      try { runtime.worker.postMessage({ id, op, ...args }, transfer) }
      catch (error) { destroy(runtime, failure(String(error))) }
    })
  }

  function dispatch() {
    if (!current || current.dead) return
    try { current.worker.postMessage({ op: "external", bytes: options.foreignBytes?.() ?? 0 }) }
    catch (error) { destroy(current, failure(String(error))) }
  }

  function runtime(): Runtime {
    if (current) return current
    const state: Runtime = { worker: options.spawn(), pending: new Map(), ready: Promise.resolve(), dead: false,
      stats: { memoryBytes: 0, occupiedBytes: 0, active: 0, queued: 0, templates: 0, peaks: {} } }
    current = state
    if (listingLogCollectEnabled()) {
      try { state.worker.postMessage({ op: "listing-log-collect", enabled: true }) } catch { /* already gone */ }
    }
    state.worker.addEventListener("message", ({ data }: MessageEvent<Reply & { listingLog?: Parameters<typeof ingestRenderListingLog>[0] }>) => {
      if (state.dead) return
      if (data.listingLog) { ingestRenderListingLog(data.listingLog); return }
      if (data.fatal) { destroy(state, failure(data.message ?? "A compute thread trapped", "RENDER_TRAP")); return }
      if (data.stats) {
        const changed = state.stats.occupiedBytes !== data.stats.occupiedBytes
        state.stats = data.stats
        if (changed) options.memoryChanged?.()
      }
      const pending = state.pending.get(data.id)
      if (!pending) return
      state.pending.delete(data.id)
      if (pending.timer) clearTimeout(pending.timer)
      if (data.ok) pending.resolve(data.value)
      else pending.reject(renderFailure(data.message ?? "Render failed", data.code ?? "RENDER_WORKER_ERROR"))
    })
    state.worker.addEventListener("error", () => destroy(state, failure("Render coordinator failed", "RENDER_TRAP")))
    state.worker.addEventListener("messageerror", () => destroy(state, failure("Render coordinator response failed", "RENDER_TRAP")))
    state.ready = call(state, "init", { threads: options.maxLanes, budgetBytes: options.budgetBytes })
      .then(() => { dispatch() }, error => { destroy(state, error); throw error })
    return state
  }

  return {
    maxLanes: options.maxLanes,
    dispatch,
    createBatch(): Pick<RenderBatch, "withLane" | "prepareAiImage" | "dispose"> {
      const owner = nextOwner++
      owners.add(owner)
      const stopped = new AbortController()
      const alive = () => {
        if (stopped.signal.aborted) throw stopped.signal.reason
      }
      // Cancelling a caller is not cancelling compute. Observe every owner
      // wait (including shared init and caller IO), without releasing Rust's
      // busy lease or disabling the underlying request's watchdog.
      const waitForOwner = <T>(work: Promise<T>): Promise<T> => new Promise((resolve, reject) => {
        const signal = stopped.signal
        const abort = () => reject(signal.reason)
        signal.addEventListener("abort", abort, { once: true })
        // Observe late failures too, even when the owner has already stopped.
        work.then(value => {
          signal.removeEventListener("abort", abort)
          if (signal.aborted) reject(signal.reason)
          else resolve(value)
        }, error => {
          signal.removeEventListener("abort", abort)
          reject(error)
        })
        if (signal.aborted) {
          signal.removeEventListener("abort", abort)
          abort()
        }
      })
      const dispose = () => {
        if (!owners.delete(owner)) return
        stopped.abort(failure("The render batch was disposed", "RENDER_CANCELLED"))
        const state = current
        if (!state) return
        if (!owners.size) { destroy(state, failure("The render batch ended", "RENDER_CANCELLED")); return }
        // Rust retains a busy lease until its compute actually ends. JS drops
        // this owner's callbacks immediately so late results cannot be used.
        for (const [id, entry] of state.pending) {
          if (entry.owner !== owner) continue
          // Abandoning a caller cannot disable supervision of still-running
          // compute: other owners may be waiting for its Rust lease to release.
          if (!entry.timer) state.pending.delete(id)
          entry.reject(failure("The render batch was disposed", "RENDER_CANCELLED"))
        }
        void state.ready.then(() => call(state, "disposeOwner", { owner })).catch(() => {})
      }
      return {
        async withLane<T>(key: string, run: (lane: RenderLane) => Promise<T>): Promise<T> {
          alive()
          const state = runtime()
          await waitForOwner(state.ready)
          alive()
          const grant = await call(state, "acquire", { owner, key }, [], owner) as {
            leaseId: number; template?: { sha256: string; id: number } | null
          }
          let held = grant.template ?? undefined
          const leaseId = grant.leaseId
          let listing: Record<string, string | undefined> | undefined
          const invoke = (op: string, args: Record<string, unknown>, transfer: Transferable[] = []) => {
            alive()
            return call(state, op, { leaseId, ...(listing ? { listing } : {}), ...args }, transfer, owner)
          }
          const retain: RenderLane["retainTemplate"] = async (sha256, bytes) => {
            alive()
            if (sha256 !== key) throw failure("Template differs from the admitted input", "RENDER_TEMPLATE_FINGERPRINT")
            if (held && !state.dead) return held.id
            const id = await invoke("retain", { bytes }, [bytes.buffer]) as number
            held = { sha256, id }
            return id
          }
          let value: T
          try {
            alive()
            value = await waitForOwner(run({
              heldTemplate: () => state.dead || stopped.signal.aborted ? undefined : held,
              forgetHeldTemplate: () => { held = undefined },
              bindListing: (hint) => { listing = hint },
              retainTemplate: retain,
              renderProduct: (templateId, bytes, name, intent) => invoke("render", { templateId, bytes, name, intent }, [bytes.buffer]) as Promise<RenderResult>,
              prepareAiImage: bytes => invoke("prepare", { bytes }, [bytes.buffer]) as Promise<RenderBytes>,
            }))
          } finally {
            if (!state.dead) {
              const released = call(state, "release", { leaseId }).catch(() => {})
              // Cancellation settles the caller now; the release request is
              // still observed and supervised, and Rust drains busy compute.
              if (!stopped.signal.aborted) await waitForOwner(released)
            }
          }
          // A wait can settle just before disposal, with this continuation
          // still queued. The final delivery boundary must check again.
          alive()
          return value
        },
        prepareAiImage(bytes, cancelled) {
          return this.withLane("prepare-ai-image", lane => {
            if (cancelled?.()) throw failure("Image preparation was cancelled", "RENDER_CANCELLED")
            return lane.prepareAiImage(bytes)
          })
        },
        dispose,
      }
    },
    measure() {
      const stats = current?.stats
      return { maxLanes: options.maxLanes, budgetBytes: options.budgetBytes,
        lanes: stats ? [stats.memoryBytes] : [], residentBytes: stats?.memoryBytes ?? 0,
        occupiedBytes: stats?.occupiedBytes ?? 0,
        peaks: stats?.peaks ?? {}, active: stats?.active ?? 0, queued: stats?.queued ?? 0 }
    },
  }
}

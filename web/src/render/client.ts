/** TypeScript owns runtime lifetimes and external buffers; WASM owns leases,
 * FIFO admission, template sharing and compute-thread dispatch. */
import { createRuntimeHost, type RuntimeHostOptions } from "./threaded-client"
import type { RenderBytes, RenderIntent, RenderResult } from "./wasm"

export interface RenderLane {
  heldTemplate(): { sha256: string; id: number } | undefined
  retainTemplate(sha256: string, bytes: RenderBytes): Promise<number>
  forgetHeldTemplate(): void
  renderProduct(templateId: number, bytes: RenderBytes, name: string, intent?: RenderIntent): Promise<RenderResult>
  prepareAiImage(bytes: RenderBytes): Promise<RenderBytes>
  /** Correlation for structured render logs. Absent on test doubles. */
  bindListing?(hint: { batchId?: string; rowId?: string; offerId?: string; intentId?: string; jobId?: string; psdId?: string }): void
}

export interface RenderBatch {
  /** Rust grants this lease before the caller reads PSD/source bytes from OPFS. */
  withLane<T>(key: string, run: (lane: RenderLane) => Promise<T>): Promise<T>
  prepareAiImage(bytes: RenderBytes, cancelled?: () => boolean): Promise<RenderBytes>
  occupy(bytes: number): () => void
  disposeRender(): void
  dispose(): void
}

export function createPreparationClient(options: Omit<RuntimeHostOptions, "foreignBytes" | "memoryChanged">) {
  let tempBytes = 0
  let render: ReturnType<typeof createRuntimeHost> | undefined
  const ai = createRuntimeHost({ ...options, maxLanes: 1,
    foreignBytes: () => (render?.measure().occupiedBytes ?? 0) + tempBytes,
    memoryChanged: () => render?.dispatch(),
  })
  render = createRuntimeHost({ ...options,
    foreignBytes: () => ai.measure().occupiedBytes + tempBytes,
    memoryChanged: () => ai.dispatch(),
  })
  const media = render
  const occupy = (bytes: number) => {
    tempBytes += bytes
    ai.dispatch(); media.dispatch()
    let released = false
    return () => {
      if (released) return
      released = true
      tempBytes -= bytes
      ai.dispatch(); media.dispatch()
    }
  }
  return {
    maxLanes: options.maxLanes,
    occupy,
    createBatch(): RenderBatch {
      const rendering = media.createBatch()
      const recognition = ai.createBatch()
      return {
        withLane: rendering.withLane,
        occupy,
        prepareAiImage: (bytes, cancelled) => recognition.prepareAiImage(bytes, cancelled),
        disposeRender: rendering.dispose,
        dispose() { rendering.dispose(); recognition.dispose() },
      }
    },
    measure() {
      const rendering = media.measure()
      const recognition = ai.measure()
      return { ...rendering, residentBytes: rendering.residentBytes + recognition.residentBytes + tempBytes,
        aiLanes: recognition.lanes, aiPeaks: recognition.peaks, tempBytes }
    },
  }
}

const nav = (typeof navigator === "undefined" ? {} : navigator) as { hardwareConcurrency?: number; deviceMemory?: number }
export const renderClient = createPreparationClient({
  spawn: () => new Worker(new URL("./threaded-worker.ts", import.meta.url), { type: "module" }),
  maxLanes: Math.min(8, Math.max(1, (nav.hardwareConcurrency ?? 2) - 1)),
  // This remains a soft budget, not a browser-process memory ceiling.
  budgetBytes: ((nav.deviceMemory ?? 4) * 2 ** 30) / 4,
})

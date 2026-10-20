/**
 * Legacy single-instance Worker for golden tests and performance comparisons.
 * Production uses threaded-worker.ts; this is not its fallback.
 *
 * Rendering a 254 MiB template is seconds of single-threaded compositing; on
 * the main thread that is a frozen tab. The worker holds the instance, the
 * template handles and the peak memory, and answers one request at a time
 * This local chain is what stops two
 * `loadRenderModule` calls from splitting handles across two instances if a
 * message slips through during instantiate.
 *
 * Every request but `dropTemplate` writes a `[render-wasm]` console line as it
 * starts and as it ends — wall-clock ms, memory, the outcome or the failure —
 * including the host clock used by the module for per-stage timings.
 */
import { diagLog, elapsedMs, RENDER_LOG, stageCountFields, type DiagFields } from "@/lib/diag-log"
import {
  RenderWasmError,
  loadRenderModule,
  type RenderBytes,
  type RenderIntent,
  type RenderModule,
  type RenderResult,
} from "./wasm"

export type RenderRequest =
  | { id: number; op: "loadTemplate"; bytes: RenderBytes }
  | {
      id: number
      op: "renderProduct"
      templateId: number
      designBytes: RenderBytes
      designName: string
      intent?: RenderIntent
    }
  | { id: number; op: "prepareAiImage"; bytes: RenderBytes }
  | { id: number; op: "dropTemplate"; templateId: number }

export type RenderResponse =
  | { id: number; ok: true; value: unknown; memoryBytes: number }
  | { id: number; ok: false; code: string; message: string; memoryBytes: number }

/**
 * Built artifact, outside this Vite root (`web/`): in dev it is served as
 * `/@fs<repo>/wasm/dist/...`, in a build Vite content-hashes it into
 * `/assets/*.wasm` (immutable).
 */
const WASM_HREF = new URL("../../../wasm/dist/browser/render/render_wasm.wasm", import.meta.url).href

/** Dropped on a trap; the next request rebuilds it. */
let render: RenderModule | null = null
/** Started on construct so `warm()` overlaps the 2 MB fetch with the roster. */
let modulePromise: Promise<RenderModule> = loadRenderModule(WASM_HREF)
/** The one lane: each job awaits the previous, including instantiate. */
let lane: Promise<void> = Promise.resolve()
const workerId = crypto.randomUUID().slice(0, 8)

function log(request: RenderRequest, event: string, fields: DiagFields = {}): void {
  diagLog(RENDER_LOG, event, {
    worker: workerId,
    request: request.id,
    atMs: performance.timeOrigin + performance.now(),
    ...fields,
  })
}

/**
 * What a request is about, for the log: the design a render is for, the
 * template it renders against, or the size of the bytes it was handed.
 * `dropTemplate` is bookkeeping and stays quiet.
 */
function subject(request: RenderRequest): DiagFields {
  switch (request.op) {
    case "loadTemplate":
      return { bytes: request.bytes.length }
    case "renderProduct":
      return { design: request.designName, template: request.templateId }
    case "prepareAiImage":
      return { bytes: request.bytes.length }
    case "dropTemplate":
      return { template: request.templateId }
  }
}

/** What the answer says, beyond that it came: the handle, the slice count, the size. */
function outcome(request: RenderRequest, value: unknown): DiagFields {
  switch (request.op) {
    case "loadTemplate":
      return { template: value as number }
    case "renderProduct":
      return { slices: (value as RenderResult).slices.length }
    case "prepareAiImage":
      return { bytes: (value as RenderBytes).length }
    case "dropTemplate":
      return {}
  }
}

async function run(request: RenderRequest): Promise<{ value: unknown; transfer: Transferable[] }> {
  render ??= await modulePromise
  switch (request.op) {
    case "loadTemplate":
      return { value: render.loadTemplate(request.bytes), transfer: [] }
    case "renderProduct": {
      const result = render.renderProduct(
        request.templateId,
        request.designBytes,
        request.designName,
        request.intent,
      )
      // The crate's own per-stage counts ride the manifest (`stage_timing.rs`);
      // this is the one place they are read.
      const stages = stageCountFields((result.manifest as { stageTimings?: unknown })?.stageTimings)
      if (Object.keys(stages).length) {
        log(request, "renderProduct.stages", { design: request.designName, ...stages })
      }
      // Every slice is a view on the single buffer copied out of wasm memory,
      // so the whole render crosses back with one detach.
      const transfer = result.slices.length === 0 ? [] : [result.slices[0].bytes.buffer]
      return { value: result, transfer }
    }
    case "prepareAiImage": {
      const bytes = render.prepareAiImage(request.bytes)
      return { value: bytes, transfer: [bytes.buffer] }
    }
    case "dropTemplate":
      render.dropTemplate(request.templateId)
      return { value: null, transfer: [] }
  }
}

addEventListener("message", (event) => {
  const request = event.data as RenderRequest
  const logged = request.op !== "dropTemplate"
  const receivedAt = performance.now()
  // Clocked from when the lane reaches the request, not from when the message
  // arrived: a request that waited behind another render is not a slow one.
  let startedAt = 0
  const job = lane
    .then(() => {
      startedAt = performance.now()
      if (logged) log(request, `${request.op}.start`, { ...subject(request), queueMs: elapsedMs(receivedAt) })
      return run(request)
    })
    .then(
    ({ value, transfer }) => {
      const response: RenderResponse = {
        id: request.id,
        ok: true,
        value,
        memoryBytes: render?.memoryBytes() ?? 0,
      }
      if (logged) {
        log(request, `${request.op}.ok`, {
          ...subject(request),
          ...outcome(request, value),
          ms: elapsedMs(startedAt),
          memoryBytes: response.memoryBytes,
        })
      }
      postMessage(response, { transfer })
    },
    (error: unknown) => {
      // A `0` return is a clean failure and the instance stays usable. Anything
      // else — a Rust panic, which is `panic = abort` on wasm32, or a refused
      // `memory.grow` — leaves memory in an unspecified state with nothing to
      // unwind (rust/crates/render-wasm/src/lib.rs "Traps"). Discard the instance;
      // the next request instantiates a fresh one, and every template handle
      // the caller was holding is gone with it.
      const memoryBytes = render?.memoryBytes() ?? 0
      const clean = error instanceof RenderWasmError
      if (!clean) {
        render = null
        modulePromise = loadRenderModule(WASM_HREF)
      }
      const response: RenderResponse = {
        id: request.id,
        ok: false,
        code: clean ? error.code : "RENDER_TRAP",
        message: clean
          ? error.message
          : `${String(error)} — the render module was discarded; reload the template`,
        memoryBytes,
      }
      // A failed `dropTemplate` is still worth a line: it says the instance went.
      log(request, `${request.op}.fail`, {
        ...subject(request),
        ms: elapsedMs(startedAt),
        memoryBytes,
        code: response.code,
        message: response.message,
      })
      postMessage(response)
    },
  )
  lane = job.then(
    () => undefined,
    () => undefined,
  )
})

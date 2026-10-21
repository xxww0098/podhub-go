import { diagLog, RENDER_LOG } from "@/lib/diag-log"
import { renderFailureCode } from "./psd-admission"
import { DEFAULT_RENDER_INTENT, parseRenderResult } from "./wasm"

const children: Worker[] = []
const BrowserWorker = globalThis.Worker
const workerId = crypto.randomUUID().slice(0, 8)
let failed = false
let collect = false
function fatal(reason: unknown) {
  if (failed) return
  failed = true
  for (const worker of children) worker.terminate()
  postMessage({ fatal: true, code: "RENDER_TRAP", message: String(reason) })
}

// Keep Rayon's allocator/TLS/start protocol, but own child lifetimes and trap
// reporting. This is bootstrap only: no product queue or dispatch lives in JS.
globalThis.Worker = function () {
  const Worker = BrowserWorker
  const worker = new Worker(new URL("./compute-worker.ts", import.meta.url), { type: "module" })
  children.push(worker)
  worker.addEventListener("error", () => fatal("A render compute Worker failed"))
  worker.addEventListener("messageerror", () => fatal("A render compute Worker message failed"))
  worker.addEventListener("message", ({ data }) => {
    if (data?.type === "render-thread-failed") fatal(data.message)
  })
  return worker
} as unknown as typeof Worker

let runtime: import("../../../wasm/dist/browser/render/threaded/index.js").RenderRuntime | undefined
let starting: Promise<void> | undefined

addEventListener("message", async ({ data }) => {
  if (data.op === "listing-log-collect") {
    collect = data.enabled === true
    return
  }
  if (data.op === "shutdown") {
    for (const worker of children) worker.terminate()
    close()
    return
  }
  if (failed) return
  const started = performance.now()
  const logged = ["retain", "render", "prepare"].includes(data.op)
  const log = (event: string, errorCode?: string) => {
    if (logged) diagLog(RENDER_LOG, `${data.op}.${event}`, {
      worker: workerId, request: data.id, lease: data.leaseId, atMs: performance.timeOrigin + performance.now(),
      ms: performance.now() - started,
    })
    if (!collect || !logged) return
    const phase = event === "start" ? "start" : "end"
    postMessage({
      listingLog: {
        level: errorCode ? "error" : "info",
        module: "render",
        event: `${data.op}.${phase}`,
        ...(event === "start" ? {} : { durationMs: Math.round(performance.now() - started) }),
        ...(errorCode ? { errorCode } : {}),
        ...(data.listing?.rowId ? { rowId: data.listing.rowId } : {}),
        ...(data.listing ? { correlation: data.listing } : {}),
        fields: { worker: workerId },
      },
    })
  }
  log("start")
  try {
    let value: unknown
    let transfer: Transferable[] = []
    if (data.op === "init") {
      if (starting) throw new Error("RENDER_ALREADY_INITIALIZED")
      starting = (async () => {
        if (!crossOriginIsolated) throw new Error("RENDER_ISOLATION_REQUIRED")
        const wasm = await import("../../../wasm/dist/browser/render/threaded/index.js")
        await wasm.default()
        await wasm.initThreadPool(data.threads)
        runtime = new wasm.RenderRuntime(data.threads, data.budgetBytes)
        for (const owner of data.owners) runtime.register_owner(owner)
      })()
      await starting
    } else {
      await starting
      if (!runtime) throw new Error("RENDER_NOT_INITIALIZED")
      switch (data.op) {
        case "acquire": value = JSON.parse(await runtime.acquire(data.owner, data.key)); break
        case "retain": value = await runtime.retain_template(data.leaseId, data.bytes); break
        case "render": {
          const packed = await runtime.render(data.leaseId, data.templateId, data.bytes, data.name,
            JSON.stringify(data.intent ?? DEFAULT_RENDER_INTENT))
          const buffer = packed.buffer
          if (!(buffer instanceof ArrayBuffer)) throw new Error("RENDER_PROTOCOL: result must own its buffer")
          value = parseRenderResult(new Uint8Array(buffer, packed.byteOffset, packed.byteLength))
          transfer = [buffer]
          break
        }
        case "prepare": {
          const bytes = await runtime.prepare_image(data.leaseId, data.bytes)
          value = bytes
          transfer = [bytes.buffer]
          break
        }
        case "release": runtime.release(data.leaseId); break
        case "registerOwner": runtime.register_owner(data.owner); break
        case "disposeOwner": runtime.dispose_owner(data.owner); break
        case "external": runtime.set_external_bytes(data.bytes); return
        case "measure": break
        default: throw new Error("RENDER_PROTOCOL")
      }
    }
    log("ok")
    if (!failed) postMessage({ id: data.id, ok: true, value, stats: JSON.parse(runtime!.measure()) }, { transfer })
  } catch (error) {
    // `PSD_RENDER_*` / `MEDIA_*` crate codes precede ` during `; a bare
    // `\bRENDER_` match never saw them and reported RENDER_FAILED instead.
    const code = renderFailureCode(String(error)) ?? "RENDER_FAILED"
    log("fail", code)
    if (error instanceof WebAssembly.RuntimeError) { fatal(error); return }
    if (!failed) postMessage({ id: data.id, ok: false, message: String(error),
      code,
      stats: runtime ? JSON.parse(runtime.measure()) : undefined })
  }
})

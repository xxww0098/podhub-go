import { createPreparationClient } from "../src/render/client"
import templateUrl from "./fixtures/psd/synthetic/tiny-smart-mask-warp-groups.psd?url"
import designUrl from "./fixtures/psd/synthetic/replacement-transparent-edges.png?url"
import type { RenderResult } from "../src/render/wasm"

const hashes = [
  "sha256:a7e5d5311407031fbb94332483c195b5d3bd4bd190f92e89e317cdce3ae3b50d",
  "sha256:211b562c146f6c8ec22e8ff362b903c42ff7a22601c22a29fe68f145c002d5dc",
]
const read = async (url: string) => {
  const response = await fetch(url)
  if (!response.ok) throw new Error(`Fixture fetch failed: ${response.status}`)
  return new Uint8Array(await response.arrayBuffer())
}
const digest = async (bytes: Uint8Array<ArrayBuffer>) => "sha256:" + Array.from(
  new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)), b => b.toString(16).padStart(2, "0"),
).join("")
const assert = (condition: unknown, message: string) => { if (!condition) throw new Error(message) }

export async function verifyThreadedRenderer() {
  assert(crossOriginIsolated, "The page must be cross-origin isolated")
  const [template, design] = await Promise.all([read(templateUrl), read(designUrl)])
  const key = await digest(template)
  const workers: Worker[] = []
  let releaseInit!: () => void
  let observeInit!: () => void
  const initialized = new Promise<void>(resolve => { observeInit = resolve })
  const client = createPreparationClient({ maxLanes: 2, budgetBytes: 512 * 2 ** 20, requestTimeoutMs: 3000,
    spawn: () => {
      const worker = new Worker(new URL("../src/render/threaded-worker.ts", import.meta.url), { type: "module" })
      if (!workers.length) {
        // Hold the real WASM initialization reply at the host boundary so Stop
        // is tested deterministically while another owner shares its ready.
        const hold = (event: MessageEvent) => {
          if (event.data.id !== 1) return
          event.stopImmediatePropagation()
          releaseInit = () => {
            worker.removeEventListener("message", hold)
            worker.dispatchEvent(new MessageEvent("message", { data: event.data }))
          }
          observeInit()
        }
        worker.addEventListener("message", hold)
      }
      workers.push(worker)
      return worker
    },
  })
  const batch = client.createBatch()
  let parses = 0
  let failureCode: string | undefined
  const render = (input = design) => batch.withLane(key, async lane => {
    let id = lane.heldTemplate()?.id
    if (!id) { parses++; id = await lane.retainTemplate(key, template.slice()) }
    return lane.renderProduct(id, input.slice(), "check.png")
  })
  const check = async (result: RenderResult) => {
    assert(result.slices.length === 2, "Expected two output slices")
    for (const [index, slice] of result.slices.entries()) {
      assert(slice.width === 56 && slice.height === 42, "Output dimensions changed")
      assert(await digest(slice.bytes) === hashes[index], "Output pixels changed")
    }
  }
  try {
    assert(workers.length === 0, "Creating a batch must not create Workers")
    const cancelled = client.createBatch()
    let entered = false
    const stopped = cancelled.withLane(key, async () => { entered = true }).then(
      () => { throw new Error("A cancelled initialization caller must reject") },
      error => assert(error.code === "RENDER_CANCELLED", "Initialization cancellation must keep its code"),
    )
    const first = render()
    await initialized
    const duringInit = client.createBatch()
    const registered = duringInit.withLane(key, async lane => {
      const id = lane.heldTemplate()?.id ?? await lane.retainTemplate(key, template.slice())
      return lane.renderProduct(id, design.slice(), "registered.png")
    })
    cancelled.dispose()
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      await Promise.race([stopped, new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("Stop waited for shared initialization")), 1000)
      })])
      assert(!entered, "Cancelled initialization must not read PSD bytes")
    } finally { clearTimeout(timer); releaseInit() }
    await check(await first)
    try { await check(await registered) } finally { duringInit.dispose() }
    const parallel = await Promise.all(Array.from({ length: 6 }, () => render()))
    await Promise.all(parallel.map(check))
    assert(parses === 1, "Concurrent jobs must share one parsed template")
    assert(workers.length === 1, "Parallel jobs must share one runtime")
    for (let i = 0; i < 32; i++) {
      const transient = client.createBatch()
      try {
        await transient.withLane(key, async lane => assert(!!lane.heldTemplate(), "New owners must reuse the live template"))
      } finally { transient.dispose() }
    }
    assert(Object.keys(client.measure().peaks).length === 1, "Unchanged peak replies must preserve the current snapshot")
    let rejected = false
    try { await render(new Uint8Array([1, 2, 3])) } catch { rejected = true }
    assert(rejected, "Bad image input must fail cleanly")
    await check(await render())
    assert(workers.length === 1, "A clean input failure must not destroy the runtime")
    // A physically terminated coordinator cannot reply. The outside watchdog
    // must reject the request, invalidate all handles, and allow reconstruction.
    try {
      await batch.withLane(key, async lane => {
        workers[0].terminate()
        return lane.renderProduct(lane.heldTemplate()!.id, design.slice(), "interrupted.png")
      })
    } catch (error) { failureCode = (error as { code?: string }).code }
    assert(failureCode === "RENDER_WATCHDOG", "Watchdog must reject a dead runtime")
    await check(await render())
    assert(workers.length === 2 && parses === 2, "Recovery must create a new runtime and parse again")
    // Wave-0 structural admission crosses the threaded boundary with its
    // stable code and Chinese remediation, and is a clean (runtime-preserving)
    // refusal. Checked last: retaining another key re-keys the lane and drops
    // its held template, which would skew the parse counts above.
    const deep = template.slice()
    new DataView(deep.buffer).setUint16(22, 16)
    const deepKey = await digest(deep)
    let refusal: { code?: string; message?: string } | undefined
    try { await batch.withLane(deepKey, lane => lane.retainTemplate(deepKey, deep.slice())) } catch (error) { refusal = error as typeof refusal }
    assert(refusal?.code === "PSD_RENDER_UNSUPPORTED_DEPTH", `16-bit template must be refused, got ${refusal?.code}`)
    assert(refusal?.message?.includes("8 位/通道"), "The refusal must carry the Chinese remediation")
    assert(Object.keys(client.measure().peaks).length === 0, "Evicted templates must clear their observed peaks")
    await check(await render())
    assert(workers.length === 2, "A structural refusal must not destroy the runtime")
    batch.disposeRender()
    const prepared = await batch.prepareAiImage(design.slice())
    assert(prepared.length > 0 && workers.length === 3, "AI has an independent runtime after render disposal")
    return { passed: true, initializationCancellation: true, ownerRegistrations: 33, parses, runtimes: workers.length, failureCode, structuralRefusal: refusal?.code, memory: client.measure() }
  } finally {
    batch.dispose()
    assert(client.measure().residentBytes === 0, "Disposal must release the runtime")
  }
}

/** Real-asset comparison. Both paths transfer every input/result, warm one
 * render per compute lane, and verify hashes outside the timed interval.
 * Memory is WASM linear-memory high-water, NOT browser-process RSS. */
export async function benchThreadedRenderer(templateHref: string, designHrefs: string[], threads: number, jobs: number, shared: boolean) {
  const [template, ...designs] = await Promise.all([read(templateHref), ...designHrefs.map(read)])
  const key = await digest(template)
  const workers: Worker[] = []
  const client = createPreparationClient({ maxLanes: threads, budgetBytes: 2 ** 31, requestTimeoutMs: 180000,
    spawn: () => { const w = new Worker(new URL("../src/render/threaded-worker.ts", import.meta.url), { type: "module" }); workers.push(w); return w },
  })
  const batch = client.createBatch()
  const memory = new Map<Worker, number>()
  const legacy = shared ? [] : Array.from({ length: threads }, () => {
    const w = new Worker(new URL("../src/render/worker.ts", import.meta.url), { type: "module" }); workers.push(w); return w
  })
  const call = (worker: Worker, args: object) => new Promise<unknown>((resolve, reject) => {
    worker.onerror = reject
    worker.onmessage = ({ data }) => { memory.set(worker, data.memoryBytes); data.ok ? resolve(data.value) : reject(new Error(data.message)) }
    const input = args as { bytes?: Uint8Array<ArrayBuffer>; designBytes?: Uint8Array<ArrayBuffer> }
    worker.postMessage({ id: 1, ...args }, [(input.bytes ?? input.designBytes)!.buffer])
  })
  try {
    const start = performance.now()
    const ids = await Promise.all(legacy.map(w => call(w, { op: "loadTemplate", bytes: template.slice() })))
    const render = (job: number): Promise<RenderResult> => shared
      ? batch.withLane(key, async lane => {
        const id = lane.heldTemplate()?.id ?? await lane.retainTemplate(key, template.slice())
        return lane.renderProduct(id, designs[job % designs.length].slice(), "bench.jpg")
      })
      : call(legacy[job % threads], { op: "renderProduct", templateId: ids[job % threads], designBytes: designs[job % designs.length].slice(), designName: "bench.jpg" }) as Promise<RenderResult>
    await Promise.all(Array.from({ length: threads }, (_, i) => render(i)))
    const setupMs = performance.now() - start
    const began = performance.now()
    const results: RenderResult[] = []
    // The legacy path admits one request per Worker; shared dispatch lives in Rust.
    await Promise.all(Array.from({ length: threads }, async (_, lane) => {
      for (let i = lane; i < jobs; i += threads) results[i] = await render(i)
    }))
    const renderMs = performance.now() - began
    const wasmBytes = shared ? client.measure().residentBytes : [...memory.values()].reduce((a, b) => a + b, 0)
    const outputs = await Promise.all(results.map(async result => Promise.all(result.slices.map(async s => ({
      width: s.width, height: s.height, hash: await digest(s.bytes),
    })))))
    return { shared, threads, jobs, setupMs, renderMs, wasmBytes, outputs }
  } finally { batch.dispose(); for (const w of workers) w.terminate() }
}

Object.assign(window, { verifyThreadedRenderer, benchThreadedRenderer })

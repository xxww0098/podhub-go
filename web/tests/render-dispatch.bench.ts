// Browser dispatch probe, NOT shared-memory WASM. Bundle with bun build, then serve
// the bundle beside the committed artifact wasm/dist/browser/render/render_wasm.wasm
// plus template.psd and design-{0,1}.jpg over localhost.
// Call runDispatchBench(lanes, jobs, batched) in a blank page importing the bundle.
import { createRenderModule, type RenderResult } from "../src/render/wasm"

if (typeof document === "undefined") {
  let render: ReturnType<typeof createRenderModule>
  let template: number
  let designs: Uint8Array[]
  onmessage = async ({ data }) => {
    try {
      if (data.init) {
        const { instance } = await WebAssembly.instantiate(data.wasm, {
          env: { performance_now: () => performance.now() },
        })
        render = createRenderModule(instance.exports)
        template = render.loadTemplate(data.template)
        designs = data.designs
        postMessage({ ready: true, memoryBytes: render.memoryBytes() })
        return
      }
      for (const job of data.jobs) {
        const start = performance.now()
        const result = render.renderProduct(template, designs[job % designs.length], "bench.png")
        const computeMs = performance.now() - start
        postMessage({ job, computeMs, result, memoryBytes: render.memoryBytes() },
          { transfer: result.slices.length ? [result.slices[0].bytes.buffer] : [] })
      }
    } catch (error) {
      postMessage({ error: String(error) })
    }
  }
}

export async function runDispatchBench(lanes: number, jobs: number, batched: boolean) {
  if (lanes < 1 || jobs < lanes || jobs % lanes) throw new Error("Invalid batch size")
  const read = async (name: string) => {
    const response = await fetch(new URL(name, import.meta.url))
    if (!response.ok) throw new Error(`Failed to fetch ${name}`)
    return new Uint8Array(await response.arrayBuffer())
  }
  const [wasm, template, ...designs] = await Promise.all([
    read("render_wasm.wasm"), read("template.psd"), read("design-0.jpg"), read("design-1.jpg"),
  ])
  const workers = Array.from({ length: lanes }, () => new Worker(import.meta.url, { type: "module" }))
  try {
    await Promise.all(workers.map(worker => new Promise<void>((resolve, reject) => {
      worker.onerror = reject
      worker.onmessage = ({ data }) => data.error ? reject(new Error(data.error)) : resolve()
      const input = template.slice()
      worker.postMessage({ init: true, wasm, template: input, designs }, [input.buffer])
    })))
    const computeMs = Array(lanes).fill(0)
    const memoryBytes = Array(lanes).fill(0)
    const results: { job: number; result: RenderResult }[] = []
    // Both modes use identical messages and outputs; batching removes only
    // the host's render-by-render round trip. Inputs are preloaded in both.
    const start = performance.now()
    await Promise.all(workers.map((worker, lane) => new Promise<void>((resolve, reject) => {
      const queue = Array.from({ length: jobs / lanes }, (_, index) => lane + index * lanes)
      let completed = 0
      worker.onerror = reject
      worker.onmessage = ({ data }) => {
        if (data.error) { reject(new Error(data.error)); return }
        computeMs[lane] += data.computeMs
        memoryBytes[lane] = Math.max(memoryBytes[lane], data.memoryBytes)
        results.push(data)
        if (++completed === queue.length) resolve()
        else if (!batched) worker.postMessage({ jobs: [queue[completed]] })
      }
      worker.postMessage({ jobs: batched ? queue : [queue[0]] })
    })))
    const wallMs = performance.now() - start
    // Validate actual returned bytes outside timing, not just advertised hashes.
    const hashes = []
    for (const { job, result } of results.sort((a, b) => a.job - b.job)) {
      const slices = []
      for (const slice of result.slices) {
        const digest = await crypto.subtle.digest("SHA-256", slice.bytes)
        const hash = "sha256:" + Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, "0")).join("")
        if (hash !== slice.contentHash) throw new Error("Output hash mismatch")
        slices.push([slice.width, slice.height, hash])
      }
      hashes.push({ job, slices })
    }
    return { lanes, jobs, batched, wallMs, computeMs, memoryBytes, hashes }
  } finally {
    workers.forEach(worker => worker.terminate())
  }
}

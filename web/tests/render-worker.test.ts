import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"
import type { RenderRequest, RenderResponse } from "../src/render/worker"

test("worker diagnostics correlate real WASM stages with timestamps and request durations", async () => {
  const original = { fetch: globalThis.fetch, addEventListener: globalThis.addEventListener, postMessage: globalThis.postMessage, log: console.log }
  const logs: string[] = []
  let receive!: (event: { data: RenderRequest }) => void
  let reply!: (response: RenderResponse) => void
  Object.assign(globalThis, {
    fetch: async () => new Response(readFileSync(new URL("../../wasm/dist/browser/render/render_wasm.wasm", import.meta.url)), { headers: { "Content-Type": "application/wasm" } }),
    addEventListener: (_type: string, handler: typeof receive) => { receive = handler },
    postMessage: (response: RenderResponse) => reply(response),
  })
  console.log = line => { logs.push(String(line)) }
  const send = (data: RenderRequest) => new Promise<RenderResponse>(resolve => { reply = resolve; receive({ data }) })
  try {
    await import("../src/render/worker")
    const template = await send({ id: 1, op: "loadTemplate", bytes: readFileSync(new URL("../../fixtures/psd/synthetic/tiny-smart-mask-warp-groups.psd", import.meta.url)) })
    assert.equal(template.ok, true)
    const rendered = await send({ id: 2, op: "renderProduct", templateId: template.value as number, designName: "timing.png", designBytes: readFileSync(new URL("../../fixtures/psd/synthetic/replacement-transparent-edges.png", import.meta.url)) })
    assert.equal(rendered.ok, true)
    const failed = await send({ id: 3, op: "loadTemplate", bytes: new Uint8Array([1, 2, 3]) })
    assert.equal(failed.ok, false)
    const starts = logs.filter(line => line.includes(".start "))
    assert.equal(starts.length, 3)
    for (const line of logs) {
      assert.match(line, /worker=[a-f0-9]{8} request=[123] atMs=\d+/)
      const at = Number(line.match(/atMs=(\d+)/)![1])
      assert.ok(Math.abs(Date.now() - at) < 10_000, "worker timestamp uses the shared epoch, not its private time origin")
    }
    assert.ok(logs.filter(line => /\.(ok|fail) /.test(line)).every(line => / ms=\d+/.test(line)))
    assert.ok(starts.every(line => / queueMs=\d+/.test(line)))
    assert.match(logs.find(line => line.includes("renderProduct.stages")) ?? "", /encodeTotal=\d+\/\d+\.\dms/)
  } finally {
    globalThis.fetch = original.fetch
    globalThis.addEventListener = original.addEventListener
    globalThis.postMessage = original.postMessage
    console.log = original.log
  }
})

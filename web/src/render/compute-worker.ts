// Lifecycle adapter for wasm-bindgen-rayon's thread-start protocol. Rust's
// Rayon loop blocks this Worker; trap reporting must surround that loop here.
addEventListener("message", async (event) => {
  if (event.data?.type !== "wasm_bindgen_worker_init") return
  event.stopImmediatePropagation()
  try {
    const wasm = await import("../../../wasm/dist/browser/render/threaded/index.js")
    await wasm.default(event.data.init)
    postMessage({ type: "wasm_bindgen_worker_ready" })
    wasm.wbg_rayon_start_worker(event.data.receiver)
  } catch (error) {
    postMessage({ type: "render-thread-failed", message: String(error) })
  }
})

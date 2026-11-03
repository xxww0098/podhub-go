//! Host-provided diagnostic clock. It never participates in admission or output.

#[cfg(target_family = "wasm")]
#[wasm_bindgen::prelude::wasm_bindgen]
extern "C" {
    #[wasm_bindgen(js_namespace = performance, js_name = now)]
    fn performance_now_ms() -> f64;
}

pub(crate) fn initialize_stage_clock() {
    #[cfg(target_family = "wasm")]
    render::set_stage_clock(performance_now_ms);
}

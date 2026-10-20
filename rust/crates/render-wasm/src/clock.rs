//! Host-provided diagnostic clock. It never participates in admission or output.

#[cfg(all(target_family = "wasm", not(feature = "threads")))]
#[link(wasm_import_module = "env")]
unsafe extern "C" {
    fn performance_now() -> f64;
}

#[cfg(all(target_family = "wasm", feature = "threads"))]
#[wasm_bindgen::prelude::wasm_bindgen]
extern "C" {
    #[wasm_bindgen(js_namespace = performance, js_name = now)]
    fn performance_now_ms() -> f64;
}

#[cfg(all(target_family = "wasm", not(feature = "threads")))]
fn performance_now_ms() -> f64 {
    // SAFETY: the JS boundary supplies this import and returns a number.
    unsafe { performance_now() }
}

pub(crate) fn initialize_stage_clock() {
    #[cfg(target_family = "wasm")]
    render::set_stage_clock(performance_now_ms);
}

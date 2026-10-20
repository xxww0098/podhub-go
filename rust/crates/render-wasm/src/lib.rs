//! Browser runtime over [`render`].
//!
//! # Production: `threads`
//!
//! `scheduler::RenderRuntime` owns metadata-only FIFO admission, leases and
//! shared `Arc<ParsedTemplate>` values. Rayon executes parse/render jobs against
//! one shared WASM memory; the coordinator remains responsive while awaiting
//! them. `web/src/render/threaded-client.ts` owns runtime lifetimes and the
//! external watchdog; `threaded-worker.ts` adapts messages to bindgen calls.
//! Cancelling busy work retains its Rust lease until compute actually finishes.
//! A trap requires destroying the entire runtime and all compute Workers, not
//! replacing one thread. Failed jobs are not automatically replayed.
//!
//! # Legacy C ABI: golden tests and performance comparisons
//!
//! The raw functions exported from `abi` remain for `web/src/render/worker.ts` and compute
//! golden tests. They are not a production fallback. Their caller serializes
//! access to one instance and exchanges integer handles and byte buffers:
//!
//! 1. `alloc(len)` → write `len` bytes into memory at that pointer.
//! 2. `load_template(ptr, len)` → template handle (`0` = error), then `free`
//!    the input buffer. One handle serves a whole batch of designs.
//!    `take_stage_timings()` → result handle whose bytes are the stage-timing
//!    JSON object, not a packed render. The next `render_product` resets the
//!    stage clock and drops whatever was not taken.
//! 3. `render_product(...)` → result handle (`0` = error).
//! 4. `result_ptr` / `result_len` → one buffer holding a **compact JSON
//!    document, one `\n` byte, then the concatenated slice bytes**:
//!
//!    ```text
//!    {"manifest":{..},"slices":[{"groupName":..,"index":..,"fileName":..,
//!      "width":..,"height":..,"contentHash":"sha256:..","offset":..,"len":..}]}\n
//!    <slice 0 JPEG><slice 1 JPEG>...
//!    ```
//!
//!    The JSON is compact and therefore holds no raw newline, so
//!    `indexOf(0x0A)` finds its end. `offset` is measured from the byte after
//!    that newline, which keeps it independent of the header's own length:
//!    `const base = nl + 1; bytes.subarray(base + offset, base + offset + len)`.
//!    One copy out of wasm memory for the whole render, not one per slice.
//! 5. `drop_result(handle)` once the bytes are out; `drop_template(handle)`
//!    when the template is done.
//!
//! On a `0` return, `last_error_ptr` / `last_error_len` hold a UTF-8 message
//! until the next failed call.
//!
//! # Traps
//!
//! Rust panics abort on `wasm32-unknown-unknown`; there is no unwinding recovery.
//! After any trap, discard the legacy instance or the entire threaded runtime:
//! shared allocator / lock state may be inconsistent and must not be reused.

mod abi;
mod clock;
mod packing;

// Keep the C ABI export surface at the crate seam; ownership stays in abi.
pub use abi::{
    alloc, drop_result, drop_template, free, last_error_len, last_error_ptr, load_template,
    prepare_ai_image, render_product, result_len, result_ptr, take_stage_timings,
};

#[cfg(feature = "threads")]
mod scheduler;
#[cfg(feature = "threads")]
pub use wasm_bindgen_rayon::init_thread_pool;

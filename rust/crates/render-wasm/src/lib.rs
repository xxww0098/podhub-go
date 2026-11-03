//! Browser render runtime over [`render`].
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
//! # Render result framing
//!
//! A render returns one buffer holding a **compact JSON document, one `\n`
//! byte, then the concatenated slice bytes**:
//!
//! ```text
//! {"manifest":{..},"slices":[{"groupName":..,"index":..,"fileName":..,
//!   "width":..,"height":..,"contentHash":"sha256:..","offset":..,"len":..}]}\n
//! <slice 0 JPEG><slice 1 JPEG>...
//! ```
//!
//! The JSON is compact and therefore holds no raw newline, so `indexOf(0x0A)`
//! finds its end. `offset` is measured from the byte after that newline, which
//! keeps it independent of the header's own length:
//! `const base = nl + 1; bytes.subarray(base + offset, base + offset + len)`.
//! `web/src/render/wasm.ts` decodes it.
//!
//! # Traps
//!
//! Rust panics abort on `wasm32-unknown-unknown`; there is no unwinding
//! recovery. After any trap, discard the entire runtime: shared allocator and
//! lock state may be inconsistent and must not be reused.

#[cfg(feature = "threads")]
mod clock;
#[cfg(any(feature = "threads", test))]
mod packing;
#[cfg(any(feature = "threads", test))]
mod scheduler;
#[cfg(feature = "threads")]
pub use wasm_bindgen_rayon::init_thread_pool;

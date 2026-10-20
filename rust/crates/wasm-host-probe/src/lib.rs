//! Proves a wazero host can satisfy the import `listing-core-wasm` documents
//! (`env.fill_random`) and can observe an abort trap. This is not listing-core.
//!
//! The `env.fill_random` import exists only on `wasm32`. Hosted targets have
//! no such symbol, so the whole module is wasm32-only: `cargo test` at the
//! workspace root builds every member natively, and an ungated link would fail
//! there with "Undefined symbols: _fill_random". The real check is the wazero
//! host in `internal/listing/core/service/engine`, not a native build.

#![cfg(target_arch = "wasm32")]

use std::cell::Cell;

#[link(wasm_import_module = "env")]
unsafe extern "C" {
    fn fill_random(ptr: *mut u8, len: usize);
}

thread_local! {
    static HITS: Cell<u32> = const { Cell::new(0) };
}

/// Sums `len` bytes written by the host import.
///
/// # Safety
///
/// `fill_random` must write `len` initialized bytes.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn sum_random(len: u32) -> u32 {
    let len = len as usize;
    let mut buf = vec![0u8; len];
    unsafe { fill_random(buf.as_mut_ptr(), buf.len()) };
    HITS.with(|hits| hits.set(hits.get().saturating_add(1)));
    buf.iter().fold(0u32, |sum, byte| sum.wrapping_add(*byte as u32))
}

#[unsafe(no_mangle)]
pub extern "C" fn hits() -> u32 {
    HITS.with(|hits| hits.get())
}

#[unsafe(no_mangle)]
pub extern "C" fn boom() {
    panic!("probe trap");
}

//! Random bytes for minted complex-item ids (`content_policy::mint_item_id`,
//! invoked through `listing_core::ops::Ctx::ids` inside `edit_row`).
//!
//! Slice 03's decision (`specs/browser-owned-listing/slices/03-core-wasm.md`
//! "决定"): "随机只经 `env.fill_random`,所以 wasm 目标上不能出现
//! `getrandom`" — the browser host supplies bytes via
//! `crypto.getRandomValues`; the wasm32 artifact never links a Rust RNG
//! (verified with `cargo tree`, same as slice 01 did for `listing-core`
//! itself).

#[cfg(target_family = "wasm")]
#[link(wasm_import_module = "env")]
unsafe extern "C" {
    /// The host writes exactly `len` random bytes starting at `ptr` (a
    /// pointer into this module's own linear memory) and nothing else.
    fn fill_random(ptr: *mut u8, len: usize);
}

#[cfg(target_family = "wasm")]
fn host_fill_random(buf: &mut [u8]) {
    // SAFETY: `buf` is a valid, writable slice in this module's own linear
    // memory (it is a local stack array, not a pointer smuggled in from the
    // host); `env.fill_random` is documented above to write exactly
    // `buf.len()` bytes starting at that address and touch nothing else.
    unsafe { fill_random(buf.as_mut_ptr(), buf.len()) }
}

/// Native builds only run under `cargo test -p listing-core-wasm` — there is
/// no JS host to import `env.fill_random` from outside wasm32. Those tests
/// need distinct bytes, not entropy (none of slice 02's golden fixtures mint
/// a new complex-item id, so this path is not on the byte-exact parity gate),
/// so a counter stands in. Never compiled into the browser artifact.
#[cfg(not(target_family = "wasm"))]
fn host_fill_random(buf: &mut [u8]) {
    use std::sync::atomic::{AtomicU64, Ordering};
    static COUNTER: AtomicU64 = AtomicU64::new(1);
    let n = u128::from(COUNTER.fetch_add(1, Ordering::Relaxed));
    let bytes = n.to_be_bytes();
    buf.copy_from_slice(&bytes[16 - buf.len()..]);
}

/// Builds a fresh `Ctx::ids` closure: one host round trip per 16-byte id.
pub(crate) fn new_id_source() -> impl FnMut() -> [u8; 16] + Send {
    || {
        let mut buf = [0u8; 16];
        host_fill_random(&mut buf);
        buf
    }
}

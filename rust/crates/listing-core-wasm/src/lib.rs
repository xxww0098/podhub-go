//! Browser WASM boundary over [`listing_core`] (browser-owned-listing slice
//! 03, `specs/browser-owned-listing/slices/03-core-wasm.md`).
//!
//! Field rules have exactly one owner — `listing_core` — and this crate is
//! the only way the browser reaches it. It follows the stable wasm32 C ABI
//! pattern `rust/crates/render-wasm/src/lib.rs` already established in this repo
//! (no wasm-bindgen, no threads, no nightly): integer handles and byte
//! buffers over one instance's linear memory, one call in flight at a time.
//!
//! ```text
//! alloc(len) -> ptr            free(ptr, len)
//! schema_load(ptr, len) -> h   // SchemaMaterial JSON in; 0 on failure
//! schema_drop(h)
//! call(op, h, ptr, len) -> r   // 0 success, non-zero failure
//! result_ptr() / result_len() / drop_result()
//! last_error_ptr() / last_error_len()
//! import env.fill_random(ptr, len)
//! ```
//!
//! Two differences from render-wasm's legacy ABI, both deliberate (slice 03
//! "契约与缝"):
//!
//! 1. **A schema handle is a resident value, not a per-call argument.** Every
//!    row op takes `h` and never a schema snapshot in its own JSON body —
//!    `listing_core::ops::LeanRow`'s whole reason to exist is that a
//!    `CategorySchemaSnapshot` must not travel once per row (see its module
//!    docs and this plan's README "已知未知" row on `RowPayload.schema_snapshot`).
//!    A thousand `revalidate` calls against one open Card share one resident
//!    [`listing_core::ops::SchemaMaterial`].
//! 2. **`result_ptr`/`result_len`/`drop_result` take no handle.** Unlike
//!    render-wasm (which serves a whole batch of concurrent render results),
//!    `call()` is strictly request/response — one result is ever pending, so
//!    a singleton slot replaces render-wasm's handle table.
//!
//! # Traps
//!
//! Same contract as render-wasm: Rust panics abort on `wasm32-unknown-unknown`
//! with no unwinding recovery. After any trap, the host must discard the
//! instance — shared allocator/table state may be inconsistent. Every
//! *expected* failure (bad JSON, unknown schema handle, an op's own business
//! rule) is a `0`/non-zero return plus a `{code, message}` in
//! `last_error_*`, never a panic — see `error.rs`.

use std::cell::{Cell, RefCell};
use std::collections::HashMap;

mod dispatch;
mod error;
mod ids;
mod materials;
mod ocr_answer;
mod ops_row;
mod schema_io;
mod send_state;
mod stage_gate;
mod variants;
mod wb;

use error::CoreError;
use materials::Material;

thread_local! {
    static SCHEMAS: RefCell<HashMap<u32, Material>> = RefCell::new(HashMap::new());
    static NEXT_SCHEMA_HANDLE: Cell<u32> = const { Cell::new(1) };
    /// `call()` is request/response: at most one result is ever pending — see
    /// this module's doc comment on why that is a singleton slot, not
    /// render-wasm's per-handle table.
    static RESULT: RefCell<Option<Vec<u8>>> = const { RefCell::new(None) };
    static LAST_ERROR: RefCell<Vec<u8>> = const { RefCell::new(Vec::new()) };
}

fn next_schema_handle() -> u32 {
    NEXT_SCHEMA_HANDLE.with(|next| {
        let handle = next.get();
        next.set(handle.wrapping_add(1).max(1));
        handle
    })
}

fn set_last_error(bytes: Vec<u8>) {
    LAST_ERROR.with(|slot| *slot.borrow_mut() = bytes);
}

/// # Safety
///
/// `ptr` must be a pointer returned by [`alloc`] with the same `len`, and the
/// caller must have written `len` initialised bytes to it. The caller must not
/// mutate or free the buffer while the returned slice is in use.
unsafe fn input(ptr: *const u8, len: usize) -> Result<&'static [u8], &'static str> {
    if len == 0 {
        return Ok(&[]);
    }
    if ptr.is_null() {
        return Err("input pointer is null");
    }
    if len > isize::MAX as usize {
        return Err("input length exceeds addressable slice size");
    }
    if ptr.align_offset(std::mem::align_of::<u8>()) != 0 {
        return Err("input pointer is misaligned");
    }
    // SAFETY: the caller guarantees valid, immutable storage for this slice
    // (this function's own contract, forwarded from every entry point below).
    // Every entry point consumes it synchronously and never retains it.
    Ok(unsafe { std::slice::from_raw_parts(ptr, len) })
}

/// Reserves `len` bytes for the caller to write into. Pair with [`free`].
#[unsafe(no_mangle)]
pub extern "C" fn alloc(len: usize) -> *mut u8 {
    let Ok(layout) = std::alloc::Layout::from_size_align(len.max(1), 1) else {
        return std::ptr::null_mut();
    };
    // SAFETY: `layout` has a non-zero size and alignment 1, which
    // `std::alloc::alloc` requires. A null return is passed straight back to
    // the caller, matching `alloc`'s own contract on allocation failure.
    unsafe { std::alloc::alloc(layout) }
}

/// # Safety
///
/// `ptr` must come from [`alloc`] with this exact `len`, and must not be used
/// again afterwards.
///
/// Exported only under `target_family = "wasm"`: on a native build (this
/// crate's own `cargo test`) the bare symbol name `free` collides with
/// libc's, so — same as `rust/crates/render-wasm/src/lib.rs` — the native test
/// binary calls this by its normal Rust path instead of through the mangled
/// C symbol.
#[cfg_attr(target_family = "wasm", unsafe(no_mangle))]
pub unsafe extern "C" fn free(ptr: *mut u8, len: usize) {
    if ptr.is_null() {
        return;
    }
    let Ok(layout) = std::alloc::Layout::from_size_align(len.max(1), 1) else {
        return;
    };
    // SAFETY: the caller guarantees `ptr`/`len` came from `alloc`, which
    // built the identical layout.
    unsafe { std::alloc::dealloc(ptr, layout) }
}

/// Loads a `SchemaMaterial` (see `schema_io.rs` for its JSON shape) and
/// returns a resident handle. `0` on failure — `last_error_*` holds why.
///
/// # Safety
///
/// `ptr`/`len` must describe an initialised buffer from [`alloc`].
#[unsafe(no_mangle)]
pub unsafe extern "C" fn schema_load(ptr: *const u8, len: usize) -> u32 {
    // SAFETY: forwarded from this function's own contract.
    let bytes = match unsafe { input(ptr, len) } {
        Ok(bytes) => bytes,
        Err(message) => {
            set_last_error(CoreError::decode(message).to_json_bytes());
            return 0;
        }
    };
    match materials::decode(bytes) {
        Ok(schema) => {
            let handle = next_schema_handle();
            SCHEMAS.with(|table| table.borrow_mut().insert(handle, schema));
            handle
        }
        Err(decode_error) => {
            set_last_error(decode_error.to_json_bytes());
            0
        }
    }
}

/// Drops a resident schema. A handle that does not exist is a no-op — the
/// same idempotent-release shape `drop_result`/`free` already have.
#[unsafe(no_mangle)]
pub extern "C" fn schema_drop(handle: u32) {
    SCHEMAS.with(|table| table.borrow_mut().remove(&handle));
}

/// Runs one op against a resident schema handle. `0` on success (the result
/// is in the `result_*` slot); non-zero on failure (`last_error_*` holds a
/// `{code, message}` JSON body — see `error.rs`).
///
/// # Safety
///
/// `ptr`/`len` must describe an initialised buffer from [`alloc`].
#[unsafe(no_mangle)]
pub unsafe extern "C" fn call(op: u32, h: u32, ptr: *const u8, len: usize) -> u32 {
    // SAFETY: forwarded from this function's own contract.
    let bytes = match unsafe { input(ptr, len) } {
        Ok(bytes) => bytes,
        Err(message) => {
            set_last_error(CoreError::decode(message).to_json_bytes());
            return 1;
        }
    };
    let outcome = SCHEMAS.with(|table| {
        let table = table.borrow();
        dispatch::dispatch(op, table.get(&h), bytes)
    });
    match outcome {
        Ok(result_bytes) => {
            RESULT.with(|slot| *slot.borrow_mut() = Some(result_bytes));
            0
        }
        Err(core_error) => {
            set_last_error(core_error.to_json_bytes());
            1
        }
    }
}

#[unsafe(no_mangle)]
pub extern "C" fn result_len() -> u32 {
    RESULT.with(|slot| slot.borrow().as_ref().map_or(0, |bytes| bytes.len() as u32))
}

/// Pointer to the result bytes, valid until [`drop_result`]. The `Vec`'s heap
/// buffer does not move while it sits in the slot, so the glue may read it
/// across several calls.
#[unsafe(no_mangle)]
pub extern "C" fn result_ptr() -> *const u8 {
    RESULT.with(|slot| {
        slot.borrow()
            .as_ref()
            .map_or(std::ptr::null(), |bytes| bytes.as_ptr())
    })
}

#[unsafe(no_mangle)]
pub extern "C" fn drop_result() {
    RESULT.with(|slot| *slot.borrow_mut() = None);
}

#[unsafe(no_mangle)]
pub extern "C" fn last_error_len() -> u32 {
    LAST_ERROR.with(|slot| u32::try_from(slot.borrow().len()).unwrap_or(u32::MAX))
}

#[unsafe(no_mangle)]
pub extern "C" fn last_error_ptr() -> *const u8 {
    LAST_ERROR.with(|slot| slot.borrow().as_ptr())
}

/// Browser send step. Input JSON is `{"state","event"}`. Success writes
/// `{"state","allowPost"}` into the result slot. An edge that is not in
/// the table returns 1 and a `{code,message}` body; the caller must not
/// write that step. The key, the socket, and IndexedDB never enter here.
///
/// # Safety
///
/// `ptr`/`len` must describe an initialised buffer from [`alloc`].
#[unsafe(no_mangle)]
pub unsafe extern "C" fn send_transition(ptr: *const u8, len: usize) -> u32 {
    // SAFETY: forwarded from this function's own contract.
    let bytes = match unsafe { input(ptr, len) } {
        Ok(bytes) => bytes,
        Err(message) => {
            set_last_error(CoreError::decode(message).to_json_bytes());
            return 1;
        }
    };
    #[derive(serde::Deserialize)]
    struct Input {
        state: String,
        event: String,
    }
    let parsed: Input = match serde_json::from_slice(bytes) {
        Ok(parsed) => parsed,
        Err(error) => {
            set_last_error(CoreError::decode(error).to_json_bytes());
            return 1;
        }
    };
    match send_state::apply_send(&parsed.state, &parsed.event) {
        Ok(step) => {
            #[derive(serde::Serialize)]
            struct Out<'a> {
                state: &'a str,
                #[serde(rename = "allowPost")]
                allow_post: bool,
            }
            let encoded = serde_json::to_vec(&Out { state: step.state, allow_post: step.allow_post })
                .unwrap_or_else(|_| br#"{"state":"","allowPost":false}"#.to_vec());
            RESULT.with(|slot| *slot.borrow_mut() = Some(encoded));
            0
        }
        Err(message) => {
            set_last_error(CoreError::refused(message).to_json_bytes());
            1
        }
    }
}

/// Host helper beside the browser op table. The browser module does not
/// export this symbol. It calls `listing_core::schema::snapshot_from_live_fields`
/// on the cached `CatalogSchemaField` array, which is what Cloud recomputes
/// instead of trusting a stored schema revision.
///
/// The `browser` feature drops this export. The server build keeps it.
///
/// Input JSON is `{description_category_id, type_id, fields}` with the cache
/// field names (`deny_unknown_fields`, no camelCase). Success is `0` and the
/// `CategorySchemaSnapshot` bytes sit in the same result slot as `call`.
///
/// # Safety
///
/// `ptr`/`len` must describe an initialised buffer from [`alloc`].
#[cfg(not(feature = "browser"))]
#[unsafe(no_mangle)]
pub unsafe extern "C" fn snapshot_from_fields(ptr: *const u8, len: usize) -> u32 {
    // SAFETY: forwarded from this function's own contract.
    let bytes = match unsafe { input(ptr, len) } {
        Ok(bytes) => bytes,
        Err(message) => {
            set_last_error(CoreError::decode(message).to_json_bytes());
            return 1;
        }
    };
    #[derive(serde::Deserialize)]
    struct Input {
        description_category_id: i64,
        type_id: i64,
        fields: Vec<listing_core::catalog_schema::CatalogSchemaField>,
    }
    let input: Input = match serde_json::from_slice(bytes) {
        Ok(input) => input,
        Err(error) => {
            set_last_error(CoreError::decode(error).to_json_bytes());
            return 1;
        }
    };
    let fields = input.fields.into_iter().map(Into::into).collect();
    let snapshot = listing_core::schema::snapshot_from_live_fields(
        input.description_category_id,
        input.type_id,
        fields,
    );
    match serde_json::to_vec(&snapshot) {
        Ok(encoded) => {
            RESULT.with(|slot| *slot.borrow_mut() = Some(encoded));
            0
        }
        Err(error) => {
            set_last_error(CoreError::decode(error).to_json_bytes());
            1
        }
    }
}

//! Serialized C ABI for golden tests; production uses the threaded runtime.

use render::{ParsedTemplate, ProductResourcePolicy, RenderIntent};
mod memory;
mod state;
use memory::input;
pub use memory::{alloc, free};
use state::{LAST_ERROR, RESULTS, TEMPLATES, fail, insert_result, insert_template};

/// Parses PSD/PSB bytes into a reusable template. `0` on failure.
///
/// # Safety
///
/// `ptr`/`len` must describe an initialised buffer from [`alloc`].
#[unsafe(no_mangle)]
pub unsafe extern "C" fn load_template(ptr: *const u8, len: usize) -> u32 {
    crate::clock::initialize_stage_clock();
    // SAFETY: forwarded from this function's own contract.
    let bytes = match unsafe { input(ptr, len) } {
        Ok(bytes) => bytes,
        Err(error) => return fail(error),
    };
    match ParsedTemplate::parse(bytes, &ProductResourcePolicy::default()) {
        Ok(template) => insert_template(template).unwrap_or_else(fail),
        Err(error) => fail(error.to_string()),
    }
}

/// Drains stage totals into a result handle. Bytes are one JSON object, not a
/// packed render. Call after `load_template` when the parse totals are needed.
#[unsafe(no_mangle)]
pub extern "C" fn take_stage_timings() -> u32 {
    match serde_json::to_vec(&render::take_stage_timings()) {
        Ok(bytes) => insert_result(bytes).unwrap_or_else(fail),
        Err(error) => fail(error.to_string()),
    }
}

#[unsafe(no_mangle)]
pub extern "C" fn drop_template(handle: u32) {
    TEMPLATES.with(|table| table.borrow_mut().remove(&handle));
}

/// Renders one design against a loaded template. `0` on failure.
///
/// `intent_json` is a `RenderIntent` in camelCase; an empty buffer means the
/// default intent.
///
/// # Safety
///
/// Every pointer/length pair must describe an initialised buffer from
/// [`alloc`], and `name_ptr`/`intent_json_ptr` must hold UTF-8.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn render_product(
    template_handle: u32,
    design_ptr: *const u8,
    design_len: usize,
    name_ptr: *const u8,
    name_len: usize,
    intent_json_ptr: *const u8,
    intent_json_len: usize,
) -> u32 {
    crate::clock::initialize_stage_clock();
    // SAFETY: forwarded from this function's own contract.
    let design = match unsafe { input(design_ptr, design_len) } {
        Ok(bytes) => bytes,
        Err(error) => return fail(error),
    };
    // SAFETY: the caller supplies an initialized name buffer under this function's contract.
    let name = match unsafe { input(name_ptr, name_len) } {
        Ok(bytes) => bytes,
        Err(error) => return fail(error),
    };
    // SAFETY: the caller supplies an initialized intent buffer; input accepts an empty buffer.
    let intent_json = match unsafe { input(intent_json_ptr, intent_json_len) } {
        Ok(bytes) => bytes,
        Err(error) => return fail(error),
    };
    let Ok(name) = std::str::from_utf8(name) else {
        return fail("design name is not UTF-8");
    };
    let intent = if intent_json.is_empty() {
        RenderIntent::default()
    } else {
        match serde_json::from_slice(intent_json) {
            Ok(intent) => intent,
            Err(error) => return fail(format!("render intent is not valid JSON: {error}")),
        }
    };
    let outcome = TEMPLATES.with(|table| {
        let table = table.borrow();
        let Some(template) = table.get(&template_handle) else {
            return Err(format!("no template for handle {template_handle}"));
        };
        render::render_product(
            template,
            design,
            name,
            &intent,
            &ProductResourcePolicy::default(),
        )
        .map_err(|error| error.to_string())
    });
    match outcome {
        Ok(outcome) => match crate::packing::pack(&outcome.manifest_json, &outcome.slices) {
            Ok(bytes) => insert_result(bytes).unwrap_or_else(fail),
            Err(error) => fail(error),
        },
        Err(error) => fail(error),
    }
}

/// Downsamples and re-encodes an image for the AI relay. `0` on failure; the
/// result handle holds the prepared bytes with no JSON header.
///
/// # Safety
///
/// `ptr`/`len` must describe an initialised buffer from [`alloc`].
#[unsafe(no_mangle)]
pub unsafe extern "C" fn prepare_ai_image(ptr: *const u8, len: usize) -> u32 {
    // SAFETY: forwarded from this function's own contract.
    let bytes = match unsafe { input(ptr, len) } {
        Ok(bytes) => bytes,
        Err(error) => return fail(error),
    };
    match render::prepare_ai_image(bytes) {
        Ok(prepared) => insert_result(prepared).unwrap_or_else(fail),
        Err(error) => fail(error.to_string()),
    }
}

#[unsafe(no_mangle)]
pub extern "C" fn result_len(handle: u32) -> u32 {
    RESULTS.with(|table| {
        table
            .borrow()
            .get(&handle)
            .map_or(0, |bytes| bytes.len() as u32)
    })
}

/// Pointer to the result bytes, valid until [`drop_result`]. The `Vec`'s heap
/// buffer does not move while it sits in the table, so the glue may read it
/// across several calls.
#[unsafe(no_mangle)]
pub extern "C" fn result_ptr(handle: u32) -> *const u8 {
    RESULTS.with(|table| {
        table
            .borrow()
            .get(&handle)
            .map_or(std::ptr::null(), |bytes| bytes.as_ptr())
    })
}

#[unsafe(no_mangle)]
pub extern "C" fn drop_result(handle: u32) {
    RESULTS.with(|table| table.borrow_mut().remove(&handle));
}

#[unsafe(no_mangle)]
pub extern "C" fn last_error_len() -> u32 {
    LAST_ERROR.with(|slot| u32::try_from(slot.borrow().len()).unwrap_or(u32::MAX))
}

#[unsafe(no_mangle)]
pub extern "C" fn last_error_ptr() -> *const u8 {
    LAST_ERROR.with(|slot| slot.borrow().as_ptr())
}

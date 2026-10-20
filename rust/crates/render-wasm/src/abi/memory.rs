//! The raw-pointer seam: only serialized C ABI callers may use these buffers.

use std::alloc::{Layout, alloc as raw_alloc, dealloc};

/// # Safety
///
/// `ptr` must come from [`alloc`] with the same `len` and hold initialized bytes.
/// The caller must neither mutate nor free it for the entire borrowed lifetime.
/// Entry points consume it synchronously and never retain the slice.
pub(super) unsafe fn input<'a>(ptr: *const u8, len: usize) -> Result<&'a [u8], &'static str> {
    if len == 0 {
        return Ok(&[]);
    }
    if ptr.is_null() {
        return Err("input pointer is null");
    }
    if len > isize::MAX as usize {
        return Err("input length exceeds addressable slice size");
    }
    // SAFETY: the caller guarantees valid initialized storage for the borrow.
    Ok(unsafe { std::slice::from_raw_parts(ptr, len) })
}

/// Reserves `len` bytes for the caller to write into. Pair with [`free`].
#[unsafe(no_mangle)]
pub extern "C" fn alloc(len: usize) -> *mut u8 {
    let Ok(layout) = Layout::from_size_align(len.max(1), 1) else {
        return std::ptr::null_mut();
    };
    // SAFETY: the layout is non-zero with alignment 1; a null return is forwarded.
    unsafe { raw_alloc(layout) }
}

/// # Safety
///
/// `ptr` must come from [`alloc`] with this exact `len`, and not be used again.
#[cfg_attr(target_family = "wasm", unsafe(no_mangle))]
pub unsafe extern "C" fn free(ptr: *mut u8, len: usize) {
    if ptr.is_null() {
        return;
    }
    let Ok(layout) = Layout::from_size_align(len.max(1), 1) else {
        return;
    };
    // SAFETY: the caller guarantees the identical allocation layout.
    unsafe { dealloc(ptr, layout) }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn validates_empty_null_and_unaddressable_inputs() {
        // SAFETY: input rejects these pairs before dereferencing any pointer.
        unsafe {
            assert!(input(std::ptr::null(), 0).unwrap().is_empty());
            assert!(input(std::ptr::null(), 1).is_err());
            assert!(input(std::ptr::NonNull::<u8>::dangling().as_ptr(), usize::MAX).is_err());
        }
    }
    #[test]
    fn an_allocated_buffer_is_borrowed_without_copying() {
        let ptr = alloc(2);
        assert!(!ptr.is_null());
        // SAFETY: the allocation has two bytes; we initialize, borrow, then free it once.
        unsafe {
            ptr.write(7);
            ptr.add(1).write(9);
            let bytes = input(ptr, 2).unwrap();
            assert_eq!(bytes, &[7, 9]);
            assert_eq!(bytes.as_ptr(), ptr);
            free(ptr, 2);
        }
    }
}

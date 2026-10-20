//! Per-instance C ABI ownership; deliberately separate from production leases.

use render::ParsedTemplate;
use std::{
    cell::{Cell, RefCell},
    collections::HashMap,
};

thread_local! {
    pub(super) static TEMPLATES: RefCell<HashMap<u32, ParsedTemplate>> = RefCell::new(HashMap::new());
    pub(super) static RESULTS: RefCell<HashMap<u32, Vec<u8>>> = RefCell::new(HashMap::new());
    static NEXT_HANDLE: Cell<u32> = const { Cell::new(0) };
    pub(super) static LAST_ERROR: RefCell<Vec<u8>> = const { RefCell::new(Vec::new()) };
}

fn next_handle() -> Result<u32, String> {
    NEXT_HANDLE.with(|next| {
        let handle = next.get().checked_add(1).ok_or("RENDER_IDS_EXHAUSTED")?;
        next.set(handle);
        Ok(handle)
    })
}

pub(super) fn fail(message: impl AsRef<str>) -> u32 {
    LAST_ERROR.with(|slot| *slot.borrow_mut() = message.as_ref().as_bytes().to_vec());
    0
}

pub(super) fn insert_template(template: ParsedTemplate) -> Result<u32, String> {
    let handle = next_handle()?;
    TEMPLATES.with(|table| table.borrow_mut().insert(handle, template));
    Ok(handle)
}

pub(super) fn insert_result(bytes: Vec<u8>) -> Result<u32, String> {
    u32::try_from(bytes.len()).map_err(|_| "result exceeds ABI length")?;
    let handle = next_handle()?;
    RESULTS.with(|table| table.borrow_mut().insert(handle, bytes));
    Ok(handle)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn handle_exhaustion_never_wraps_or_replaces_live_results() {
        let previous = NEXT_HANDLE.with(|next| next.replace(u32::MAX - 1));
        let handle = insert_result(vec![7]).unwrap();
        assert_eq!(handle, u32::MAX);
        assert_eq!(insert_result(vec![9]).unwrap_err(), "RENDER_IDS_EXHAUSTED");
        RESULTS.with(|table| {
            assert_eq!(table.borrow()[&handle], [7]);
            table.borrow_mut().remove(&handle);
        });
        NEXT_HANDLE.with(|next| next.set(previous));
    }
}

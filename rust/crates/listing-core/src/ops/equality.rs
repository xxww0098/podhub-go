//! Field-value equality: process-boundary forward onto
//! [`crate::validate::workflow_values_equal`], named as an op so the WASM
//! binding (`valuesEqual`) is the browser's only caller. Cloud does not
//! expose a route for it. Callers go through `ops` instead of reaching into
//! `validate` directly.

use crate::WorkflowDraftValue;
use crate::records::ListingFieldEditor;
use crate::validate::workflow_values_equal;

pub fn values_equal(
    editor: ListingFieldEditor,
    left: Option<&WorkflowDraftValue>,
    right: Option<&WorkflowDraftValue>,
) -> bool {
    workflow_values_equal(editor, left, right)
}

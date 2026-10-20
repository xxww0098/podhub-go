//! Op 18, `validateVariantGroup`: the browser's door onto
//! `listing_core::variants`, so the workbench judges a grouping with the very
//! rules Cloud does.
//!
//! **No schema handle.** The rule is about the *current category material*,
//! which the caller holds from `GET /api/catalog/schema` — not about the
//! Card's pinned snapshot a resident handle carries. Taking the fields in the
//! body also makes the ABI testable both ways round: a fixture can feed the
//! identical JSON to this op and to `variants::validate_group` in Cloud and
//! compare the problem lists byte for byte.
//!
//! Nothing here reads a store, a task or a clock, and a refusal is a normal
//! result — the problem list — never a thrown error.

use listing_core::records::ListingFieldDefinition;
use listing_core::variants::{GroupWrite, VariantProblem, validate_group};
use serde::Deserialize;

use crate::error::CoreError;

/// Op 18 — [`handle`].
pub(crate) const OP_VALIDATE_VARIANT_GROUP: u32 = 18;

/// The crate's own names throughout: `fields` is a
/// `records::ListingFieldDefinition` list (snake_case, exactly what Cloud's
/// `nativeMaterial.snapshot` carries) and `group` is `variants::GroupWrite`.
/// No `rename_all`, because there is no second spelling for either.
#[derive(Deserialize)]
struct Input {
    fields: Vec<ListingFieldDefinition>,
    group: GroupWrite,
}

pub(crate) fn validate_variant_group(bytes: &[u8]) -> Result<Vec<u8>, CoreError> {
    let input: Input = serde_json::from_slice(bytes).map_err(CoreError::decode)?;
    let problems: Vec<VariantProblem> = validate_group(&input.fields, &input.group);
    serde_json::to_vec(&problems).map_err(CoreError::decode)
}

//! Pure Ozon variant-grouping rules: which fields distinguish variants, what a
//! member's values mean, and which groupings a write must refuse.
//!
//! One owner for both entries — the listing workflow and store product
//! management — and for Cloud and the browser alike: `listing-core-wasm` op 18
//! (`validateVariantGroup`) forwards straight into [`validate_group`], so the
//! workbench and Cloud refuse the same groupings for the same material.
//!
//! This module decides nothing about tenancy, credentials, transport or time.
//! Cloud, Listing and Store each convert their own draft or Seller attribute
//! facts into the pure inputs below; nothing here reads a row, a task, a clock
//! or an HTTP response.
//!
//! # The one rule callers must not soften
//!
//! `ListingFieldDefinition::aspect` has three states. `Some(true)` is a variant
//! dimension, `Some(false)` is known not to be one, and `None` means the
//! material predates Ozon's `is_aspect` — **the rule is unknown**. Unknown is
//! not "no dimensions" and it is not "duplicates are fine": it is a refusal
//! that asks for a material refresh ([`OzonVariantsCode::MetadataUnknown`]),
//! and [`carries_aspect_metadata`] is the same fact Cloud's schema cache asks
//! when it notices that a served payload still predates the metadata.
//!
//! The refusal is scoped to the judgement. Material without the metadata is
//! ordinary field material: it serves, it validates, it is written to, and the
//! unknown aspect travels through as unknown until the cache TTL replaces it.
//! What must never happen is a *decision* drawn from it — and that is this
//! module's to enforce, not the cache's to enforce by refusing to serve.

mod field;
mod group;
mod value;

#[cfg(test)]
mod tests;

pub use field::{
    BRAND_ATTRIBUTE_ID, CategoryVariantRule, MODEL_ATTRIBUTE_ID, VariantDimensions, VariantRefusal,
    carries_aspect_metadata, declares_aspect, material_declares_aspect, resolve_variant_rule,
};
pub use group::{GroupIdentity, GroupWrite, VariantMember, VariantProblem, validate_group};
pub use value::{DimensionValue, dimension_value, dimension_values};

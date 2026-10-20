//! The listing brain: Category Schema, Draft validation, planning and Seller
//! serialization.
//!
//! Everything here is pure. No SQL, no HTTP, no clock. Cloud's `listing::kernel`
//! owns the row/job/intent tables and `listing::api` owns the routes; this
//! crate decides what a Draft means and what Ozon is asked for, and nothing
//! else — no `seller_api` (network), no `sea_orm` (SQL), no `tokio`/`chrono`.
//!
//! This crate compiles for both native and `wasm32-unknown-unknown` (ADR-0107)
//! so the same field rules run in Cloud and, through
//! `rust/crates/listing-core-wasm`, in the browser. Cloud still names this module
//! tree as `crate::listing::core::*` through the bridge re-export in
//! `src/listing/mod.rs` — a transitional seam browser-owned-listing slice 18
//! removes, not a permanent API.

pub mod ai_settlement;
pub mod banned_tags;
mod barcode;
pub mod bridge;
pub mod build;
pub mod card_annotations;
/// Cloud's server-side category schema cache wire. It lives here, not in
/// Cloud's `src/wire/catalog_schema.rs`, because `category_schema_cache`
/// converts between it and this crate's own field types. Gated behind the
/// `openapi` feature: the `utoipa::ToSchema` derive is an OpenAPI-generation
/// concern this crate has no other reason to depend on, and pulling in
/// `utoipa` unconditionally would defeat the point of a minimal-dependency
/// WASM-targeting crate. Cloud enables `openapi` on its dependency and
/// re-exports these types from `src/wire/catalog_schema.rs`.
pub mod catalog_schema;
pub mod categories;
mod category_schema_cache;
pub mod compose;
pub mod content_policy;
pub mod draft;
pub mod envelope;
mod error;
pub mod field_pack;
/// The single `(platform, stage, code)` declaration: typed issue producers,
/// the closed OpenAPI union (`openapi` feature) and the runtime manifest.
pub mod issue_keys;
pub mod ocr_contract;
pub mod ocr_script;
mod ocr_tag_format;
pub mod ops;
pub mod plan;
pub mod product_import;
pub mod projections;
pub mod records;
pub mod row_lifecycle;
pub mod schema;
pub mod service;
pub mod sku_import;
/// Browser-side confirm and OCR stage plans. Pure. Not a storage or Seller authority.
pub mod stage_gate;
#[cfg(test)]
pub mod upgrade;
pub mod validate;
/// Pure variant-grouping rules shared by both entries (listing workflow and
/// store product management) and by Cloud and the browser. No SQL, no HTTP,
/// no clock, no tenancy — see the module's own docs.
pub mod variants;

// `test-support`, not plain `test`: `compose::compose_frozen_import` (also
// `test-support`-gated) names this in its return type, and Cloud's own
// `submit_reconcile_tests` suite calls it cross-crate.
#[cfg(any(test, feature = "test-support"))]
pub use error::ListingError;

pub mod workflow_dto;
pub use workflow_dto::*;

// Ozon attribute-id constants. Field rules built here (e.g. `product_import`,
// `sku_import`, the AI settlement gate) name them; Cloud imports them from
// here (`listing::api`, `listing::kernel::supplier_projection`).

/// Ozon's description characteristic. The AI owns the value; the composer
/// writes it here because `/v3/product/import` items carry it as an attribute.
pub const DESCRIPTION_ATTRIBUTE_ID: i64 = 4191;

/// Ozon's search-tags characteristic. Admin fixed tags and AI design tags both
/// land here, and nowhere else.
pub const SEARCH_TAGS_ATTRIBUTE_ID: i64 = 23_171;

/// Ozon's `JSON富内容` (rich content JSON) characteristic. Like 销售价 /
/// 划线价 it is a card default the operator may override per row; only SKU
/// import stays away from it (the template embeds one product's own media, so
/// an imported copy would be another product's stale document).
pub const RICH_CONTENT_ATTRIBUTE_ID: i64 = 11_254;

/// Ozon's `主题` (dictionary 726) characteristic. Like 销售价 / 划线价 it is a
/// card default the operator may override per row in the workbench 主题 column.
/// SKU import stays away from it (a theme belongs to one product's own copy).
pub const THEME_ATTRIBUTE_ID: i64 = 7_109;

mod paint_by_numbers_theme;
pub use paint_by_numbers_theme::fill_paint_by_numbers_card_theme;

/// Wildberries native rules and upload protocol, without I/O or clock policy.
pub mod wb;

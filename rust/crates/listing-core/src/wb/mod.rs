//! WB subject/characteristic rules. No Ozon coordinates, I/O or clock policy.
mod build;
mod encode;
mod fields;
mod model;
pub mod protocol;

pub use build::build_preview;
pub use encode::{EncodeError, MAX_UPLOAD_BYTES, ValidationError, encode_upload};
pub use fields::{metadata_issues, validate_fields};
pub use model::*;

#[cfg(test)]
mod build_tests;
#[cfg(test)]
mod encode_tests;
#[cfg(test)]
mod field_tests;
#[cfg(test)]
mod tests;

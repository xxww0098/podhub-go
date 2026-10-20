//! Field addressing shared by Candidate Edits and Listing CAS.
//!
//! The type itself lives in [`records`](crate::records): it is
//! the leaf that both persistence (`FieldValueOrigin`) and the workflow DTOs
//! name, so a second same-shaped copy would only invite drift.
pub use crate::records::FieldAddress;

use thiserror::Error;

use super::product_import::SerializeError;

#[derive(Debug, Error)]
pub enum ListingError {
    #[error("{0}")]
    CloudSsot(String),
    #[error("Execution Plan requires a Validated listing draft")]
    NotValidated,
    #[error("Validated draft is missing its normalized snapshot")]
    MissingNormalizedSnapshot,
    #[error(transparent)]
    Serialize(SerializeError),
    #[cfg(test)]
    #[error("Invalid Draft edit {code} at {address}")]
    InvalidDraftEdit { code: &'static str, address: String },
}

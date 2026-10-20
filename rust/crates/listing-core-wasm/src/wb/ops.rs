use super::decode::BuildInput;
use crate::{error::CoreError, materials::Material};

fn require(material: Option<&Material>) -> Result<&listing_core::wb::Material, CoreError> {
    match material {
        Some(Material::Wb(material)) => Ok(material),
        Some(Material::Ozon(_)) => Err(CoreError::schema_handle(
            "WB operation requires a WB material handle",
        )),
        None => Err(CoreError::schema_handle(
            "unknown or dropped WB material handle",
        )),
    }
}

pub(crate) fn build_preview(
    material: Option<&Material>,
    bytes: &[u8],
) -> Result<Vec<u8>, CoreError> {
    let material = require(material)?;
    let input: BuildInput = serde_json::from_slice(bytes).map_err(CoreError::decode)?;
    serde_json::to_vec(&listing_core::wb::build_preview(material, &input.config))
        .map_err(CoreError::decode)
}

pub(crate) fn metadata_issues(material: Option<&Material>) -> Result<Vec<u8>, CoreError> {
    serde_json::to_vec(&listing_core::wb::metadata_issues(require(material)?))
        .map_err(CoreError::decode)
}

use crate::error::CoreError;
use listing_core::wb::{Material, WbProductConfig};
use serde::Deserialize;

#[derive(Deserialize)]
#[serde(rename_all = "lowercase")]
enum Platform {
    Wb,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Load {
    platform: Platform,
    material: Material,
}

pub(crate) fn material(bytes: &[u8]) -> Result<Material, CoreError> {
    let input: Load = serde_json::from_slice(bytes).map_err(CoreError::decode)?;
    let Platform::Wb = input.platform;
    Ok(input.material)
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct BuildInput {
    pub config: WbProductConfig,
}

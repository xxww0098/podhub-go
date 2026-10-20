//! A single typed resident table: numeric handles cannot cross platforms.
use listing_core::ops::SchemaMaterial;

pub(crate) enum Material {
    Ozon(SchemaMaterial),
    Wb(listing_core::wb::Material),
}

pub(crate) fn decode(bytes: &[u8]) -> Result<Material, crate::error::CoreError> {
    let value: serde_json::Value =
        serde_json::from_slice(bytes).map_err(crate::error::CoreError::decode)?;
    match value.get("platform") {
        None => crate::schema_io::decode_schema(bytes)
            .map(Material::Ozon)
            .map_err(crate::error::CoreError::decode),
        Some(serde_json::Value::String(platform)) if platform == "ozon" => {
            crate::schema_io::decode_schema(bytes)
                .map(Material::Ozon)
                .map_err(crate::error::CoreError::decode)
        }
        Some(serde_json::Value::String(platform)) if platform == "wb" => {
            crate::wb::decode::material(bytes).map(Material::Wb)
        }
        _ => Err(crate::error::CoreError::decode("unknown material platform")),
    }
}

//! Base64 (std alphabet) for `Option<Vec<u8>>` fields in the JSON document model.

#![cfg(feature = "serde")]

use serde::{Deserialize, Deserializer, Serializer};

pub(crate) fn serialize<S: Serializer>(
    bytes: &Option<Vec<u8>>,
    serializer: S,
) -> Result<S::Ok, S::Error> {
    match bytes {
        None => serializer.serialize_none(),
        Some(b) if b.is_empty() => serializer.serialize_some(""),
        Some(b) => {
            let encoded = base64::Engine::encode(&base64::engine::general_purpose::STANDARD, b);
            serializer.serialize_some(&encoded)
        }
    }
}

pub(crate) fn deserialize<'de, D: Deserializer<'de>>(
    deserializer: D,
) -> Result<Option<Vec<u8>>, D::Error> {
    let opt = Option::<String>::deserialize(deserializer)?;
    match opt {
        None => Ok(None),
        Some(s) if s.is_empty() => Ok(Some(Vec::new())),
        Some(s) => base64::Engine::decode(&base64::engine::general_purpose::STANDARD, s.as_bytes())
            .map(Some)
            .map_err(serde::de::Error::custom),
    }
}

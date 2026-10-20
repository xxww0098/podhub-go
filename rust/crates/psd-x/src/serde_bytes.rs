//! Base64 (std alphabet) for `Vec<u8>` fields in the JSON document model.

#![cfg(feature = "serde")]

use serde::{Deserialize, Deserializer, Serializer};

pub(crate) fn serialize<S: Serializer>(bytes: &Vec<u8>, serializer: S) -> Result<S::Ok, S::Error> {
    if bytes.is_empty() {
        serializer.serialize_str("")
    } else {
        serializer.serialize_str(&base64::Engine::encode(
            &base64::engine::general_purpose::STANDARD,
            bytes,
        ))
    }
}

pub(crate) fn deserialize<'de, D: Deserializer<'de>>(deserializer: D) -> Result<Vec<u8>, D::Error> {
    let s = String::deserialize(deserializer)?;
    if s.is_empty() {
        return Ok(Vec::new());
    }
    base64::Engine::decode(&base64::engine::general_purpose::STANDARD, s.as_bytes())
        .map_err(serde::de::Error::custom)
}

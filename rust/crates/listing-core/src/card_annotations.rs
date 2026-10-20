//! These six SPA annotations do not belong to `CardPayload`. Domain decoding
//! rejects unknown top-level keys; any new annotation key must go through this
//! module. `queue.haltReason` is nested, not a literal top-level key.
//!
//! `schemaRevision` is not a card field. Older documents stored the category
//! revision on the card; each row owns it now. Decode drops that one key so
//! those cards still open, and does not write it back. Any other unknown key
//! is still drift and fails.
//!
//! The two decode boundaries fail differently, on purpose:
//! - Domain decoding (`CardPayload`, `WorkflowDraftValue`) rejects any unknown
//!   shape: a stored Card that does not decode is drift, not data.
//! - Supplier projection (`kernel::supplier_projection`) skips a config key the
//!   current Ozon schema no longer has and warns
//!   (`supplier_projection_dropped_attribute`); admission (`require_listable`)
//!   stays fail-closed ahead of it.

use serde_json::Value;

use super::envelope::CardPayload;
use super::error::ListingError;

pub const ANNOTATION_KEYS: [&str; 6] = [
    "aiPrompt",
    "aiPromptFileName",
    "targetStoreId",
    "supplierUnavailable",
    "size",
    "queue.haltReason",
];

/// Opaque display values preserve the SPA wire representation, including null.
#[derive(Debug, Default, Clone, PartialEq)]
pub struct CardAnnotations {
    pub ai_prompt: Option<Value>,
    pub ai_prompt_file_name: Option<Value>,
    pub target_store_id: Option<Value>,
    pub supplier_unavailable: Option<Value>,
    pub size: Option<Value>,
    pub queue_halt_reason: Option<Value>,
}

pub fn take(payload: &mut Value) -> CardAnnotations {
    let [
        ai_prompt,
        ai_prompt_file_name,
        target_store_id,
        supplier_unavailable,
        size,
        queue_halt_reason,
    ] = ANNOTATION_KEYS.map(|path| {
        let (object, key) = match path.split_once('.') {
            Some((parent, key)) => (payload.get_mut(parent), key),
            None => (Some(&mut *payload), path),
        };
        object.and_then(Value::as_object_mut)?.remove(key)
    });
    CardAnnotations {
        ai_prompt,
        ai_prompt_file_name,
        target_store_id,
        supplier_unavailable,
        size,
        queue_halt_reason,
    }
}

pub fn attach(payload: &mut Value, annotations: &CardAnnotations) {
    let Some(object) = payload.as_object_mut() else {
        return;
    };
    for (path, value) in ANNOTATION_KEYS.into_iter().zip([
        &annotations.ai_prompt,
        &annotations.ai_prompt_file_name,
        &annotations.target_store_id,
        &annotations.supplier_unavailable,
        &annotations.size,
        &annotations.queue_halt_reason,
    ]) {
        let Some(value) = value else { continue };
        match path.split_once('.') {
            Some((parent, key)) => {
                if let Some(nested) = object
                    .entry(parent)
                    .or_insert_with(|| Value::Object(Default::default()))
                    .as_object_mut()
                {
                    nested.insert(key.to_owned(), value.clone());
                }
            }
            None => {
                object.insert(path.to_owned(), value.clone());
            }
        }
    }
}

pub fn decode_card(payload: &Value) -> Result<(CardPayload, CardAnnotations), ListingError> {
    let mut domain = payload.clone();
    let annotations = take(&mut domain);
    // Retired. Present on cards written before the revision moved onto the row.
    if let Some(object) = domain.as_object_mut() {
        object.remove("schemaRevision");
    }
    // Keep the top-level wire names aligned with envelope::CardPayload. Nested
    // domain shapes still belong to its serde decoder, including CardQueue.
    const CARD_FIELDS: [&str; 15] = [
        "categoryKey",
        "descriptionCategoryId",
        "typeId",
        "language",
        "defaults",
        "aiPromptId",
        "aiPromptSha256",
        "supplierProductId",
        "psdTemplateAssetId",
        "psdTemplateSha256",
        "psdTemplateFileName",
        "aiFieldPolicy",
        "videos",
        "videoCover",
        "queue",
    ];
    if let Some(object) = domain.as_object() {
        let unknown = object
            .keys()
            .filter(|key| !CARD_FIELDS.contains(&key.as_str()))
            .map(String::as_str)
            .collect::<Vec<_>>();
        if !unknown.is_empty() {
            return Err(ListingError::CloudSsot(format!(
                "listing card payload decode: unknown fields: {}",
                unknown.join(", ")
            )));
        }
    }
    CardPayload::from_value(&domain).map(|card| (card, annotations))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn a_retired_card_schema_revision_does_not_block_decode() {
        let payload = json!({
            "categoryKey": "workflow:1:2",
            "descriptionCategoryId": 1,
            "typeId": 2,
            "aiFieldPolicy": { "allowed_field_keys": [], "protected_field_keys": [] },
            "schemaRevision": "workflow:sha256:retired"
        });
        let (card, _) = decode_card(&payload).expect("retired key is dropped");
        assert_eq!(card.description_category_id, 1);
        assert!(
            card.to_value()
                .expect("encode")
                .get("schemaRevision")
                .is_none()
        );
    }
}

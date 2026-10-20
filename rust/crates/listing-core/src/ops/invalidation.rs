//! Invalidation graph, pure half: which triggers a patch body fires.
//!
//! Prompt, category, PSD, source image, video, manual field and store
//! changes mark derived validation (and dependent content/media) stale
//! without clobbering newer edits. The column overlay those triggers add up
//! to is the row-lifecycle transition table in `crate::row_lifecycle`.
//! Cloud's `listing::kernel::invalidation` re-exports both unchanged; only
//! applying the overlay to a stored row (a DB write) stays there.

use serde_json::Value as JsonValue;

pub use crate::row_lifecycle::{InvalidationPatch, InvalidationTrigger};

const PROMPT_KEYS: &[&str] = &["prompt", "recognitionPrompt", "aiPrompt"];
const CATEGORY_KEYS: &[&str] = &[
    "descriptionCategoryId",
    "typeId",
    "categoryKey",
    "description_category_id",
    "type_id",
];
const PSD_KEYS: &[&str] = &["psdAssetId", "psdRevision", "psdBinding", "psd_asset_id"];
const SOURCE_KEYS: &[&str] = &["source", "sourceSha256", "sourceAssetId"];
const VIDEO_KEYS: &[&str] = &["videoAssetId", "videoBinding", "videoUrl", "video_asset_id"];

/// Derive triggers from a patch body. Fill-blank AI writes do not invalidate
/// manual validation unless they touch category/prompt keys.
pub fn triggers_for_changes(changes: &JsonValue, fill_blank: bool) -> Vec<InvalidationTrigger> {
    let Some(obj) = changes.as_object() else {
        return Vec::new();
    };
    let mut triggers = Vec::new();
    for key in obj.keys() {
        let key = key.as_str();
        if PROMPT_KEYS.contains(&key) {
            triggers.push(InvalidationTrigger::Prompt);
        }
        if CATEGORY_KEYS.contains(&key) {
            triggers.push(InvalidationTrigger::Category);
        }
        if PSD_KEYS.contains(&key) {
            triggers.push(InvalidationTrigger::Psd);
        }
        if SOURCE_KEYS.contains(&key) {
            triggers.push(InvalidationTrigger::Source);
        }
        if VIDEO_KEYS.contains(&key) {
            triggers.push(InvalidationTrigger::Video);
        }
        if key == "storeId" || key == "store_id" {
            triggers.push(InvalidationTrigger::Store);
        }
    }
    if !fill_blank && !obj.is_empty() {
        triggers.push(InvalidationTrigger::ManualField);
    }
    triggers.sort();
    triggers.dedup();
    triggers
}

/// The bytes determine recognition identity; renaming a file does not.
pub fn source_changed(previous: &JsonValue, next: &JsonValue) -> bool {
    previous.pointer("/source/sha256") != next.pointer("/source/sha256")
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn manual_patch_invalidates_validation() {
        let triggers = triggers_for_changes(&json!({"title": "x"}), false);
        assert!(triggers.contains(&InvalidationTrigger::ManualField));
    }

    #[test]
    fn fill_blank_skips_manual_invalidation() {
        let triggers = triggers_for_changes(&json!({"brand": "ai"}), true);
        assert!(!triggers.contains(&InvalidationTrigger::ManualField));
    }

    #[test]
    fn category_change_invalidates_category_and_manual() {
        let triggers = triggers_for_changes(&json!({"descriptionCategoryId": 9}), false);
        assert!(triggers.contains(&InvalidationTrigger::Category));
        assert!(triggers.contains(&InvalidationTrigger::ManualField));
    }

    #[test]
    fn psd_patch_marks_media_pending() {
        let triggers = triggers_for_changes(&json!({"psdRevision": 2}), false);
        let patch = InvalidationPatch::from_triggers(&triggers);
        assert_eq!(patch.media_state, Some("pending"));
        assert_eq!(patch.content_state, None);
    }

    #[test]
    fn source_patch_invalidates_recognition_and_media() {
        let triggers = triggers_for_changes(&json!({"source": {"sha256": "sha256:b"}}), false);
        let patch = InvalidationPatch::from_triggers(&triggers);
        assert_eq!(patch.media_state, Some("pending"));
        assert_eq!(patch.content_state, Some("draft"));
    }
}

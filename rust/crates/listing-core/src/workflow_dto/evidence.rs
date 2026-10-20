//! Prepared media, recognition and failure evidence stored in Cloud listing rows.
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum WorkflowImagePhase {
    Rendered,
    Uploading,
    PublicReady,
    Failed,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum WorkflowFailureStage {
    Ai,
    Media,
    Validation,
    Publish,
    Recovery,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct WorkflowImageLifecycle {
    pub index: u32,
    pub file_name: String,
    pub content_hash: String,
    /// PSD top-level group this slice was exported from. It is the sole
    /// authority for the slice's Seller media role (see `media_role_of`) and
    /// the reason a delivery can be replayed after a restart without a
    /// re-render. Records written before this field existed decode as `""`,
    /// which reads as "role unknown — re-render required".
    #[serde(default)]
    pub group_name: String,
    /// Rendered pixel size. Persisted for the same reason as `group_name`:
    /// a committed render cannot be rebuilt without it.
    #[serde(default)]
    pub width: u32,
    #[serde(default)]
    pub height: u32,
    #[serde(default)]
    pub byte_size: Option<u64>,
    pub phase: WorkflowImagePhase,
    pub public_url: Option<String>,
    /// Media Object Key bound to the Content Lease (allowlisted).
    pub object_key: Option<String>,
    /// Cloud account that confirmed this immutable media object.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub account_id: Option<String>,
    pub error_code: Option<String>,
}

/// Seller media role a render slice claims through its PSD group name.
/// Slices that claim no role are ordinary product images.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MediaRole {
    Images360,
    ColorImage,
}

/// The single authority mapping a PSD top-level group name onto a Seller media
/// role. There is no mapping table and no configuration: the operator names the
/// group and the composer matches case-insensitive substrings.
///
/// Cloud uses the same verdict when composing Seller media from row slices.
pub fn media_role_of(group_name: &str) -> Option<MediaRole> {
    let group = group_name.to_ascii_lowercase();
    if group.contains("360") {
        Some(MediaRole::Images360)
    } else if group.contains("color") || group.contains("颜色") {
        Some(MediaRole::ColorImage)
    } else {
        None
    }
}

/// Recognition evidence retained after `ru`, description and supported tags
/// have settled into Listing Draft fields. The model identity and original
/// tags stay here for audit and for projecting pre-mapping historical rows.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct WorkflowAiSummary {
    pub tags: Vec<String>,
    pub model: String,
}

/// One bounded, credential-free failure observation retained with a Product
/// Instance. This is the preparation-side counterpart to Listing Runs: it
/// keeps the exact safe command message after a restart without turning
/// renderer state or process stderr into business truth.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct WorkflowFailureLogEntry {
    pub stage: WorkflowFailureStage,
    /// Failure codes were persisted as JSON numbers by an older browser
    /// runtime. Keep the canonical Rust shape a string while accepting those
    /// legacy integer rows so the normal recovery/clear flow can rewrite them.
    #[serde(deserialize_with = "deserialize_failure_code")]
    pub code: String,
    pub message: String,
    #[serde(default)]
    pub remediation: Option<String>,
    #[serde(default)]
    pub image_index: Option<u32>,
    pub occurred_at_ms: u64,
}

fn deserialize_failure_code<'de, D>(deserializer: D) -> Result<String, D::Error>
where
    D: serde::Deserializer<'de>,
{
    let value = serde_json::Value::deserialize(deserializer)?;
    match value {
        serde_json::Value::String(value) => Ok(value),
        serde_json::Value::Number(value) if value.is_i64() || value.is_u64() => {
            Ok(value.to_string())
        }
        _ => Err(serde::de::Error::custom(
            "workflow failure code must be a string or integer",
        )),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_lifecycle_image_persisted_before_group_names_decodes_as_needing_a_re_render() {
        let image: WorkflowImageLifecycle = serde_json::from_str(
            r#"{"index":0,"file_name":"one.jpg","content_hash":"sha256:one","phase":"public_ready","public_url":"https://cdn.test/one.jpg","object_key":null,"error_code":null}"#,
        )
        .expect("a lifecycle written before group names were persisted still decodes");
        assert_eq!(image.group_name, "");
        assert_eq!((image.width, image.height), (0, 0));
    }

    #[test]
    fn ai_summary_rejects_the_retired_cn_field() {
        let result = serde_json::from_value::<WorkflowAiSummary>(serde_json::json!({
            "cn": "旧标题",
            "tags": ["картина"],
            "model": "model"
        }));

        assert!(result.is_err());
    }

    #[test]
    fn a_group_name_claims_at_most_one_seller_media_role() {
        assert_eq!(media_role_of("360 Spin"), Some(MediaRole::Images360));
        assert_eq!(media_role_of("COLOR"), Some(MediaRole::ColorImage));
        assert_eq!(media_role_of("颜色图"), Some(MediaRole::ColorImage));
        assert_eq!(media_role_of("颜色样本"), Some(MediaRole::ColorImage));
        // "360" wins so a slice can never be counted under two roles.
        assert_eq!(media_role_of("color-360"), Some(MediaRole::Images360));
        assert_eq!(media_role_of("主图"), None);
    }
}

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum MediaErrorCode {
    TemplateLimit,
    DimensionLimit,
    RecursionLimit,
    SlotNotFound,
    SlotOutsideGroups,
    GroupsNotFound,
    GroupTransparent,
    PresentationQualityInvalid,
    ScaleInvalid,
    SlotInvalid,
    RequestInvalid,
    OutputStagingFailed,
    Aborted,
    EncodedLimit,
    StorageTruncated,
    UnsupportedCapability,
    UnsupportedDepth,
    UnsupportedColorMode,
    CompositeOnly,
    CorruptDocument,
    InputTooLarge,
    ParseFailed,
    Io,
}

impl MediaErrorCode {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::TemplateLimit => "PSD_RENDER_TEMPLATE_LIMIT",
            Self::DimensionLimit => "PSD_RENDER_DIMENSION_LIMIT",
            Self::RecursionLimit => "PSD_RENDER_RECURSION_LIMIT",
            Self::SlotNotFound => "PSD_RENDER_SLOT_NOT_FOUND",
            Self::SlotOutsideGroups => "PSD_RENDER_SLOT_OUTSIDE_GROUPS",
            Self::GroupsNotFound => "PSD_RENDER_GROUPS_NOT_FOUND",
            Self::GroupTransparent => "PSD_RENDER_GROUP_TRANSPARENT",
            Self::PresentationQualityInvalid => "PSD_RENDER_PRESENTATION_QUALITY_INVALID",
            Self::ScaleInvalid => "PSD_RENDER_SCALE_INVALID",
            Self::SlotInvalid => "PSD_RENDER_SLOT_INVALID",
            Self::RequestInvalid => "MEDIA_RENDER_REQUEST_INVALID",
            Self::OutputStagingFailed => "PSD_RENDER_OUTPUT_STAGING_FAILED",
            Self::Aborted => "PSD_RENDER_ABORTED",
            Self::EncodedLimit => "MEDIA_ENCODED_OUTPUT_LIMIT",
            Self::StorageTruncated => "MEDIA_STORAGE_TRUNCATED_WRITE",
            Self::UnsupportedCapability => "PSD_RENDER_UNSUPPORTED_CAPABILITY",
            Self::UnsupportedDepth => "PSD_RENDER_UNSUPPORTED_DEPTH",
            Self::UnsupportedColorMode => "PSD_RENDER_UNSUPPORTED_COLOR_MODE",
            Self::CompositeOnly => "PSD_RENDER_COMPOSITE_ONLY",
            Self::CorruptDocument => "PSD_RENDER_CORRUPT_DOCUMENT",
            Self::InputTooLarge => "PSD_RENDER_INPUT_TOO_LARGE",
            Self::ParseFailed => "PSD_RENDER_PARSE_FAILED",
            Self::Io => "PSD_RENDER_IO",
        }
    }

    pub const fn retryable(self) -> bool {
        matches!(
            self,
            Self::Io | Self::OutputStagingFailed | Self::StorageTruncated
        )
    }

    pub fn remediation(self, policy: crate::psd::ProductResourcePolicy) -> String {
        match self {
            Self::TemplateLimit | Self::InputTooLarge => policy.input_remediation(),
            Self::DimensionLimit => format!(
                "Reduce exported width/height to {} px and total pixels to {} or less.",
                policy.max_output_side, policy.max_output_pixels
            ),
            Self::RecursionLimit => format!(
                "Nested PSD/PSB content exceeds depth {}. Flatten nested smart objects and retry.",
                policy.max_embedded_document_depth
            ),
            Self::UnsupportedCapability => {
                "Remove or flatten the unsupported Photoshop operation and retry.".to_owned()
            }
            Self::UnsupportedDepth => crate::psd::UNSUPPORTED_DEPTH_REMEDIATION.to_owned(),
            Self::UnsupportedColorMode => crate::psd::UNSUPPORTED_COLOR_MODE_REMEDIATION.to_owned(),
            Self::CompositeOnly => crate::psd::COMPOSITE_ONLY_REMEDIATION.to_owned(),
            Self::OutputStagingFailed | Self::Io | Self::StorageTruncated => {
                "The encoded write failed. Retry the render.".to_owned()
            }
            Self::EncodedLimit => format!(
                "Encoded output exceeds {} MiB. Reduce export dimensions or quality.",
                policy.max_encoded_bytes / (1024 * 1024)
            ),
            Self::Aborted => "The render was cancelled; retry when ready.".to_owned(),
            _ => "Review the template and render settings, then retry.".to_owned(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[error("{} during {}: {}", .code.as_str(), .phase, .detail)]
pub struct MediaError {
    pub code: MediaErrorCode,
    pub phase: String,
    pub detail: String,
    pub observed: Option<u128>,
    pub configured_limit: Option<u128>,
    pub retryable: bool,
    pub remediation: String,
}

impl MediaError {
    pub fn new(code: MediaErrorCode, phase: &'static str, detail: impl Into<String>) -> Self {
        let policy = crate::psd::ProductResourcePolicy::default();
        Self {
            code,
            phase: phase.to_owned(),
            detail: detail.into(),
            observed: None,
            configured_limit: None,
            retryable: code.retryable(),
            remediation: code.remediation(policy),
        }
    }

    pub fn resource_limit(
        code: MediaErrorCode,
        phase: &'static str,
        observed: impl Into<u128>,
        configured_limit: impl Into<u128>,
        policy: crate::psd::ProductResourcePolicy,
    ) -> Self {
        let observed = observed.into();
        let configured_limit = configured_limit.into();
        Self {
            code,
            phase: phase.to_owned(),
            detail: format!("observed {observed}; limit {configured_limit}"),
            observed: Some(observed),
            configured_limit: Some(configured_limit),
            retryable: code.retryable(),
            remediation: code.remediation(policy),
        }
    }

    pub fn io(phase: &'static str, error: std::io::Error) -> Self {
        storage_error(phase, error)
    }
}

pub(crate) fn storage_error(phase: &'static str, error: std::io::Error) -> MediaError {
    MediaError::new(code_from_io(&error), phase, error.to_string())
}

fn code_from_io(error: &std::io::Error) -> MediaErrorCode {
    if error.kind() == std::io::ErrorKind::UnexpectedEof {
        MediaErrorCode::CorruptDocument
    } else if error.kind() == std::io::ErrorKind::WriteZero {
        MediaErrorCode::StorageTruncated
    } else {
        MediaErrorCode::Io
    }
}

impl From<crate::psd::PsdError> for MediaError {
    fn from(error: crate::psd::PsdError) -> Self {
        let code = match error.code {
            crate::psd::PsdErrorCode::InputTooLarge => MediaErrorCode::InputTooLarge,
            crate::psd::PsdErrorCode::CorruptDocument => MediaErrorCode::CorruptDocument,
            crate::psd::PsdErrorCode::ParseFailed => MediaErrorCode::ParseFailed,
            crate::psd::PsdErrorCode::UnsupportedDepth => MediaErrorCode::UnsupportedDepth,
            crate::psd::PsdErrorCode::UnsupportedColorMode => MediaErrorCode::UnsupportedColorMode,
            crate::psd::PsdErrorCode::CompositeOnly => MediaErrorCode::CompositeOnly,
            crate::psd::PsdErrorCode::RecursionLimitExceeded => MediaErrorCode::RecursionLimit,
            crate::psd::PsdErrorCode::MemoryLimitExceeded
            | crate::psd::PsdErrorCode::PixelCountExceeded
            | crate::psd::PsdErrorCode::DocumentDimensionsExceeded => {
                MediaErrorCode::DimensionLimit
            }
            // Io is retryable (flag copied verbatim below); folding it into
            // ParseFailed made `code.retryable() == false` contradict
            // `self.retryable == true` for every retryable IO failure.
            crate::psd::PsdErrorCode::Io => MediaErrorCode::Io,
            // Exhaustive on purpose: a new parser code must choose its public
            // code here instead of silently becoming PSD_RENDER_PARSE_FAILED.
            crate::psd::PsdErrorCode::UnsupportedDocument
            | crate::psd::PsdErrorCode::LayerLimitExceeded => MediaErrorCode::ParseFailed,
        };
        Self {
            code,
            phase: error.phase.to_owned(),
            detail: error.detail,
            observed: error.observed,
            configured_limit: error.configured_limit,
            retryable: error.retryable,
            remediation: error.remediation,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::psd::{ProductResourcePolicy, PsdError, PsdErrorCode};

    #[test]
    fn parser_resource_context_survives_the_media_boundary() {
        let policy = ProductResourcePolicy {
            max_input_bytes: 10 * 1024 * 1024,
            ..ProductResourcePolicy::default()
        };
        let psd = PsdError::resource_limit(
            PsdErrorCode::InputTooLarge,
            "file-size-admission",
            11_u64 * 1024 * 1024,
            policy.max_input_bytes,
            policy,
        );

        let media = MediaError::from(psd);
        assert_eq!(media.observed, Some(11_u128 * 1024 * 1024));
        assert_eq!(media.configured_limit, Some(10_u128 * 1024 * 1024));
        assert!(!media.retryable);
        assert!(media.remediation.contains("10 MiB"));
    }

    #[test]
    fn truncated_write_stays_distinct_from_other_io() {
        assert_eq!(
            storage_error(
                "write",
                std::io::Error::new(std::io::ErrorKind::WriteZero, "truncated")
            )
            .code,
            MediaErrorCode::StorageTruncated
        );
        assert_eq!(
            storage_error(
                "write",
                std::io::Error::new(std::io::ErrorKind::PermissionDenied, "denied")
            )
            .code,
            MediaErrorCode::Io
        );
    }
}

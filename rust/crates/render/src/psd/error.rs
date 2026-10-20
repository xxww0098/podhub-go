use std::io;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PsdErrorCode {
    InputTooLarge,
    CorruptDocument,
    UnsupportedDocument,
    /// Header bit depth other than 8. The renderer composites RGBA8 only;
    /// 1/16/32-bit samples used to be reinterpreted as RGBA8 (garbage).
    UnsupportedDepth,
    /// Header colour mode other than RGB (Gray, CMYK, Lab, Bitmap, …).
    UnsupportedColorMode,
    /// Every layer section parsed and no layer exists: only the merged image
    /// is present, which is not an editable template and rendered transparent.
    CompositeOnly,
    DocumentDimensionsExceeded,
    PixelCountExceeded,
    LayerLimitExceeded,
    MemoryLimitExceeded,
    RecursionLimitExceeded,
    ParseFailed,
    Io,
}

impl PsdErrorCode {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::InputTooLarge => "input_too_large",
            Self::CorruptDocument => "corrupt_document",
            Self::UnsupportedDocument => "unsupported_document",
            Self::UnsupportedDepth => "unsupported_depth",
            Self::UnsupportedColorMode => "unsupported_color_mode",
            Self::CompositeOnly => "composite_only",
            Self::DocumentDimensionsExceeded => "document_dimensions_exceeded",
            Self::PixelCountExceeded => "pixel_count_exceeded",
            Self::LayerLimitExceeded => "layer_limit_exceeded",
            Self::MemoryLimitExceeded => "memory_limit_exceeded",
            Self::RecursionLimitExceeded => "recursion_limit_exceeded",
            Self::ParseFailed => "parse_failed",
            Self::Io => "io",
        }
    }

    pub fn remediation(self) -> String {
        self.remediation_with_policy(crate::psd::ProductResourcePolicy::default())
    }

    pub fn remediation_with_policy(self, policy: crate::psd::ProductResourcePolicy) -> String {
        match self {
            Self::InputTooLarge => policy.input_remediation(),
            Self::CorruptDocument => {
                "The bytes are truncated or not a valid Photoshop document. Re-export from Photoshop and try again.".to_owned()
            }
            Self::UnsupportedDocument => {
                "This document version or channel layout is not supported. Re-save it from Photoshop as an 8-bit RGB PSD/PSB.".to_owned()
            }
            Self::UnsupportedDepth => UNSUPPORTED_DEPTH_REMEDIATION.to_owned(),
            Self::UnsupportedColorMode => UNSUPPORTED_COLOR_MODE_REMEDIATION.to_owned(),
            Self::CompositeOnly => COMPOSITE_ONLY_REMEDIATION.to_owned(),
            Self::DocumentDimensionsExceeded => policy.document_format_remediation(),
            Self::PixelCountExceeded => {
                format!(
                    "Document pixel count exceeds the import ceiling of {} pixels. Reduce canvas size and retry.",
                    policy.max_canvas_pixels
                )
            }
            Self::LayerLimitExceeded => format!(
                "The document contains more than {} layer records. Flatten unused layers or split the template.",
                policy.max_layer_records
            ),
            Self::MemoryLimitExceeded => {
                format!(
                    "The document needs more than {} MiB of parser memory. Flatten unused layers or simplify smart objects.",
                    policy.max_parser_live_bytes / (1024 * 1024)
                )
            }
            Self::RecursionLimitExceeded => {
                format!(
                    "Layer or descriptor nesting exceeds depth {}. Flatten nested groups and retry.",
                    policy.max_descriptor_depth
                )
            }
            Self::ParseFailed => {
                "The document could not be inspected. Re-export from Photoshop; if it persists, report the bytes as unsupported.".to_owned()
            }
            Self::Io => {
                "The document bytes could not be read. Retry the render or re-export from Photoshop.".to_owned()
            }
        }
    }

    pub const fn retryable(self) -> bool {
        matches!(self, Self::Io)
    }
}

/// User-facing remediation for the Wave-0 structural rejections. These are
/// content failures: re-uploading the same bytes cannot succeed, so the copy
/// never suggests a retry.
pub(crate) const UNSUPPORTED_DEPTH_REMEDIATION: &str =
    "当前模板位深不受支持。请在 Photoshop 中将副本转为 8 位/通道，保留替换图层后重新保存。";
pub(crate) const UNSUPPORTED_COLOR_MODE_REMEDIATION: &str = "当前模板色彩模式不受支持。请在 Photoshop 中转为 RGB，并通过“转换为配置文件”转为 sRGB 后重新保存。";
pub(crate) const COMPOSITE_ONLY_REMEDIATION: &str =
    "当前文件仅包含合并图像，不能作为可替换模板。请上传保留替换图层的分层 PSD/PSB。";

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[error("{} during {}: {}", .code.as_str(), .phase, .detail)]
pub struct PsdError {
    pub code: PsdErrorCode,
    pub phase: &'static str,
    pub detail: String,
    pub observed: Option<u128>,
    pub configured_limit: Option<u128>,
    pub retryable: bool,
    pub remediation: String,
}

impl PsdError {
    pub fn new(code: PsdErrorCode, phase: &'static str, detail: impl Into<String>) -> Self {
        let policy = crate::psd::ProductResourcePolicy::default();
        Self {
            code,
            phase,
            detail: detail.into(),
            observed: None,
            configured_limit: None,
            retryable: code.retryable(),
            remediation: code.remediation_with_policy(policy),
        }
    }

    pub fn resource_limit(
        code: PsdErrorCode,
        phase: &'static str,
        observed: impl Into<u128>,
        configured_limit: impl Into<u128>,
        policy: crate::psd::ProductResourcePolicy,
    ) -> Self {
        let observed = observed.into();
        let configured_limit = configured_limit.into();
        Self {
            code,
            phase,
            detail: format!("observed {observed}; limit {configured_limit}"),
            observed: Some(observed),
            configured_limit: Some(configured_limit),
            retryable: code.retryable(),
            remediation: code.remediation_with_policy(policy),
        }
    }

    pub fn io(phase: &'static str, error: io::Error) -> Self {
        let code = if error.kind() == io::ErrorKind::UnexpectedEof {
            PsdErrorCode::CorruptDocument
        } else {
            PsdErrorCode::Io
        };
        Self::new(code, phase, error.to_string())
    }

    pub fn message(&self) -> String {
        format!(
            "{} during {}: {}",
            self.code.as_str(),
            self.phase,
            self.detail
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::psd::ProductResourcePolicy;

    #[test]
    fn resource_failure_preserves_observed_limit_retryability_and_policy_remediation() {
        let policy = ProductResourcePolicy {
            max_input_bytes: 10 * 1024 * 1024,
            ..ProductResourcePolicy::default()
        };
        let error = PsdError::resource_limit(
            PsdErrorCode::InputTooLarge,
            "file-size-admission",
            11_u64 * 1024 * 1024,
            policy.max_input_bytes,
            policy,
        );

        assert_eq!(error.observed, Some(11 * 1024 * 1024));
        assert_eq!(error.configured_limit, Some(10 * 1024 * 1024));
        assert!(!error.retryable);
        assert!(error.remediation.contains("10 MiB"));
        assert!(!error.remediation.contains("64 MiB"));
    }
}

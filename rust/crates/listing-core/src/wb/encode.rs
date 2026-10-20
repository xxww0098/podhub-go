//! Exact WB upload limits and encoding, shared by native and WASM.
use super::protocol::CardGroup;

pub const MAX_UPLOAD_BYTES: usize = 10 * 1024 * 1024;
const MAX_UPLOAD_GROUPS: usize = 100;
const MAX_GROUP_VARIANTS: usize = 30;
const MAX_VENDOR_CODE_CHARS: usize = 72;
const MAX_TITLE_CHARS: usize = 60;

/// A local card-upload validation failure.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[non_exhaustive]
pub enum ValidationError {
    /// No card groups were supplied.
    #[error("upload must contain at least one card group")]
    EmptyUpload,
    /// More than 100 groups were supplied.
    #[error("upload contains {actual} card groups; maximum is {maximum}")]
    TooManyGroups {
        /// Actual number of groups.
        actual: usize,
        /// Accepted maximum.
        maximum: usize,
    },
    /// A group did not contain between one and 30 variants.
    #[error("card group {group} contains {actual} variants; expected 1..={maximum}")]
    InvalidVariantCount {
        /// Zero-based group index.
        group: usize,
        /// Actual number of variants.
        actual: usize,
        /// Accepted maximum.
        maximum: usize,
    },
    /// A seller article was blank after trimming.
    #[error("vendorCode in group {group}, variant {variant} must not be blank")]
    EmptyVendorCode {
        /// Zero-based group index.
        group: usize,
        /// Zero-based variant index.
        variant: usize,
    },
    /// A seller article exceeded WB's character limit.
    #[error(
        "vendorCode in group {group}, variant {variant} has {characters} characters; maximum is {maximum}"
    )]
    VendorCodeTooLong {
        /// Zero-based group index.
        group: usize,
        /// Zero-based variant index.
        variant: usize,
        /// Unicode scalar count.
        characters: usize,
        /// Accepted maximum.
        maximum: usize,
    },
    /// A product title exceeded WB's character limit.
    #[error(
        "title in group {group}, variant {variant} has {characters} characters; maximum is {maximum}"
    )]
    TitleTooLong {
        /// Zero-based group index.
        group: usize,
        /// Zero-based variant index.
        variant: usize,
        /// Unicode scalar count.
        characters: usize,
        /// Accepted maximum.
        maximum: usize,
    },
    /// JSON must never silently turn non-finite dimensions into null.
    #[error("non-finite dimension in group {group}, variant {variant}")]
    NonfiniteDimension { group: usize, variant: usize },
    /// The exact serialized upload exceeded 10 MiB.
    #[error("serialized upload is {bytes} bytes; maximum is {maximum} bytes")]
    UploadTooLarge {
        /// Exact serialized body size.
        bytes: usize,
        /// Accepted maximum.
        maximum: usize,
    },
}

#[derive(Debug, thiserror::Error)]
pub enum EncodeError {
    #[error(transparent)]
    Validation(#[from] ValidationError),
    #[error(transparent)]
    Serialize(#[from] serde_json::Error),
}

pub fn encode_upload(groups: &[CardGroup]) -> Result<Vec<u8>, EncodeError> {
    if groups.is_empty() {
        return Err(ValidationError::EmptyUpload.into());
    }
    if groups.len() > MAX_UPLOAD_GROUPS {
        return Err(ValidationError::TooManyGroups {
            actual: groups.len(),
            maximum: MAX_UPLOAD_GROUPS,
        }
        .into());
    }
    for (group_index, group) in groups.iter().enumerate() {
        if group.variants.is_empty() || group.variants.len() > MAX_GROUP_VARIANTS {
            return Err(ValidationError::InvalidVariantCount {
                group: group_index,
                actual: group.variants.len(),
                maximum: MAX_GROUP_VARIANTS,
            }
            .into());
        }
        for (variant_index, variant) in group.variants.iter().enumerate() {
            if variant
                .dimensions
                .as_ref()
                .and_then(|d| d.weight_brutto)
                .is_some_and(|n| !n.is_finite())
            {
                return Err(ValidationError::NonfiniteDimension {
                    group: group_index,
                    variant: variant_index,
                }
                .into());
            }
            if variant.vendor_code.trim().is_empty() {
                return Err(ValidationError::EmptyVendorCode {
                    group: group_index,
                    variant: variant_index,
                }
                .into());
            }
            let vendor_code_chars = variant.vendor_code.chars().count();
            if vendor_code_chars > MAX_VENDOR_CODE_CHARS {
                return Err(ValidationError::VendorCodeTooLong {
                    group: group_index,
                    variant: variant_index,
                    characters: vendor_code_chars,
                    maximum: MAX_VENDOR_CODE_CHARS,
                }
                .into());
            }
            if let Some(title) = &variant.title {
                let title_chars = title.chars().count();
                if title_chars > MAX_TITLE_CHARS {
                    return Err(ValidationError::TitleTooLong {
                        group: group_index,
                        variant: variant_index,
                        characters: title_chars,
                        maximum: MAX_TITLE_CHARS,
                    }
                    .into());
                }
            }
        }
    }

    let body = serde_json::to_vec(groups)?;
    if body.len() > MAX_UPLOAD_BYTES {
        return Err(ValidationError::UploadTooLarge {
            bytes: body.len(),
            maximum: MAX_UPLOAD_BYTES,
        }
        .into());
    }
    Ok(body)
}

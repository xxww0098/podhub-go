mod admit;
mod error;
mod limits;
pub(crate) mod render;

use psdx::reader::ReadError;

pub(crate) fn map_read_error(error: ReadError) -> error::PsdError {
    let detail = error.to_string();
    let policy = ProductResourcePolicy::default();
    match error {
        ReadError::DocumentLimitExceeded {
            width,
            height,
            limit,
        } => {
            return error::PsdError::resource_limit(
                error::PsdErrorCode::DocumentDimensionsExceeded,
                "parser-header",
                u128::from(width.max(height)),
                u128::from(limit),
                policy,
            );
        }
        ReadError::PixelLimitExceeded { pixels, limit } => {
            return error::PsdError::resource_limit(
                error::PsdErrorCode::PixelCountExceeded,
                "parser-header",
                pixels,
                u128::from(limit),
                policy,
            );
        }
        ReadError::LayerLimitExceeded { observed, limit } => {
            return error::PsdError::resource_limit(
                error::PsdErrorCode::LayerLimitExceeded,
                "layer-records",
                u128::from(observed),
                u128::from(limit),
                policy,
            );
        }
        ReadError::RecursionLimitExceeded { observed, limit } => {
            return error::PsdError::resource_limit(
                error::PsdErrorCode::RecursionLimitExceeded,
                "parser-recursion",
                u128::from(observed),
                u128::from(limit),
                policy,
            );
        }
        ReadError::ExceededMemoryLimit {
            observed, limit, ..
        } => {
            return error::PsdError::resource_limit(
                error::PsdErrorCode::MemoryLimitExceeded,
                "parser-allocation",
                observed as u128,
                limit as u128,
                policy,
            );
        }
        ReadError::AllocationFailed { requested, .. } => {
            return error::PsdError::resource_limit(
                error::PsdErrorCode::MemoryLimitExceeded,
                "parser-allocation",
                requested as u128,
                policy.max_parser_live_bytes as u128,
                policy,
            );
        }
        ReadError::CorruptChannel {
            channel,
            ref detail,
        } => {
            // The parser reports the channel it was asked to consume; keep that
            // identifier in the message so a user can point at the layer plane
            // that is damaged instead of re-uploading blindly.
            return error::PsdError::new(
                error::PsdErrorCode::CorruptDocument,
                "channel-decode",
                format!("channel {channel}: {detail}"),
            );
        }
        _ => {}
    }
    error::PsdError::new(error::PsdErrorCode::ParseFailed, "parser", detail)
}

pub(crate) use error::{
    COMPOSITE_ONLY_REMEDIATION, PsdError, PsdErrorCode, UNSUPPORTED_COLOR_MODE_REMEDIATION,
    UNSUPPORTED_DEPTH_REMEDIATION,
};
pub(crate) use limits::Limits;
pub use limits::ProductResourcePolicy;
pub(crate) use render::{
    Bitmap, LayerNode, LinkedFileData, PlacedGeom, RenderDocument, SourceContent,
};

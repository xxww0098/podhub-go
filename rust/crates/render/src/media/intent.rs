use crate::media::error::{MediaError, MediaErrorCode};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum FitMode {
    Cover,
    Contain,
    Fill,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ExportBounds {
    Trim,
    Canvas,
}

/// Whether the groups whose pixels cannot depend on the design are rendered.
///
/// `Skip` leaves them out: their slices still come back in group order, with
/// no bytes and `static_group = true`, for the caller to fill from the cache it
/// keeps per template fingerprint and render profile. The static set is
/// structural — a group is static only when the selected slot is unreachable
/// from it, directly or through any linked PSD — so a cached slice can never
/// carry another design's pixels.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum StaticGroups {
    #[default]
    Render,
    Skip,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RenderIntent {
    pub fit: FitMode,
    pub slot_selection: String,
    pub export_bounds: ExportBounds,
    pub export_scale: f64,
    pub presentation_quality: u8,
    /// Not part of the render profile: it changes what is rendered, never how.
    #[serde(default)]
    pub static_groups: StaticGroups,
}

/// Product-slice JPEG quality. Below 90 the encoder uses 4:2:0
/// (`encode.rs`). 82 is the size/quality point measured for a 3:4 canvas in
/// `docs/pricing.md` §3.1. The browser default in `web/src/render/wasm.ts`
/// must stay equal to this.
pub(crate) const DEFAULT_PRESENTATION_QUALITY: u8 = 82;

pub(super) fn admit_render_intent(input: &RenderIntent) -> Result<RenderIntent, MediaError> {
    if input.presentation_quality == 0 || input.presentation_quality > 100 {
        return Err(MediaError::new(
            MediaErrorCode::PresentationQualityInvalid,
            "intent-admission",
            "presentation quality must be 1..=100",
        ));
    }
    if input.export_scale < 0.1 || input.export_scale > 4.0 || !input.export_scale.is_finite() {
        return Err(MediaError::new(
            MediaErrorCode::ScaleInvalid,
            "intent-admission",
            "export scale must be 0.1..=4",
        ));
    }
    if input.slot_selection.is_empty() {
        return Err(MediaError::new(
            MediaErrorCode::SlotInvalid,
            "intent-admission",
            "slot selection must be non-empty",
        ));
    }
    Ok(input.clone())
}

impl Default for RenderIntent {
    fn default() -> Self {
        Self {
            fit: FitMode::Cover,
            slot_selection: "auto".to_owned(),
            export_bounds: ExportBounds::Trim,
            export_scale: 1.0,
            presentation_quality: DEFAULT_PRESENTATION_QUALITY,
            static_groups: StaticGroups::Render,
        }
    }
}

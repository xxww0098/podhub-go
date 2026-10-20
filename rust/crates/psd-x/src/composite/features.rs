//! Detect compositor non-capabilities present on a layer and emit typed warnings.

use crate::psd::{
    BlendMode, BlendingRange, BlendingRanges, ColorMode, Layer, LayerEffectsInfo, LayerMaskData,
    Psd,
};

use super::report::{CompositeWarning, MaskIgnoredReason, UnrenderedFeature, WarningLog};

const FULL_BLEND_RANGE: [f64; 4] = [0.0, 0.0, 255.0, 255.0];

fn feature(path: &[usize], feature: UnrenderedFeature) -> CompositeWarning {
    CompositeWarning::FeatureNotEvaluated {
        path: path.to_vec(),
        feature,
    }
}

fn range_is_full(range: &[f64]) -> bool {
    range == FULL_BLEND_RANGE
}

fn blending_range_is_full(range: &BlendingRange) -> bool {
    range_is_full(&range.source_range) && range_is_full(&range.dest_range)
}

/// True when blend-if / blending ranges actually restrict compositing.
pub(crate) fn blending_ranges_are_restrictive(ranges: &BlendingRanges) -> bool {
    !range_is_full(&ranges.composite_gray_blend_source)
        || !range_is_full(&ranges.composite_graph_blend_destination_range)
        || ranges.ranges.iter().any(|r| !blending_range_is_full(r))
}

fn effects_present(effects: &LayerEffectsInfo) -> bool {
    if effects.disabled == Some(true) {
        return false;
    }
    effects.drop_shadow.as_ref().is_some_and(|v| !v.is_empty())
        || effects.inner_shadow.as_ref().is_some_and(|v| !v.is_empty())
        || effects.outer_glow.is_some()
        || effects.inner_glow.is_some()
        || effects.bevel.is_some()
        || effects.solid_fill.as_ref().is_some_and(|v| !v.is_empty())
        || effects.satin.is_some()
        || effects.stroke.as_ref().is_some_and(|v| !v.is_empty())
        || effects
            .gradient_overlay
            .as_ref()
            .is_some_and(|v| !v.is_empty())
        || effects.pattern_overlay.is_some()
}

/// Emit warnings for features present on `layer` that the compositor does not evaluate.
pub(crate) fn report_layer_features(warnings: &mut WarningLog, path: &[usize], layer: &Layer) {
    let info = &layer.additional_info;

    if info.adjustment.is_some() {
        warnings.push(feature(path, UnrenderedFeature::AdjustmentLayer));
    }
    if info.effects.as_ref().is_some_and(effects_present) {
        warnings.push(feature(path, UnrenderedFeature::LayerEffects));
    }
    if info.vector_fill.is_some() {
        warnings.push(feature(path, UnrenderedFeature::VectorFill));
    }
    if info.vector_stroke.is_some() {
        warnings.push(feature(path, UnrenderedFeature::VectorStroke));
    }
    if let Some(mask) = &info.vector_mask {
        if mask.disable != Some(true) {
            warnings.push(feature(path, UnrenderedFeature::VectorMask));
        }
    }
    if info.real_mask.is_some() {
        warnings.push(feature(path, UnrenderedFeature::RealMask));
    }
    if info.knockout == Some(true) {
        warnings.push(feature(path, UnrenderedFeature::Knockout));
    }
    if info
        .blending_ranges
        .as_ref()
        .is_some_and(blending_ranges_are_restrictive)
    {
        warnings.push(feature(path, UnrenderedFeature::BlendRanges));
    }
    // Default is true; only the non-default false value changes blending semantics.
    if info.transparency_shapes_layer == Some(false) {
        warnings.push(feature(path, UnrenderedFeature::TransparencyShapesLayer));
    }
    // Default is true ("blend clipped as group"); false is the unevaluated case.
    if info.blend_clippend_elements == Some(false) {
        warnings.push(feature(path, UnrenderedFeature::BlendClippedElements));
    }
    if info.artboard.is_some() {
        warnings.push(feature(path, UnrenderedFeature::ArtboardRect));
    }
}

/// Softness / positioning parameters ignored while a usable mask is still applied.
pub(crate) fn report_mask_approximations(
    warnings: &mut WarningLog,
    path: &[usize],
    mask: &LayerMaskData,
) {
    if mask.user_mask_feather.is_some_and(|f| f != 0.0)
        || mask.vector_mask_feather.is_some_and(|f| f != 0.0)
    {
        warnings.push(CompositeWarning::MaskIgnored {
            path: path.to_vec(),
            reason: MaskIgnoredReason::FeatherIgnored,
        });
    }
    if mask.user_mask_density.is_some_and(|d| d != 1.0)
        || mask.vector_mask_density.is_some_and(|d| d != 1.0)
    {
        warnings.push(CompositeWarning::MaskIgnored {
            path: path.to_vec(),
            reason: MaskIgnoredReason::DensityIgnored,
        });
    }
    if mask.position_relative_to_layer == Some(true) {
        warnings.push(CompositeWarning::MaskIgnored {
            path: path.to_vec(),
            reason: MaskIgnoredReason::LayerRelativePositioning,
        });
    }
}

pub(crate) fn report_document_color_space(warnings: &mut WarningLog, psd: &Psd) {
    match psd.color_mode {
        None | Some(ColorMode::Rgb) => {}
        Some(_) => {
            warnings.push(feature(&[], UnrenderedFeature::NonRgbColorSpace));
        }
    }
}

pub(crate) fn report_dissolve(warnings: &mut WarningLog, path: &[usize], mode: BlendMode) {
    if mode == BlendMode::Dissolve {
        warnings.push(feature(path, UnrenderedFeature::DissolveDither));
    }
}

pub(crate) fn report_pass_through_downgrade(warnings: &mut WarningLog, path: &[usize]) {
    warnings.push(feature(path, UnrenderedFeature::PassThroughDowngraded));
}

pub(crate) fn report_top_level_blend_ineffective(warnings: &mut WarningLog, path: &[usize]) {
    warnings.push(feature(path, UnrenderedFeature::TopLevelBlendIneffective));
}

pub(crate) fn report_clipped_to_canvas(warnings: &mut WarningLog, path: &[usize]) {
    warnings.push(CompositeWarning::ClippedToCanvas {
        path: path.to_vec(),
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::psd::BlendingRange;

    #[test]
    fn default_blending_ranges_are_not_restrictive() {
        let ranges = BlendingRanges {
            composite_gray_blend_source: FULL_BLEND_RANGE.to_vec(),
            composite_graph_blend_destination_range: FULL_BLEND_RANGE.to_vec(),
            ranges: vec![BlendingRange {
                source_range: FULL_BLEND_RANGE.to_vec(),
                dest_range: FULL_BLEND_RANGE.to_vec(),
            }],
        };
        assert!(!blending_ranges_are_restrictive(&ranges));
    }

    #[test]
    fn custom_blend_if_is_restrictive() {
        let ranges = BlendingRanges {
            composite_gray_blend_source: FULL_BLEND_RANGE.to_vec(),
            composite_graph_blend_destination_range: vec![81.0, 255.0, 255.0, 255.0],
            ranges: vec![],
        };
        assert!(blending_ranges_are_restrictive(&ranges));
    }
}

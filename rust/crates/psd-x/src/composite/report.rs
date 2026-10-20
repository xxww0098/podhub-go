//! Typed fidelity report for compositing.
//!
//! [`CompositeWarning::Display`] reproduces the Export As warning strings so
//! the adapter can map typed entries back to unchanged text.

use std::fmt;

use crate::psd::BlendMode;

/// One distinct fidelity condition observed during compositing.
#[derive(Debug, Clone, PartialEq)]
pub enum CompositeWarning {
    UnsupportedBlendMode {
        path: Vec<usize>,
        mode: BlendMode,
    },
    SmartObjectWithoutRaster {
        path: Vec<usize>,
        name: Option<String>,
    },
    UnsupportedDepth {
        path: Vec<usize>,
        depth: u8,
    },
    MalformedRaster {
        path: Vec<usize>,
        name: Option<String>,
        expected: usize,
        found: usize,
    },
    MaskIgnored {
        path: Vec<usize>,
        reason: MaskIgnoredReason,
    },
    FeatureNotEvaluated {
        path: Vec<usize>,
        feature: UnrenderedFeature,
    },
    ClippedToCanvas {
        path: Vec<usize>,
    },
    MissingGeometry {
        path: Vec<usize>,
        name: Option<String>,
    },
}

/// Why a layer mask was not applied.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum MaskIgnoredReason {
    UnsupportedDepth {
        depth: u8,
    },
    /// Mask record present but neither `image_data` nor `canvas` holds pixels.
    NoPixelData,
    FeatherIgnored,
    DensityIgnored,
    LayerRelativePositioning,
}

/// Features the compositor does not evaluate.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum UnrenderedFeature {
    AdjustmentLayer,
    LayerEffects,
    VectorFill,
    VectorStroke,
    VectorMask,
    RealMask,
    Knockout,
    BlendRanges,
    TransparencyShapesLayer,
    BlendClippedElements,
    ArtboardRect,
    DissolveDither,
    NonRgbColorSpace,
    PassThroughDowngraded,
    TopLevelBlendIneffective,
}

/// A deduplicated warning plus how many times the identical condition occurred.
#[derive(Debug, Clone, PartialEq)]
pub struct CompositeWarningReport {
    pub warning: CompositeWarning,
    pub count: u32,
}

impl CompositeWarning {
    pub fn path(&self) -> &[usize] {
        match self {
            Self::UnsupportedBlendMode { path, .. }
            | Self::SmartObjectWithoutRaster { path, .. }
            | Self::UnsupportedDepth { path, .. }
            | Self::MalformedRaster { path, .. }
            | Self::MaskIgnored { path, .. }
            | Self::FeatureNotEvaluated { path, .. }
            | Self::ClippedToCanvas { path }
            | Self::MissingGeometry { path, .. } => path,
        }
    }

    /// Whether this warning means content was omitted rather than approximated.
    ///
    /// Skip-class warnings refuse [`crate::refresh_document_composite`]: writing a
    /// partial flatten over a Photoshop-authored composite would be irreversible
    /// silent loss. Approximations (blend downgrade, ignored mask) and canvas
    /// clipping (inherent to a document-sized composite) are not skip-class.
    pub fn is_skip_class(&self) -> bool {
        match self {
            Self::SmartObjectWithoutRaster { .. }
            | Self::UnsupportedDepth { .. }
            | Self::MalformedRaster { .. }
            | Self::MissingGeometry { .. } => true,
            // Structural blend approximations still produce pixels — not skips.
            Self::FeatureNotEvaluated { feature, .. } => !matches!(
                feature,
                UnrenderedFeature::DissolveDither
                    | UnrenderedFeature::PassThroughDowngraded
                    | UnrenderedFeature::TopLevelBlendIneffective
            ),
            Self::UnsupportedBlendMode { .. }
            | Self::MaskIgnored { .. }
            | Self::ClippedToCanvas { .. } => false,
        }
    }
}

impl fmt::Display for CompositeWarning {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::UnsupportedBlendMode { mode, .. } => {
                write!(f, "unsupported blend mode {mode:?}; rendered as normal")
            }
            Self::SmartObjectWithoutRaster { name, .. } => {
                let name = name.as_deref().unwrap_or("unnamed smart object");
                write!(
                    f,
                    "smart object {name:?} has no cached raster and was not rendered"
                )
            }
            Self::UnsupportedDepth { depth, .. } => {
                write!(f, "unsupported pixel depth {depth}")
            }
            Self::MalformedRaster { name, .. } => {
                let name = name.as_deref().unwrap_or("unnamed layer");
                write!(
                    f,
                    "layer {name:?} has a malformed or unsupported pixel buffer and was not rendered"
                )
            }
            Self::MaskIgnored { reason, .. } => match reason {
                MaskIgnoredReason::UnsupportedDepth { depth } => {
                    write!(f, "layer mask with unsupported depth {depth} was ignored")
                }
                MaskIgnoredReason::NoPixelData => {
                    write!(f, "layer mask has no pixel data and was ignored")
                }
                MaskIgnoredReason::FeatherIgnored => {
                    write!(f, "layer mask feather was ignored")
                }
                MaskIgnoredReason::DensityIgnored => {
                    write!(f, "layer mask density was ignored")
                }
                MaskIgnoredReason::LayerRelativePositioning => {
                    write!(f, "layer mask layer-relative positioning was not applied")
                }
            },
            Self::FeatureNotEvaluated { feature, .. } => {
                write!(f, "feature not evaluated: {feature:?}")
            }
            Self::ClippedToCanvas { .. } => {
                write!(f, "layer content was clipped to the canvas")
            }
            Self::MissingGeometry { name, .. } => {
                let name = name.as_deref().unwrap_or("unnamed layer");
                write!(
                    f,
                    "layer {name:?} has pixels but missing geometry and was not rendered"
                )
            }
        }
    }
}

/// Accumulates warnings, merging identical conditions into a single counted entry.
#[derive(Debug, Default)]
pub(crate) struct WarningLog {
    entries: Vec<CompositeWarningReport>,
}

impl WarningLog {
    pub(crate) fn push(&mut self, warning: CompositeWarning) {
        if let Some(existing) = self.entries.iter_mut().find(|e| e.warning == warning) {
            existing.count = existing.count.saturating_add(1);
        } else {
            self.entries
                .push(CompositeWarningReport { warning, count: 1 });
        }
    }

    pub(crate) fn into_reports(self) -> Vec<CompositeWarningReport> {
        self.entries
    }
}

/// Expand counted reports into the historical flat string list for Export As.
pub(crate) fn warning_strings(reports: &[CompositeWarningReport]) -> Vec<String> {
    let mut out = Vec::new();
    for report in reports {
        for _ in 0..report.count {
            out.push(report.warning.to_string());
        }
    }
    out
}

/// Coarse fidelity class derived solely from a typed report.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CompositeFidelity {
    /// No fidelity warnings — every evaluated input was applied as implemented.
    Full,
    /// Output was produced with known structural or mode approximations.
    Approximated,
    /// At least one feature was skipped or content was discarded.
    Partial,
}

fn warning_is_approximation(warning: &CompositeWarning) -> bool {
    match warning {
        CompositeWarning::UnsupportedBlendMode { .. } => true,
        CompositeWarning::MaskIgnored { reason, .. } => matches!(
            reason,
            MaskIgnoredReason::FeatherIgnored
                | MaskIgnoredReason::DensityIgnored
                | MaskIgnoredReason::LayerRelativePositioning
        ),
        CompositeWarning::FeatureNotEvaluated { feature, .. } => matches!(
            feature,
            UnrenderedFeature::DissolveDither
                | UnrenderedFeature::PassThroughDowngraded
                | UnrenderedFeature::TopLevelBlendIneffective
        ),
        _ => false,
    }
}

/// Classify a report as fully rendered, approximated, or partial.
///
/// Partial wins over approximated when both kinds of entries are present.
pub fn fidelity(reports: &[CompositeWarningReport]) -> CompositeFidelity {
    if reports.is_empty() {
        return CompositeFidelity::Full;
    }
    let mut approximated = false;
    for report in reports {
        if warning_is_approximation(&report.warning) {
            approximated = true;
        } else {
            return CompositeFidelity::Partial;
        }
    }
    if approximated {
        CompositeFidelity::Approximated
    } else {
        CompositeFidelity::Full
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn display_matches_legacy_export_strings() {
        assert_eq!(
            CompositeWarning::UnsupportedBlendMode {
                path: vec![0],
                mode: BlendMode::LinearHeight,
            }
            .to_string(),
            "unsupported blend mode LinearHeight; rendered as normal"
        );
        assert_eq!(
            CompositeWarning::SmartObjectWithoutRaster {
                path: vec![1],
                name: Some("Logo".into()),
            }
            .to_string(),
            "smart object \"Logo\" has no cached raster and was not rendered"
        );
        assert_eq!(
            CompositeWarning::MalformedRaster {
                path: vec![0],
                name: Some("Short".into()),
                expected: 16,
                found: 4,
            }
            .to_string(),
            "layer \"Short\" has a malformed or unsupported pixel buffer and was not rendered"
        );
        assert_eq!(
            CompositeWarning::MaskIgnored {
                path: vec![0, 1],
                reason: MaskIgnoredReason::UnsupportedDepth { depth: 16 },
            }
            .to_string(),
            "layer mask with unsupported depth 16 was ignored"
        );
        assert_eq!(
            CompositeWarning::MaskIgnored {
                path: vec![0],
                reason: MaskIgnoredReason::NoPixelData,
            }
            .to_string(),
            "layer mask has no pixel data and was ignored"
        );
        assert_eq!(
            CompositeWarning::MissingGeometry {
                path: vec![0, 0],
                name: Some("Point".into()),
            }
            .to_string(),
            "layer \"Point\" has pixels but missing geometry and was not rendered"
        );
    }

    #[test]
    fn skip_class_marks_omitted_content_only() {
        assert!(
            CompositeWarning::MissingGeometry {
                path: vec![0],
                name: None,
            }
            .is_skip_class()
        );
        assert!(
            CompositeWarning::FeatureNotEvaluated {
                path: vec![0],
                feature: UnrenderedFeature::LayerEffects,
            }
            .is_skip_class()
        );
        // Engine emits Dissolve as FeatureNotEvaluated::DissolveDither, not
        // UnsupportedBlendMode — that path must stay non-skip for refresh.
        assert!(
            !CompositeWarning::FeatureNotEvaluated {
                path: vec![0],
                feature: UnrenderedFeature::DissolveDither,
            }
            .is_skip_class()
        );
        assert!(
            !CompositeWarning::FeatureNotEvaluated {
                path: vec![0],
                feature: UnrenderedFeature::PassThroughDowngraded,
            }
            .is_skip_class()
        );
        assert!(
            !CompositeWarning::UnsupportedBlendMode {
                path: vec![0],
                mode: BlendMode::Dissolve,
            }
            .is_skip_class()
        );
        assert!(
            !CompositeWarning::MaskIgnored {
                path: vec![0],
                reason: MaskIgnoredReason::NoPixelData,
            }
            .is_skip_class()
        );
        assert!(!CompositeWarning::ClippedToCanvas { path: vec![0] }.is_skip_class());
    }

    #[test]
    fn identical_conditions_are_counted() {
        let mut log = WarningLog::default();
        let w = CompositeWarning::UnsupportedBlendMode {
            path: vec![2],
            mode: BlendMode::Height,
        };
        log.push(w.clone());
        log.push(w);
        log.push(CompositeWarning::MaskIgnored {
            path: vec![2],
            reason: MaskIgnoredReason::NoPixelData,
        });
        let reports = log.into_reports();
        assert_eq!(reports.len(), 2);
        assert_eq!(reports[0].count, 2);
        assert_eq!(reports[1].count, 1);
        assert_eq!(
            warning_strings(&reports),
            [
                "unsupported blend mode Height; rendered as normal",
                "unsupported blend mode Height; rendered as normal",
                "layer mask has no pixel data and was ignored",
            ]
        );
    }

    #[test]
    fn fidelity_distinguishes_full_approximated_and_partial() {
        assert_eq!(fidelity(&[]), CompositeFidelity::Full);

        let approximated = [CompositeWarningReport {
            warning: CompositeWarning::FeatureNotEvaluated {
                path: vec![0],
                feature: UnrenderedFeature::PassThroughDowngraded,
            },
            count: 1,
        }];
        assert_eq!(fidelity(&approximated), CompositeFidelity::Approximated);

        let partial = [CompositeWarningReport {
            warning: CompositeWarning::FeatureNotEvaluated {
                path: vec![1],
                feature: UnrenderedFeature::AdjustmentLayer,
            },
            count: 1,
        }];
        assert_eq!(fidelity(&partial), CompositeFidelity::Partial);

        let mixed = [
            approximated[0].clone(),
            CompositeWarningReport {
                warning: CompositeWarning::ClippedToCanvas { path: vec![0] },
                count: 1,
            },
        ];
        assert_eq!(fidelity(&mixed), CompositeFidelity::Partial);
    }
}

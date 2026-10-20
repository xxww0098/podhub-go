/*
File: rust/crates/psd-x/src/text_edit/geometry.rs

Purpose:
Point-text geometry honesty: after string mutations, clear optional measurement
fields psdx cannot recompute. Leave also clears layer document bounds and drops
any remaining raster so pixels never outlive geometry. Drop/Provide keep
positioned layer bounds. Box text keeps author-defined geometry (box,
transform, box_bounds, text rect).

Whether absent fields are tolerated and bounds recomputed is
**UNVERIFIED in Photoshop**.

Source compatibility:
- no-upstream-counterpart
*/

use crate::psd::{Layer, TextShapeType};

/// One optional text-geometry field cleared because it could not be recomputed.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum ClearedTextGeometryField {
    /// `LayerTextData.top`
    Top,
    /// `LayerTextData.left`
    Left,
    /// `LayerTextData.bottom`
    Bottom,
    /// `LayerTextData.right`
    Right,
    /// `LayerTextData.bounds`
    Bounds,
    /// `LayerTextData.bounding_box`
    BoundingBox,
    /// `Layer.left` (document-space ink extent)
    LayerLeft,
    /// `Layer.top`
    LayerTop,
    /// `Layer.right`
    LayerRight,
    /// `Layer.bottom`
    LayerBottom,
}

impl std::fmt::Display for ClearedTextGeometryField {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(match self {
            ClearedTextGeometryField::Top => "top",
            ClearedTextGeometryField::Left => "left",
            ClearedTextGeometryField::Bottom => "bottom",
            ClearedTextGeometryField::Right => "right",
            ClearedTextGeometryField::Bounds => "bounds",
            ClearedTextGeometryField::BoundingBox => "boundingBox",
            ClearedTextGeometryField::LayerLeft => "layerLeft",
            ClearedTextGeometryField::LayerTop => "layerTop",
            ClearedTextGeometryField::LayerRight => "layerRight",
            ClearedTextGeometryField::LayerBottom => "layerBottom",
        })
    }
}

/// Per-layer geometry honesty from one string mutation.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TextGeometryHonestyReport {
    /// Child-index path under `psd.children`.
    pub layer_path: Vec<usize>,
    /// Shape type of the edited layer (`point` or `box`).
    pub shape_type: TextShapeType,
    /// Fields cleared because psdx cannot recompute them after the string change.
    pub cleared_fields: Vec<ClearedTextGeometryField>,
}

/// Clear unrecomputable text-space measurement fields on point text.
///
/// Author-defined placement (`transform`, `point_base`) is preserved. Does **not**
/// touch layer document bounds — callers decide whether those stay (Drop/Provide
/// keep a positioned raster) or go (Leave clears bounds and the stale raster).
pub(crate) fn clear_point_text_measurements(layer: &mut Layer) -> Vec<ClearedTextGeometryField> {
    let text = layer
        .additional_info
        .text
        .as_mut()
        .expect("text layer during point-text geometry honesty");
    debug_assert_eq!(text.shape_type, Some(TextShapeType::Point));

    let mut cleared = Vec::new();

    macro_rules! clear_text {
        ($field:ident, $variant:ident) => {
            if text.$field.is_some() {
                text.$field = None;
                cleared.push(ClearedTextGeometryField::$variant);
            }
        };
    }

    clear_text!(top, Top);
    clear_text!(left, Left);
    clear_text!(bottom, Bottom);
    clear_text!(right, Right);
    clear_text!(bounds, Bounds);
    clear_text!(bounding_box, BoundingBox);

    cleared
}

fn clear_point_text_layer_bounds(layer: &mut Layer) -> Vec<ClearedTextGeometryField> {
    let mut cleared = Vec::new();

    macro_rules! clear_layer {
        ($field:ident, $variant:ident) => {
            if layer.$field.is_some() {
                layer.$field = None;
                cleared.push(ClearedTextGeometryField::$variant);
            }
        };
    }

    clear_layer!(left, LayerLeft);
    clear_layer!(top, LayerTop);
    clear_layer!(right, LayerRight);
    clear_layer!(bottom, LayerBottom);

    cleared
}

/// Clear unrecomputable ink-measurement fields **and** layer document bounds.
///
/// Author-defined placement (`transform`, `point_base`) is preserved. Box text is
/// a no-op — caller should still record `shape_type` in the session report.
pub(super) fn clear_point_text_geometry(layer: &mut Layer) -> Vec<ClearedTextGeometryField> {
    let mut cleared = clear_point_text_measurements(layer);
    cleared.extend(clear_point_text_layer_bounds(layer));
    cleared
}

/// Drop decoded/raw pixel slots so a point-text layer never keeps pixels after
/// its document bounds were cleared (Leave + geometry honesty).
pub(crate) fn clear_stale_point_text_raster(layer: &mut Layer) {
    layer.image_data = None;
    layer.canvas = None;
    layer.raw_data = None;
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::psd::{LayerAdditionalInfo, LayerTextData, Units, UnitsBounds, UnitsValue};

    fn point_layer_with_geometry() -> Layer {
        let mut layer = Layer::default();
        layer.left = Some(10.0);
        layer.top = Some(20.0);
        layer.right = Some(30.0);
        layer.bottom = Some(40.0);
        layer.additional_info = LayerAdditionalInfo {
            text: Some(LayerTextData {
                text: "hi".into(),
                shape_type: Some(TextShapeType::Point),
                top: Some(1.0),
                left: Some(2.0),
                bottom: Some(3.0),
                right: Some(4.0),
                bounds: Some(UnitsBounds {
                    top: UnitsValue {
                        units: Units::Pixels,
                        value: 1.0,
                    },
                    left: UnitsValue {
                        units: Units::Pixels,
                        value: 2.0,
                    },
                    bottom: UnitsValue {
                        units: Units::Pixels,
                        value: 3.0,
                    },
                    right: UnitsValue {
                        units: Units::Pixels,
                        value: 4.0,
                    },
                }),
                bounding_box: Some(UnitsBounds {
                    top: UnitsValue {
                        units: Units::Pixels,
                        value: 5.0,
                    },
                    left: UnitsValue {
                        units: Units::Pixels,
                        value: 6.0,
                    },
                    bottom: UnitsValue {
                        units: Units::Pixels,
                        value: 7.0,
                    },
                    right: UnitsValue {
                        units: Units::Pixels,
                        value: 8.0,
                    },
                }),
                point_base: Some(vec![0.0, 0.0]),
                transform: Some(vec![1.0, 0.0, 0.0, 1.0, 36.0, 66.0]),
                ..Default::default()
            }),
            ..Default::default()
        };
        layer
    }

    #[test]
    fn clears_all_present_point_measurement_fields() {
        let mut layer = point_layer_with_geometry();
        let cleared = clear_point_text_geometry(&mut layer);
        assert_eq!(cleared.len(), 10);
        let text = layer.additional_info.text.as_ref().unwrap();
        assert!(text.top.is_none());
        assert!(text.bounds.is_none());
        assert!(text.bounding_box.is_none());
        assert!(text.point_base.is_some());
        assert!(text.transform.is_some());
        assert!(layer.left.is_none());
    }

    #[test]
    fn already_absent_fields_not_listed() {
        let mut layer = point_layer_with_geometry();
        layer.additional_info.text.as_mut().unwrap().bounds = None;
        layer.additional_info.text.as_mut().unwrap().bounding_box = None;
        let cleared = clear_point_text_geometry(&mut layer);
        assert!(!cleared.contains(&ClearedTextGeometryField::Bounds));
        assert!(!cleared.contains(&ClearedTextGeometryField::BoundingBox));
    }

    #[test]
    fn measurements_only_preserves_layer_bounds() {
        let mut layer = point_layer_with_geometry();
        let cleared = clear_point_text_measurements(&mut layer);
        assert!(cleared.contains(&ClearedTextGeometryField::Top));
        assert!(!cleared.contains(&ClearedTextGeometryField::LayerLeft));
        assert_eq!(layer.left, Some(10.0));
        assert!(layer.additional_info.text.as_ref().unwrap().top.is_none());
    }

    #[test]
    fn clear_stale_raster_drops_pixel_slots() {
        let mut layer = point_layer_with_geometry();
        layer.image_data = Some(crate::psd::PixelData::rgba8(1, 1, vec![1, 2, 3, 4]));
        layer.canvas = Some(crate::psd::PixelData::rgba8(1, 1, vec![5, 6, 7, 8]));
        clear_stale_point_text_raster(&mut layer);
        assert!(layer.image_data.is_none());
        assert!(layer.canvas.is_none());
        assert!(layer.raw_data.is_none());
    }
}

//! Point-text string edits must not re-anchor
//! a stale raster at the document origin, and must not leave pixels without
//! layer geometry.

use psdx::psd::{
    ColorMode, Layer, LayerAdditionalInfo, LayerTextData, PixelData, Psd, TextShapeType, TextStyle,
};
use psdx::render::{ExportConcurrency, ExportOptions, export_groups, plan_top_level_groups};
use psdx::{FontResolution, RasterPolicy, TextEdit};

fn opaque(width: u32, height: u32, rgba: [u8; 4]) -> PixelData {
    PixelData::rgba8(width, height, rgba.repeat((width * height) as usize))
}

/// Anchor layer so the group still has a non-empty export rect after the text
/// layer loses geometry / pixels.
fn anchor_layer() -> Layer {
    Layer {
        left: Some(56.0),
        top: Some(56.0),
        right: Some(60.0),
        bottom: Some(60.0),
        image_data: Some(opaque(4, 4, [0, 0, 255, 255])),
        additional_info: LayerAdditionalInfo {
            name: Some("Anchor".into()),
            ..LayerAdditionalInfo::default()
        },
        ..Layer::default()
    }
}

/// Point-text layer with a vivid raster well away from the document origin.
fn point_text_layer() -> Layer {
    Layer {
        left: Some(40.0),
        top: Some(30.0),
        right: Some(48.0),
        bottom: Some(38.0),
        image_data: Some(opaque(8, 8, [255, 0, 0, 255])),
        additional_info: LayerAdditionalInfo {
            name: Some("Point".into()),
            text: Some(LayerTextData {
                text: "hi".into(),
                shape_type: Some(TextShapeType::Point),
                top: Some(1.0),
                left: Some(2.0),
                bottom: Some(3.0),
                right: Some(4.0),
                point_base: Some(vec![0.0, 0.0]),
                transform: Some(vec![1.0, 0.0, 0.0, 1.0, 40.0, 30.0]),
                style: Some(TextStyle::default()),
                ..Default::default()
            }),
            ..LayerAdditionalInfo::default()
        },
        ..Layer::default()
    }
}

fn point_text_group_psd() -> Psd {
    let group = Layer {
        additional_info: LayerAdditionalInfo {
            name: Some("Group".into()),
            ..LayerAdditionalInfo::default()
        },
        children: Some(vec![point_text_layer(), anchor_layer()]),
        ..Layer::default()
    };
    Psd {
        width: 64.0,
        height: 64.0,
        color_mode: Some(ColorMode::Rgb),
        children: Some(vec![group]),
        ..Psd::default()
    }
}

fn box_text_group_psd() -> Psd {
    let text_layer = Layer {
        left: Some(40.0),
        top: Some(30.0),
        right: Some(48.0),
        bottom: Some(38.0),
        image_data: Some(opaque(8, 8, [0, 255, 0, 255])),
        additional_info: LayerAdditionalInfo {
            name: Some("Box".into()),
            text: Some(LayerTextData {
                text: "hi".into(),
                shape_type: Some(TextShapeType::Box),
                top: Some(1.0),
                left: Some(2.0),
                bottom: Some(3.0),
                right: Some(4.0),
                box_bounds: Some(vec![0.0, 0.0, 8.0, 8.0]),
                transform: Some(vec![1.0, 0.0, 0.0, 1.0, 40.0, 30.0]),
                style: Some(TextStyle::default()),
                ..Default::default()
            }),
            ..LayerAdditionalInfo::default()
        },
        ..Layer::default()
    };
    let group = Layer {
        additional_info: LayerAdditionalInfo {
            name: Some("Group".into()),
            ..LayerAdditionalInfo::default()
        },
        children: Some(vec![text_layer]),
        ..Layer::default()
    };
    Psd {
        width: 64.0,
        height: 64.0,
        color_mode: Some(ColorMode::Rgb),
        children: Some(vec![group]),
        ..Psd::default()
    }
}

fn layer_at<'a>(psd: &'a Psd, path: &[usize]) -> &'a Layer {
    let mut layers = psd.children.as_ref().expect("children");
    let mut cur = None;
    for (depth, &idx) in path.iter().enumerate() {
        cur = layers.get(idx);
        let layer = cur.expect("path");
        if depth + 1 < path.len() {
            layers = layer.children.as_ref().expect("children");
        }
    }
    cur.expect("layer")
}

fn off_options() -> ExportOptions {
    ExportOptions {
        concurrency: ExportConcurrency::Off,
        ..ExportOptions::default()
    }
}

#[test]
fn point_text_leave_never_ends_with_pixels_and_no_bounds() {
    let mut psd = point_text_group_psd();
    {
        let mut session =
            TextEdit::begin(&mut psd, RasterPolicy::Leave, FontResolution::Resolved).unwrap();
        session
            .layer_at(&[0, 0])
            .unwrap()
            .set_text("edited")
            .unwrap();
        let report = session.finish();
        assert!(
            report.geometry_honesty[0]
                .cleared_fields
                .iter()
                .any(|f| matches!(f, psdx::ClearedTextGeometryField::LayerLeft))
        );
        assert!(
            report.geometry_honesty[0]
                .cleared_fields
                .iter()
                .any(|f| matches!(f, psdx::ClearedTextGeometryField::Top))
        );
    }
    let layer = layer_at(&psd, &[0, 0]);
    let has_pixels =
        layer.image_data.is_some() || layer.canvas.is_some() || layer.raw_data.is_some();
    let bounds_absent = layer.left.is_none()
        && layer.top.is_none()
        && layer.right.is_none()
        && layer.bottom.is_none();
    assert!(
        !(has_pixels && bounds_absent),
        "point-text Leave edit left pixels with all four layer bounds absent"
    );
}

#[test]
fn export_plan_consistent_when_text_layer_has_no_geometry() {
    let mut psd = point_text_group_psd();
    {
        let layer = &mut psd.children.as_mut().unwrap()[0].children.as_mut().unwrap()[0];
        layer.left = None;
        layer.top = None;
        layer.right = None;
        layer.bottom = None;
    }
    // Anchor still contributes → group is exportable; the geometry-less text
    // layer must not enlarge the rect toward the origin.
    let plan = plan_top_level_groups(&psd, None);
    assert_eq!(plan.groups.len(), 1);
    assert!(
        plan.groups[0].bounds.left >= 56,
        "geometry-less layer must not pull group bounds to the origin, got {:?}",
        plan.groups[0].bounds
    );
    let result = export_groups(&psd, &off_options()).expect("export");
    assert!(
        result
            .warnings
            .iter()
            .any(|w| w.contains("missing geometry")),
        "expected missing-geometry warning, got {:?}",
        result.warnings
    );
}

#[test]
fn box_text_leave_keeps_raster_and_bounds() {
    let mut psd = box_text_group_psd();
    let before = {
        let layer = layer_at(&psd, &[0, 0]);
        (
            layer.left,
            layer.top,
            layer.right,
            layer.bottom,
            layer.image_data.as_ref().map(|p| p.data.clone()),
        )
    };
    {
        let mut session =
            TextEdit::begin(&mut psd, RasterPolicy::Leave, FontResolution::Resolved).unwrap();
        session
            .layer_at(&[0, 0])
            .unwrap()
            .set_text("edited box")
            .unwrap();
        let report = session.finish();
        assert!(report.geometry_honesty[0].cleared_fields.is_empty());
    }
    let layer = layer_at(&psd, &[0, 0]);
    assert_eq!(
        (layer.left, layer.top, layer.right, layer.bottom),
        (before.0, before.1, before.2, before.3)
    );
    assert_eq!(
        layer.image_data.as_ref().map(|p| &p.data),
        before.4.as_ref()
    );
}

#[test]
fn point_text_drop_keeps_transparent_preview_at_bounds() {
    let mut psd = point_text_group_psd();
    let bounds_before = {
        let layer = layer_at(&psd, &[0, 0]);
        (layer.left, layer.top, layer.right, layer.bottom)
    };
    {
        let mut session =
            TextEdit::begin(&mut psd, RasterPolicy::Drop, FontResolution::Resolved).unwrap();
        session
            .layer_at(&[0, 0])
            .unwrap()
            .set_text("dropped")
            .unwrap();
        let _ = session.finish();
    }
    let layer = layer_at(&psd, &[0, 0]);
    assert_eq!(
        (layer.left, layer.top, layer.right, layer.bottom),
        bounds_before,
        "Drop must keep layer document bounds"
    );
    let img = layer
        .image_data
        .as_ref()
        .expect("Drop installs transparent preview");
    assert!(img.data.chunks_exact(4).all(|px| px[3] == 0));
    let text = layer.additional_info.text.as_ref().unwrap();
    assert!(text.top.is_none());
    assert!(text.point_base.is_some());
}

#[test]
fn point_text_provide_keeps_pixels_at_layer_bounds() {
    let mut psd = point_text_group_psd();
    let provided = opaque(8, 8, [0, 0, 255, 255]);
    let bounds_before = {
        let layer = layer_at(&psd, &[0, 0]);
        (layer.left, layer.top, layer.right, layer.bottom)
    };
    {
        let mut session = TextEdit::begin(
            &mut psd,
            RasterPolicy::Provide(provided.clone()),
            FontResolution::Resolved,
        )
        .unwrap();
        session
            .layer_at(&[0, 0])
            .unwrap()
            .set_text("provided")
            .unwrap();
        let _ = session.finish();
    }
    let layer = layer_at(&psd, &[0, 0]);
    assert_eq!(
        (layer.left, layer.top, layer.right, layer.bottom),
        bounds_before
    );
    let img = layer.image_data.as_ref().expect("Provide pixels");
    assert_eq!(img.data, provided.data);
    let text = layer.additional_info.text.as_ref().unwrap();
    assert!(
        text.top.is_none(),
        "measurement honesty still clears text.top"
    );
}

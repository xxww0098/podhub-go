use super::*;
use crate::psd::TextPath;
use crate::psd::TextPathData;

fn point_text_psd(text: &str) -> Psd {
    let mut layer = Layer::default();
    layer.additional_info.name = Some("P".into());
    layer.left = Some(36.0);
    layer.top = Some(45.0);
    layer.right = Some(96.0);
    layer.bottom = Some(66.0);
    layer.additional_info.text = Some(LayerTextData {
        text: text.into(),
        shape_type: Some(TextShapeType::Point),
        top: Some(0.0),
        left: Some(0.0),
        bottom: Some(0.0),
        right: Some(0.0),
        point_base: Some(vec![0.0, 0.0]),
        transform: Some(vec![1.0, 0.0, 0.0, 1.0, 36.0, 66.0]),
        style: Some(TextStyle::default()),
        ..Default::default()
    });
    layer.image_data = Some(PixelData::rgba8(60, 21, vec![1; 60 * 21 * 4]));

    Psd {
        width: 100.0,
        height: 100.0,
        color_mode: Some(ColorMode::Rgb),
        children: Some(vec![layer]),
        additional_info: {
            let mut info = crate::psd::LayerAdditionalInfo::default();
            info.engine_data = Some("AAAA".into());
            info
        },
        ..Default::default()
    }
}

fn missing_shape_psd(text: &str) -> Psd {
    let mut psd = box_text_psd(text);
    psd.children.as_mut().unwrap()[0]
        .additional_info
        .text
        .as_mut()
        .unwrap()
        .shape_type = None;
    psd
}

fn box_text_psd(text: &str) -> Psd {
    let mut layer = Layer::default();
    layer.additional_info.name = Some("T".into());
    layer.additional_info.text = Some(LayerTextData {
        text: text.into(),
        shape_type: Some(TextShapeType::Box),
        style: Some(TextStyle::default()),
        ..Default::default()
    });
    layer.top = Some(0.0);
    layer.left = Some(0.0);
    layer.bottom = Some(10.0);
    layer.right = Some(20.0);
    layer.image_data = Some(PixelData::rgba8(20, 10, vec![1; 20 * 10 * 4]));

    Psd {
        width: 20.0,
        height: 10.0,
        color_mode: Some(ColorMode::Rgb),
        children: Some(vec![layer]),
        additional_info: {
            let mut info = crate::psd::LayerAdditionalInfo::default();
            info.engine_data = Some("AAAA".into());
            info
        },
        ..Default::default()
    }
}

#[test]
fn set_text_point_clears_unrecomputable_geometry_and_reports() {
    let mut psd = point_text_psd("hi");
    {
        let mut session =
            TextEdit::begin(&mut psd, RasterPolicy::Leave, FontResolution::Resolved).unwrap();
        session.layer_at(&[0]).unwrap().set_text("yo").unwrap();
        let report = session.finish();
        assert_eq!(report.mutations, 1);
        assert_eq!(report.geometry_honesty.len(), 1);
        let entry = &report.geometry_honesty[0];
        assert_eq!(entry.shape_type, TextShapeType::Point);
        assert_eq!(entry.layer_path, vec![0]);
        assert!(
            entry
                .cleared_fields
                .contains(&ClearedTextGeometryField::Top)
        );
        assert!(
            entry
                .cleared_fields
                .contains(&ClearedTextGeometryField::LayerLeft)
        );
    }
    let layer = &psd.children.as_ref().unwrap()[0];
    let text = layer.additional_info.text.as_ref().unwrap();
    assert_eq!(text.text, "yo");
    assert!(text.top.is_none());
    assert!(text.point_base.is_some());
    assert!(text.transform.is_some());
    assert!(layer.left.is_none());
    assert!(
        layer.image_data.is_none() && layer.canvas.is_none() && layer.raw_data.is_none(),
        "Leave must drop the stale raster when layer bounds are cleared"
    );
}

#[test]
fn set_text_box_preserves_box_geometry() {
    let mut psd = box_text_psd("hi");
    psd.children.as_mut().unwrap()[0]
        .additional_info
        .text
        .as_mut()
        .unwrap()
        .box_bounds = Some(vec![0.0, 0.0, 128.0, 49.0]);
    let before = psd.children.as_ref().unwrap()[0]
        .additional_info
        .text
        .as_ref()
        .unwrap()
        .box_bounds
        .clone();
    let xf_before = psd.children.as_ref().unwrap()[0]
        .additional_info
        .text
        .as_ref()
        .unwrap()
        .transform
        .clone();
    {
        let mut session =
            TextEdit::begin(&mut psd, RasterPolicy::Leave, FontResolution::Resolved).unwrap();
        session.layer_at(&[0]).unwrap().set_text("yo").unwrap();
        let report = session.finish();
        assert_eq!(report.geometry_honesty.len(), 1);
        assert_eq!(report.geometry_honesty[0].shape_type, TextShapeType::Box);
        assert!(report.geometry_honesty[0].cleared_fields.is_empty());
    }
    let text = psd.children.as_ref().unwrap()[0]
        .additional_info
        .text
        .as_ref()
        .unwrap();
    assert_eq!(text.box_bounds, before);
    assert_eq!(text.transform, xf_before);
    assert_eq!(text.top, None);
}

#[test]
fn set_text_rejects_missing_shape_type() {
    let mut psd = missing_shape_psd("hi");
    let mut session =
        TextEdit::begin(&mut psd, RasterPolicy::Leave, FontResolution::Resolved).unwrap();
    let err = session.layer_at(&[0]).unwrap().set_text("yo").unwrap_err();
    assert_eq!(err, TextEditError::MissingShapeType);
}

#[test]
fn begin_rejects_unresolved_fonts() {
    let mut psd = box_text_psd("hi");
    let err = match TextEdit::begin(&mut psd, RasterPolicy::Leave, FontResolution::Unresolved) {
        Ok(_) => panic!("unresolved fonts must fail begin"),
        Err(e) => e,
    };
    assert_eq!(err, TextEditError::FontsNotResolved);
}

#[test]
fn begin_rejects_path_text() {
    let mut psd = box_text_psd("hi");
    let layer = &mut psd.children.as_mut().unwrap()[0];
    let text = layer.additional_info.text.as_mut().unwrap();
    text.text_path = Some(TextPath {
        data: TextPathData {
            path_type: Some(2.0),
            ..Default::default()
        },
        ..Default::default()
    });
    let err = match TextEdit::begin(&mut psd, RasterPolicy::Leave, FontResolution::Resolved) {
        Ok(_) => panic!("path text must fail begin"),
        Err(e) => e,
    };
    assert_eq!(err, TextEditError::PathTextPresent);
}

#[test]
fn successful_mutation_normalizes_empty_style_run_list() {
    let mut psd = box_text_psd("hi");
    {
        let layer = &mut psd.children.as_mut().unwrap()[0];
        let text = layer.additional_info.text.as_mut().unwrap();
        text.style_runs = Some(vec![]);
    }
    {
        let mut session =
            TextEdit::begin(&mut psd, RasterPolicy::Leave, FontResolution::Resolved).unwrap();
        session.layer_at(&[0]).unwrap().set_font_size(24.0).unwrap();
        let _ = session.finish();
    }
    let text = psd.children.as_ref().unwrap()[0]
        .additional_info
        .text
        .as_ref()
        .unwrap();
    assert!(text.style_runs.is_none());
}

#[test]
fn set_text_noop_preserves_engine_data() {
    let mut psd = box_text_psd("hi");
    {
        let mut session =
            TextEdit::begin(&mut psd, RasterPolicy::Leave, FontResolution::Resolved).unwrap();
        session.layer_at(&[0]).unwrap().set_text("hi").unwrap();
        let report = session.finish();
        assert_eq!(report.mutations, 0);
        assert!(!report.doc_text_blob_dropped);
    }
    assert!(psd.additional_info.engine_data.is_some());
}

#[test]
fn set_text_drops_engine_data_and_collapses_runs() {
    let mut psd = box_text_psd("hi");
    {
        let layer = &mut psd.children.as_mut().unwrap()[0];
        let text = layer.additional_info.text.as_mut().unwrap();
        text.style_runs = Some(vec![crate::psd::TextStyleRun {
            length: 2.0,
            style: TextStyle::default(),
        }]);
    }
    {
        let mut session =
            TextEdit::begin(&mut psd, RasterPolicy::Leave, FontResolution::Resolved).unwrap();
        session.layer_at(&[0]).unwrap().set_text("yo").unwrap();
        let report = session.finish();
        assert_eq!(report.mutations, 1);
        assert!(report.doc_text_blob_dropped);
    }
    assert!(psd.additional_info.engine_data.is_none());
    let text = psd.children.as_ref().unwrap()[0]
        .additional_info
        .text
        .as_ref()
        .unwrap();
    assert_eq!(text.text, "yo");
    assert!(text.style_runs.is_none());
}

#[test]
fn raster_drop_clears_pixels_keeps_bounds() {
    let mut psd = box_text_psd("hi");
    {
        let mut session =
            TextEdit::begin(&mut psd, RasterPolicy::Drop, FontResolution::Resolved).unwrap();
        session.layer_at(&[0]).unwrap().set_text("yo").unwrap();
        let _ = session.finish();
    }
    let layer = &psd.children.as_ref().unwrap()[0];
    assert_eq!(
        (layer.left, layer.top, layer.right, layer.bottom),
        (Some(0.0), Some(0.0), Some(20.0), Some(10.0))
    );
    let img = layer.image_data.as_ref().unwrap();
    assert!(img.data.iter().all(|&b| b == 0));
}

fn two_run_box_psd(text: &str, len0: f64, len1: f64) -> Psd {
    let mut psd = box_text_psd(text);
    let layer = &mut psd.children.as_mut().unwrap()[0];
    let t = layer.additional_info.text.as_mut().unwrap();
    t.style_runs = Some(vec![
        crate::psd::TextStyleRun {
            length: len0,
            style: TextStyle {
                faux_bold: Some(true),
                ..Default::default()
            },
        },
        crate::psd::TextStyleRun {
            length: len1,
            style: TextStyle {
                faux_italic: Some(true),
                ..Default::default()
            },
        },
    ]);
    psd
}

#[test]
fn set_text_reflow_extends_last_run_immediately() {
    let mut psd = two_run_box_psd("Hello", 2.0, 3.0);
    {
        let mut session =
            TextEdit::begin(&mut psd, RasterPolicy::Leave, FontResolution::Resolved).unwrap();
        session
            .layer_at(&[0])
            .unwrap()
            .set_text_reflow("Hello!!!")
            .unwrap();
        let _ = session.finish();
    }
    let text = psd.children.as_ref().unwrap()[0]
        .additional_info
        .text
        .as_ref()
        .unwrap();
    assert_eq!(text.text, "Hello!!!");
    let runs = text.style_runs.as_ref().unwrap();
    assert_eq!(runs.len(), 2);
    assert_eq!(runs::length_units(runs[0].length), 2);
    assert_eq!(runs::length_units(runs[1].length), 6);
    assert_eq!(runs[0].style.faux_bold, Some(true));
    assert_eq!(runs[1].style.faux_italic, Some(true));
    assert_eq!(
        runs::style_run_lengths_sum(runs),
        runs::utf16_len(&text.text)
    );
}

#[test]
fn set_text_reflow_drops_oob_runs() {
    let mut psd = two_run_box_psd("Hello", 2.0, 3.0);
    {
        let mut session =
            TextEdit::begin(&mut psd, RasterPolicy::Leave, FontResolution::Resolved).unwrap();
        session
            .layer_at(&[0])
            .unwrap()
            .set_text_reflow("Hi")
            .unwrap();
        let _ = session.finish();
    }
    let text = psd.children.as_ref().unwrap()[0]
        .additional_info
        .text
        .as_ref()
        .unwrap();
    let runs = text.style_runs.as_ref().unwrap();
    assert_eq!(runs.len(), 1);
    assert_eq!(runs::length_units(runs[0].length), 2);
    assert_eq!(runs[0].style.faux_bold, Some(true));
    assert_eq!(
        runs::style_run_lengths_sum(runs),
        runs::utf16_len(&text.text)
    );
}

#[test]
fn set_text_reflow_counts_emoji_utf16() {
    let mut psd = two_run_box_psd("Hi", 1.0, 1.0);
    {
        let mut session =
            TextEdit::begin(&mut psd, RasterPolicy::Leave, FontResolution::Resolved).unwrap();
        session
            .layer_at(&[0])
            .unwrap()
            .set_text_reflow("H😀")
            .unwrap();
        let _ = session.finish();
    }
    let text = psd.children.as_ref().unwrap()[0]
        .additional_info
        .text
        .as_ref()
        .unwrap();
    assert_eq!(runs::utf16_len(&text.text), 3);
    let runs = text.style_runs.as_ref().unwrap();
    assert_eq!(runs::length_units(runs[0].length), 1);
    assert_eq!(runs::length_units(runs[1].length), 2);
    assert_eq!(runs::style_run_lengths_sum(runs), 3);
}

#[test]
fn set_run_text_only_touches_target_run() {
    let mut psd = two_run_box_psd("Hello", 2.0, 3.0);
    let other_before = {
        let runs = psd.children.as_ref().unwrap()[0]
            .additional_info
            .text
            .as_ref()
            .unwrap()
            .style_runs
            .as_ref()
            .unwrap();
        (runs[1].length, runs[1].style.faux_italic)
    };
    {
        let mut session =
            TextEdit::begin(&mut psd, RasterPolicy::Leave, FontResolution::Resolved).unwrap();
        session
            .layer_at(&[0])
            .unwrap()
            .set_run_text(0, "YYYY")
            .unwrap();
        let _ = session.finish();
    }
    let text = psd.children.as_ref().unwrap()[0]
        .additional_info
        .text
        .as_ref()
        .unwrap();
    assert_eq!(text.text, "YYYYllo");
    let runs = text.style_runs.as_ref().unwrap();
    assert_eq!(runs::length_units(runs[0].length), 4);
    assert_eq!(runs[0].style.faux_bold, Some(true));
    assert_eq!(runs[1].length, other_before.0);
    assert_eq!(runs[1].style.faux_italic, other_before.1);
    assert_eq!(
        runs::style_run_lengths_sum(runs),
        runs::utf16_len(&text.text)
    );
}

#[test]
fn set_run_text_noop_preserves_engine_data() {
    let mut psd = two_run_box_psd("Hello", 2.0, 3.0);
    {
        let mut session =
            TextEdit::begin(&mut psd, RasterPolicy::Leave, FontResolution::Resolved).unwrap();
        session
            .layer_at(&[0])
            .unwrap()
            .set_run_text(0, "He")
            .unwrap();
        let report = session.finish();
        assert_eq!(report.mutations, 0);
        assert!(!report.doc_text_blob_dropped);
    }
    assert!(psd.additional_info.engine_data.is_some());
}

#[test]
fn set_text_reflow_noop_preserves_engine_data() {
    let mut psd = two_run_box_psd("Hello", 2.0, 3.0);
    {
        let mut session =
            TextEdit::begin(&mut psd, RasterPolicy::Leave, FontResolution::Resolved).unwrap();
        session
            .layer_at(&[0])
            .unwrap()
            .set_text_reflow("Hello")
            .unwrap();
        let report = session.finish();
        assert_eq!(report.mutations, 0);
        assert!(!report.doc_text_blob_dropped);
    }
    assert!(psd.additional_info.engine_data.is_some());
}

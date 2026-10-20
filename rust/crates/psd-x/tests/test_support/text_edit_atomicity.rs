//! Atomic text-string mutation regressions.
//!
//! Tests cross only the existing `TextEdit` session seams. A deliberately
//! malformed raw mask channel makes `RasterPolicy::Drop` fail late, during
//! raster preparation; the edit must still leave the document untouched.

#![cfg(feature = "serde")]

use psdx::test_corpus;
use std::fs;
use std::path::PathBuf;

use psdx::psd::{
    ChannelId, Color, ColorMode, Compression, Font, Layer, LayerRawData, LayerRawDataChannel,
    ReadOptions, Rgb, TextShapeType, TextStyle, TextStyleRun, Units, UnitsBounds, UnitsValue,
    WriteOptions,
};
use psdx::{
    FontResolution, RasterPolicy, TextEdit, TextEditError, TextEditReport, read_psd, write_psd,
};

fn fixture_src(kind: &str, name: &str) -> Option<PathBuf> {
    let dir = test_corpus::corpus_root().join(kind).join(name);
    ["src.psd", "src.psb"]
        .into_iter()
        .map(|name| dir.join(name))
        .find(|path| path.is_file())
}

fn read_opts() -> ReadOptions {
    ReadOptions {
        use_image_data: Some(true),
        skip_thumbnail: Some(true),
        resolve_inherited_fonts: Some(true),
        ..ReadOptions::default()
    }
}

fn layer_at_mut<'a>(layers: &'a mut [Layer], path: &[usize]) -> &'a mut Layer {
    match path {
        [index] => &mut layers[*index],
        [index, rest @ ..] => {
            let children = layers[*index].children.as_mut().expect("nested children");
            layer_at_mut(children, rest)
        }
        [] => panic!("empty layer path"),
    }
}

fn layer_at<'a>(layers: &'a [Layer], path: &[usize]) -> &'a Layer {
    match path {
        [index] => &layers[*index],
        [index, rest @ ..] => {
            let children = layers[*index].children.as_ref().expect("nested children");
            layer_at(children, rest)
        }
        [] => panic!("empty layer path"),
    }
}

fn first_box_text_path(psd: &psdx::psd::Psd) -> Option<Vec<usize>> {
    fn walk(layers: &[Layer], prefix: &mut Vec<usize>) -> Option<Vec<usize>> {
        for (index, layer) in layers.iter().enumerate() {
            prefix.push(index);
            if layer
                .additional_info
                .text
                .as_ref()
                .is_some_and(|text| text.shape_type == Some(psdx::psd::TextShapeType::Box))
            {
                return Some(prefix.clone());
            }
            if let Some(children) = layer.children.as_ref() {
                if let Some(path) = walk(children, prefix) {
                    return Some(path);
                }
            }
            prefix.pop();
        }
        None
    }

    psd.children
        .as_ref()
        .and_then(|layers| walk(layers, &mut Vec::new()))
}

fn inject_late_raster_failure(psd: &mut psdx::psd::Psd, path: &[usize]) {
    let layer = layer_at_mut(psd.children.as_mut().expect("children"), path);
    inject_late_raster_failure_on_layer(layer);
}

fn ensure_two_runs(psd: &mut psdx::psd::Psd, path: &[usize]) {
    let text = layer_at_mut(psd.children.as_mut().expect("children"), path)
        .additional_info
        .text
        .as_mut()
        .expect("text");
    let len = text.text.encode_utf16().count();
    let first = (len / 2).max(1).min(len);
    let second = len.saturating_sub(first);
    text.style_runs = Some(vec![
        TextStyleRun {
            length: first as f64,
            style: TextStyle {
                faux_bold: Some(true),
                ..Default::default()
            },
        },
        TextStyleRun {
            length: second as f64,
            style: TextStyle {
                faux_italic: Some(true),
                ..Default::default()
            },
        },
    ]);
}

fn point_text_psd() -> psdx::psd::Psd {
    let mut layer = Layer {
        top: Some(20.0),
        left: Some(10.0),
        bottom: Some(40.0),
        right: Some(30.0),
        ..Layer::default()
    };
    layer.additional_info.text = Some(psdx::psd::LayerTextData {
        text: "point".into(),
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
        point_base: Some(vec![0.0, 0.0]),
        transform: Some(vec![1.0, 0.0, 0.0, 1.0, 10.0, 20.0]),
        style: Some(TextStyle::default()),
        ..Default::default()
    });
    inject_late_raster_failure_on_layer(&mut layer);

    let mut additional_info = psdx::psd::LayerAdditionalInfo::default();
    additional_info.engine_data = Some("AAAA".into());
    psdx::psd::Psd {
        width: 100.0,
        height: 100.0,
        bits_per_channel: Some(8.0),
        color_mode: Some(ColorMode::Rgb),
        children: Some(vec![layer]),
        additional_info,
        ..Default::default()
    }
}

fn inject_late_raster_failure_on_layer(layer: &mut Layer) {
    layer.raw_data = Some(LayerRawData {
        color_mode: ColorMode::Rgb,
        bits_per_channel: 8.0,
        large: false,
        channels: vec![LayerRawDataChannel {
            id: ChannelId::UserMask as i16,
            compression: Compression::RawData,
            data: Some(vec![0, 0, 0, 0]),
        }],
    });
    assert!(
        layer.additional_info.mask.is_none(),
        "missing mask metadata is the intended materialization failure"
    );
}

fn snapshot(psd: &psdx::psd::Psd) -> (serde_json::Value, Vec<u8>) {
    (
        serde_json::to_value(psd).expect("structural snapshot"),
        write_psd(psd, &WriteOptions::default()).expect("write snapshot"),
    )
}

fn sample_font(name: &str) -> Font {
    Font {
        name: name.into(),
        script: Some(0.0),
        font_type: Some(0.0),
        synthetic: Some(0.0),
    }
}

fn empty_run_box_psd() -> psdx::psd::Psd {
    let mut layer = Layer {
        top: Some(2.0),
        left: Some(3.0),
        bottom: Some(6.0),
        right: Some(9.0),
        image_data: Some(psdx::psd::PixelData::rgba8(6, 4, vec![0x7a; 6 * 4 * 4])),
        ..Layer::default()
    };
    layer.additional_info.text = Some(psdx::psd::LayerTextData {
        text: "empty runs".into(),
        shape_type: Some(TextShapeType::Box),
        style: Some(TextStyle {
            font_size: Some(12.0),
            ..TextStyle::default()
        }),
        style_runs: Some(vec![]),
        paragraph_style_runs: Some(vec![]),
        ..Default::default()
    });

    psdx::psd::Psd {
        width: 20.0,
        height: 10.0,
        bits_per_channel: Some(8.0),
        color_mode: Some(ColorMode::Rgb),
        children: Some(vec![layer]),
        ..Default::default()
    }
}

#[derive(Clone, Copy, Debug)]
enum StringMutation {
    SetText,
    SetTextReflow,
    SetRunText,
}

#[derive(Clone, Copy, Debug)]
enum StyleMutation {
    SetFont,
    SetFontSize,
    SetFillColor,
}

fn attempt(
    psd: &mut psdx::psd::Psd,
    path: &[usize],
    mutation: StringMutation,
) -> (TextEditError, TextEditReport) {
    let mut session =
        TextEdit::begin(psd, RasterPolicy::Drop, FontResolution::Resolved).expect("begin");
    let error = {
        let mut layer = session.layer_at(path).expect("layer");
        match mutation {
            StringMutation::SetText => layer.set_text("atomic set_text failure"),
            StringMutation::SetTextReflow => {
                layer.set_text_reflow("atomic set_text_reflow failure")
            }
            StringMutation::SetRunText => layer.set_run_text(0, "atomic run"),
        }
        .expect_err("raster materialization must fail")
    };
    (error, session.finish())
}

fn attempt_style(
    psd: &mut psdx::psd::Psd,
    path: &[usize],
    mutation: StyleMutation,
) -> (TextEditError, TextEditReport) {
    let mut session =
        TextEdit::begin(psd, RasterPolicy::Drop, FontResolution::Resolved).expect("begin");
    let error = {
        let mut layer = session.layer_at(path).expect("layer");
        match mutation {
            StyleMutation::SetFont => layer.set_font(sample_font("atomic failure font")),
            StyleMutation::SetFontSize => layer.set_font_size(73.0),
            StyleMutation::SetFillColor => layer.set_fill_color(Color::Rgb(Rgb {
                r: 12.0,
                g: 34.0,
                b: 56.0,
            })),
        }
        .expect_err("raster materialization must fail")
    };
    (error, session.finish())
}

#[test]
fn every_string_mutation_is_structurally_and_byte_atomic_on_late_raster_failure() {
    let Some(src) = fixture_src("read-write", "text-box") else {
        eprintln!("skip: read-write/text-box missing");
        return;
    };
    let bytes = fs::read(src).expect("read fixture");

    for mutation in [
        StringMutation::SetText,
        StringMutation::SetTextReflow,
        StringMutation::SetRunText,
    ] {
        let mut psd = read_psd(&bytes, &read_opts()).expect("read");
        let path = first_box_text_path(&psd).expect("box text");
        if matches!(mutation, StringMutation::SetRunText) {
            ensure_two_runs(&mut psd, &path);
        }
        inject_late_raster_failure(&mut psd, &path);
        let before = snapshot(&psd);

        let (error, report) = attempt(&mut psd, &path, mutation);

        assert!(
            matches!(error, TextEditError::Raster(_)),
            "{mutation:?} must preserve the raster error category"
        );
        assert_eq!(
            serde_json::to_value(&psd).expect("after structure"),
            before.0,
            "{mutation:?} changed document structure on error"
        );
        assert_eq!(
            write_psd(&psd, &WriteOptions::default()).expect("write after"),
            before.1,
            "{mutation:?} caused write-byte drift on error"
        );
        assert_eq!(report.mutations, 0, "{mutation:?} counted a failed edit");
        assert!(!report.doc_text_blob_dropped);
        assert!(report.geometry_honesty.is_empty());
    }
}

#[test]
fn every_style_mutation_is_structurally_and_byte_atomic_on_late_raster_failure() {
    let Some(src) = fixture_src("read-write", "text-box") else {
        eprintln!("skip: read-write/text-box missing");
        return;
    };
    let bytes = fs::read(src).expect("read fixture");

    for mutation in [
        StyleMutation::SetFont,
        StyleMutation::SetFontSize,
        StyleMutation::SetFillColor,
    ] {
        let mut psd = read_psd(&bytes, &read_opts()).expect("read");
        let path = first_box_text_path(&psd).expect("box text");
        inject_late_raster_failure(&mut psd, &path);
        let before = snapshot(&psd);

        let (error, report) = attempt_style(&mut psd, &path, mutation);

        assert!(
            matches!(error, TextEditError::Raster(_)),
            "{mutation:?} must preserve the raster error category"
        );
        assert_eq!(
            serde_json::to_value(&psd).expect("after structure"),
            before.0,
            "{mutation:?} changed document structure on error"
        );
        assert_eq!(
            write_psd(&psd, &WriteOptions::default()).expect("write after"),
            before.1,
            "{mutation:?} caused write-byte drift on error"
        );
        assert_eq!(report, TextEditReport::default());
    }
}

#[test]
fn noop_style_mutation_skips_failing_raster_preparation() {
    let Some(src) = fixture_src("read-write", "text-box") else {
        eprintln!("skip: read-write/text-box missing");
        return;
    };
    let bytes = fs::read(src).expect("read fixture");
    let mut psd = read_psd(&bytes, &read_opts()).expect("read");
    let path = first_box_text_path(&psd).expect("box text");
    let current_size = layer_at(psd.children.as_ref().unwrap(), &path)
        .additional_info
        .text
        .as_ref()
        .and_then(|text| text.style.as_ref())
        .and_then(|style| style.font_size)
        .expect("base font size");
    inject_late_raster_failure(&mut psd, &path);
    let before = snapshot(&psd);

    let report = {
        let mut session =
            TextEdit::begin(&mut psd, RasterPolicy::Drop, FontResolution::Resolved).expect("begin");
        session
            .layer_at(&path)
            .expect("layer")
            .set_font_size(current_size)
            .expect("no-op must not prepare raster");
        session.finish()
    };

    assert_eq!(report, TextEditReport::default());
    assert_eq!(serde_json::to_value(&psd).unwrap(), before.0);
    assert_eq!(write_psd(&psd, &WriteOptions::default()).unwrap(), before.1);
}

#[test]
fn begin_finish_and_noop_preserve_empty_run_structure_and_bytes() {
    for perform_noop in [false, true] {
        let mut psd = empty_run_box_psd();
        let before = snapshot(&psd);

        let report = {
            let mut session =
                TextEdit::begin(&mut psd, RasterPolicy::Drop, FontResolution::Resolved)
                    .expect("begin");
            if perform_noop {
                session
                    .layer_at(&[0])
                    .expect("text layer")
                    .set_font_size(12.0)
                    .expect("no-op");
            }
            session.finish()
        };

        assert_eq!(report, TextEditReport::default());
        assert_eq!(
            serde_json::to_value(&psd).expect("structure after"),
            before.0,
            "begin/finish and no-op must not normalize empty run lists"
        );
        assert_eq!(
            write_psd(&psd, &WriteOptions::default()).expect("bytes after"),
            before.1,
            "begin/finish and no-op must be byte-identical"
        );
    }
}

#[test]
fn text_and_style_mutations_survive_drop_and_provide_raster_policies() {
    for raster in [
        RasterPolicy::Drop,
        RasterPolicy::Provide(psdx::psd::PixelData::rgba8(3, 2, vec![0x4c; 3 * 2 * 4])),
    ] {
        let mut psd = empty_run_box_psd();
        {
            let mut session =
                TextEdit::begin(&mut psd, raster, FontResolution::Resolved).expect("begin");
            let mut layer = session.layer_at(&[0]).expect("text layer");
            layer.set_text("preview-safe text").expect("set text");
            layer.set_font_size(37.0).expect("set font size");
            assert_eq!(session.finish().mutations, 2);
        }

        let layer = &psd.children.as_ref().unwrap()[0];
        let text = layer.additional_info.text.as_ref().expect("text remains");
        assert_eq!(text.text, "preview-safe text");
        assert_eq!(
            text.style.as_ref().and_then(|style| style.font_size),
            Some(37.0),
            "style mutation must remain after preview apply"
        );
        assert!(
            layer
                .image_data
                .as_ref()
                .is_some_and(|pixels| !pixels.data.is_empty()),
            "selected raster policy must still install preview pixels"
        );
    }
}

#[test]
fn earlier_success_remains_when_later_style_mutation_fails_in_same_session() {
    let Some(src) = fixture_src("read", "alias") else {
        eprintln!("skip: read/alias missing");
        return;
    };
    let bytes = fs::read(src).expect("read fixture");
    let base = read_psd(&bytes, &read_opts()).expect("read");
    let successful_path = vec![1];
    let failing_path = vec![2];

    let run = |attempt_failure: bool| {
        let mut psd = base.clone();
        inject_late_raster_failure(&mut psd, &failing_path);
        let report = {
            let mut session =
                TextEdit::begin(&mut psd, RasterPolicy::Drop, FontResolution::Resolved)
                    .expect("begin");
            session
                .layer_at(&successful_path)
                .expect("first layer")
                .set_text("successful earlier edit")
                .expect("first mutation");
            if attempt_failure {
                let error = session
                    .layer_at(&failing_path)
                    .expect("second layer")
                    .set_font(sample_font("failed later font"))
                    .expect_err("second mutation must fail");
                assert!(matches!(error, TextEditError::Raster(_)));
            }
            session.finish()
        };
        (psd, report)
    };

    let (expected, expected_report) = run(false);
    let (actual, actual_report) = run(true);

    assert_eq!(
        serde_json::to_value(&actual).expect("actual structure"),
        serde_json::to_value(&expected).expect("expected structure"),
        "failed later style mutation must add no observable state"
    );
    assert_eq!(
        write_psd(&actual, &WriteOptions::default()).expect("actual bytes"),
        write_psd(&expected, &WriteOptions::default()).expect("expected bytes")
    );
    assert_eq!(actual_report, expected_report);
    assert_eq!(actual_report.mutations, 1);
    assert!(actual_report.doc_text_blob_dropped);
}

#[test]
fn earlier_success_remains_when_later_mutation_fails_in_same_session() {
    let Some(src) = fixture_src("read", "alias") else {
        eprintln!("skip: read/alias missing");
        return;
    };
    let bytes = fs::read(src).expect("read fixture");
    let base = read_psd(&bytes, &read_opts()).expect("read");
    let successful_path = vec![1];
    let failing_path = vec![2];
    assert!(
        layer_at(base.children.as_ref().unwrap(), &successful_path)
            .additional_info
            .text
            .is_some()
    );
    assert!(
        layer_at(base.children.as_ref().unwrap(), &failing_path)
            .additional_info
            .text
            .is_some()
    );

    let run = |attempt_failure: bool| {
        let mut psd = base.clone();
        inject_late_raster_failure(&mut psd, &failing_path);
        let report = {
            let mut session =
                TextEdit::begin(&mut psd, RasterPolicy::Drop, FontResolution::Resolved)
                    .expect("begin");
            session
                .layer_at(&successful_path)
                .expect("first layer")
                .set_text("successful earlier edit")
                .expect("first mutation");
            if attempt_failure {
                let error = session
                    .layer_at(&failing_path)
                    .expect("second layer")
                    .set_text_reflow("failed later edit")
                    .expect_err("second mutation must fail");
                assert!(matches!(error, TextEditError::Raster(_)));
            }
            session.finish()
        };
        (psd, report)
    };

    let (expected, expected_report) = run(false);
    let (actual, actual_report) = run(true);

    assert_eq!(
        serde_json::to_value(&actual).expect("actual structure"),
        serde_json::to_value(&expected).expect("expected structure"),
        "failed later mutation must add no observable state"
    );
    assert_eq!(
        write_psd(&actual, &WriteOptions::default()).expect("actual bytes"),
        write_psd(&expected, &WriteOptions::default()).expect("expected bytes")
    );
    assert_eq!(actual_report, expected_report);
    assert_eq!(actual_report.mutations, 1);
    assert!(actual_report.doc_text_blob_dropped);
}

#[test]
fn point_text_geometry_is_atomic_on_late_raster_failure() {
    let mut psd = point_text_psd();
    let before = snapshot(&psd);

    let mut session =
        TextEdit::begin(&mut psd, RasterPolicy::Drop, FontResolution::Resolved).expect("begin");
    let error = session
        .layer_at(&[0])
        .expect("point layer")
        .set_text("changed point")
        .expect_err("raster materialization must fail");

    assert!(matches!(error, TextEditError::Raster(_)));
    assert_eq!(session.finish(), TextEditReport::default());
    assert_eq!(serde_json::to_value(&psd).unwrap(), before.0);
    assert_eq!(write_psd(&psd, &WriteOptions::default()).unwrap(), before.1);
}

#[test]
fn invalid_run_index_is_atomic_before_raster_preparation() {
    let Some(src) = fixture_src("read-write", "text-box") else {
        eprintln!("skip: read-write/text-box missing");
        return;
    };
    let bytes = fs::read(src).expect("read fixture");
    let mut psd = read_psd(&bytes, &read_opts()).expect("read");
    let path = first_box_text_path(&psd).expect("box text");
    ensure_two_runs(&mut psd, &path);
    inject_late_raster_failure(&mut psd, &path);
    let before = snapshot(&psd);

    let mut session =
        TextEdit::begin(&mut psd, RasterPolicy::Drop, FontResolution::Resolved).expect("begin");
    let error = session
        .layer_at(&path)
        .expect("layer")
        .set_run_text(99, "invalid")
        .expect_err("run index must fail");
    assert!(matches!(
        error,
        TextEditError::RunIndexOutOfBounds { index: 99, .. }
    ));
    assert_eq!(session.finish(), TextEditReport::default());

    assert_eq!(serde_json::to_value(&psd).unwrap(), before.0);
    assert_eq!(write_psd(&psd, &WriteOptions::default()).unwrap(), before.1);
}

#[test]
fn surrogate_splitting_run_range_fails_without_replacement_character_or_state_change() {
    let Some(src) = fixture_src("read-write", "text-box") else {
        eprintln!("skip: read-write/text-box missing");
        return;
    };
    let bytes = fs::read(src).expect("read fixture");
    let mut psd = read_psd(&bytes, &read_opts()).expect("read");
    let path = first_box_text_path(&psd).expect("box text");
    let text = layer_at_mut(psd.children.as_mut().unwrap(), &path)
        .additional_info
        .text
        .as_mut()
        .unwrap();
    text.text = "a😀b".into();
    text.style_runs = Some(vec![
        TextStyleRun {
            length: 2.0,
            style: TextStyle::default(),
        },
        TextStyleRun {
            length: 2.0,
            style: TextStyle::default(),
        },
    ]);
    inject_late_raster_failure(&mut psd, &path);
    let before = snapshot(&psd);

    let mut session =
        TextEdit::begin(&mut psd, RasterPolicy::Drop, FontResolution::Resolved).expect("begin");
    let error = session
        .layer_at(&path)
        .expect("layer")
        .set_run_text(0, "X")
        .expect_err("surrogate-splitting range must fail");
    assert_eq!(
        error,
        TextEditError::InvalidUtf16RunRange { start: 0, end: 2 }
    );
    assert_eq!(session.finish(), TextEditReport::default());
    assert_eq!(serde_json::to_value(&psd).unwrap(), before.0);
    assert_eq!(write_psd(&psd, &WriteOptions::default()).unwrap(), before.1);
}

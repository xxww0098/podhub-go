//! Point-text geometry honesty after string edits.

#![cfg(feature = "serde")]

use psdx::test_corpus;
use std::fs;
use std::path::PathBuf;

use psdx::psd::{Layer, ReadOptions, TextShapeType, WriteOptions};
use psdx::{
    ClearedTextGeometryField, FontResolution, RasterPolicy, TextEdit, TextEditError, read_psd,
    write_psd,
};

fn fixture_src(kind: &str, name: &str) -> Option<PathBuf> {
    let dir = test_corpus::corpus_root().join(kind).join(name);
    let psd = dir.join("src.psd");
    if psd.is_file() { Some(psd) } else { None }
}

fn read_opts_resolved() -> ReadOptions {
    ReadOptions {
        use_image_data: Some(true),
        skip_thumbnail: Some(true),
        resolve_inherited_fonts: Some(true),
        ..ReadOptions::default()
    }
}

fn first_text_path(psd: &psdx::psd::Psd, shape: TextShapeType) -> Option<Vec<usize>> {
    fn walk(layers: &[Layer], prefix: &mut Vec<usize>, shape: TextShapeType) -> Option<Vec<usize>> {
        for (i, layer) in layers.iter().enumerate() {
            prefix.push(i);
            if let Some(text) = layer.additional_info.text.as_ref() {
                if text.shape_type == Some(shape) {
                    return Some(prefix.clone());
                }
            }
            if let Some(children) = layer.children.as_ref() {
                if let Some(found) = walk(children, prefix, shape) {
                    return Some(found);
                }
            }
            prefix.pop();
        }
        None
    }
    psd.children
        .as_ref()
        .and_then(|c| walk(c, &mut Vec::new(), shape))
}

fn layer_at<'a>(psd: &'a psdx::psd::Psd, path: &[usize]) -> &'a Layer {
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

#[test]
fn point_text_edit_clears_measurement_fields() {
    let Some(src) = fixture_src("read-write", "text") else {
        eprintln!("skip: read-write/text missing");
        return;
    };
    let bytes = fs::read(&src).expect("read src");
    let mut psd = read_psd(&bytes, &read_opts_resolved()).expect("read");
    let path = first_text_path(&psd, TextShapeType::Point).expect("point text");
    let before_layer = layer_at(&psd, &path);
    assert!(before_layer.left.is_some());
    let before_text = before_layer.additional_info.text.as_ref().unwrap();
    assert_eq!(before_text.shape_type, Some(TextShapeType::Point));
    assert!(before_text.top.is_some());

    {
        let mut session =
            TextEdit::begin(&mut psd, RasterPolicy::Leave, FontResolution::Resolved).unwrap();
        session
            .layer_at(&path)
            .unwrap()
            .set_text("edited point text")
            .unwrap();
        let report = session.finish();
        assert_eq!(report.geometry_honesty.len(), 1);
        let entry = &report.geometry_honesty[0];
        assert_eq!(entry.shape_type, TextShapeType::Point);
        assert_eq!(entry.layer_path, path);
        assert!(!entry.cleared_fields.is_empty());
    }

    let layer = layer_at(&psd, &path);
    let text = layer.additional_info.text.as_ref().unwrap();
    assert_eq!(text.text, "edited point text");
    assert!(text.top.is_none());
    assert!(text.left.is_none());
    assert!(text.bottom.is_none());
    assert!(text.right.is_none());
    assert!(layer.left.is_none());
    assert!(text.point_base.is_some(), "anchor stays author-defined");
    assert!(text.transform.is_some(), "transform stays author-defined");
}

#[test]
fn box_text_edit_preserves_box_geometry() {
    let Some(src) = fixture_src("read-write", "text-box") else {
        eprintln!("skip: read-write/text-box missing");
        return;
    };
    let bytes = fs::read(&src).expect("read src");
    let mut psd = read_psd(&bytes, &read_opts_resolved()).expect("read");
    let path = first_text_path(&psd, TextShapeType::Box).expect("box text");
    let before = layer_at(&psd, &path);
    let before_text = before.additional_info.text.as_ref().unwrap();
    let box_bounds = before_text.box_bounds.clone();
    let transform = before_text.transform.clone();
    let text_rect = (
        before_text.top,
        before_text.left,
        before_text.bottom,
        before_text.right,
    );

    {
        let mut session =
            TextEdit::begin(&mut psd, RasterPolicy::Leave, FontResolution::Resolved).unwrap();
        session
            .layer_at(&path)
            .unwrap()
            .set_text("edited box text")
            .unwrap();
        let report = session.finish();
        assert_eq!(report.geometry_honesty.len(), 1);
        assert_eq!(report.geometry_honesty[0].shape_type, TextShapeType::Box);
        assert!(report.geometry_honesty[0].cleared_fields.is_empty());
    }

    let text = layer_at(&psd, &path).additional_info.text.as_ref().unwrap();
    assert_eq!(text.box_bounds, box_bounds);
    assert_eq!(text.transform, transform);
    assert_eq!((text.top, text.left, text.bottom, text.right), text_rect);
}

#[test]
fn point_text_reread_keeps_shape_type() {
    let Some(src) = fixture_src("read-write", "text") else {
        eprintln!("skip: read-write/text missing");
        return;
    };
    let bytes = fs::read(&src).expect("read src");
    let mut psd = read_psd(&bytes, &read_opts_resolved()).expect("read");
    let path = first_text_path(&psd, TextShapeType::Point).expect("point text");

    {
        let mut session =
            TextEdit::begin(&mut psd, RasterPolicy::Leave, FontResolution::Resolved).unwrap();
        session
            .layer_at(&path)
            .unwrap()
            .set_text("round trip")
            .unwrap();
        let _ = session.finish();
    }

    let out = write_psd(&psd, &WriteOptions::default()).expect("write");
    let reread = read_psd(&out, &read_opts_resolved()).expect("reread");
    let text = layer_at(&reread, &path)
        .additional_info
        .text
        .as_ref()
        .unwrap();
    assert_eq!(text.shape_type, Some(TextShapeType::Point));
    assert_eq!(text.text, "round trip");
}

#[test]
fn missing_shape_type_is_explicit_error() {
    let Some(src) = fixture_src("read-write", "text-box") else {
        eprintln!("skip: read-write/text-box missing");
        return;
    };
    let bytes = fs::read(&src).expect("read src");
    let mut psd = read_psd(&bytes, &read_opts_resolved()).expect("read");
    let path = first_text_path(&psd, TextShapeType::Box).expect("box text");
    psd.children.as_mut().unwrap()[path[0]]
        .additional_info
        .text
        .as_mut()
        .unwrap()
        .shape_type = None;

    let mut session =
        TextEdit::begin(&mut psd, RasterPolicy::Leave, FontResolution::Resolved).unwrap();
    let err = session
        .layer_at(&path)
        .unwrap()
        .set_text("nope")
        .unwrap_err();
    assert_eq!(err, TextEditError::MissingShapeType);
}

#[test]
fn set_text_reflow_point_reports_cleared_layer_bounds() {
    let Some(src) = fixture_src("read-write", "text") else {
        eprintln!("skip: read-write/text missing");
        return;
    };
    let bytes = fs::read(&src).expect("read src");
    let mut psd = read_psd(&bytes, &read_opts_resolved()).expect("read");
    let path = first_text_path(&psd, TextShapeType::Point).expect("point text");

    {
        let mut session =
            TextEdit::begin(&mut psd, RasterPolicy::Leave, FontResolution::Resolved).unwrap();
        session
            .layer_at(&path)
            .unwrap()
            .set_text_reflow("reflowed")
            .unwrap();
        let report = session.finish();
        let entry = &report.geometry_honesty[0];
        assert_eq!(entry.shape_type, TextShapeType::Point);
        assert!(
            entry
                .cleared_fields
                .iter()
                .any(|f| matches!(f, ClearedTextGeometryField::LayerLeft))
        );
    }
}

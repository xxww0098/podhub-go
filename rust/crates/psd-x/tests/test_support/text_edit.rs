//! Text edit session: `set_text`, `set_text_reflow`,
//! `set_run_text` (box text).
//!
//! Self-loop tests against read-write / read fixtures. Skip cleanly when the
//! ag-psd fixture corpus is absent.

#![cfg(feature = "serde")]

use psdx::test_corpus;
use std::fs;
use std::path::PathBuf;

use psdx::psd::{
    Layer, LayerTextData, PixelData, ReadOptions, TextStyle, TextStyleRun, WriteOptions,
};
use psdx::{FontResolution, RasterPolicy, TextEdit, TextEditError, read_psd, write_psd};

fn fixture_src(kind: &str, name: &str) -> Option<PathBuf> {
    let dir = test_corpus::corpus_root().join(kind).join(name);
    let psd = dir.join("src.psd");
    let psb = dir.join("src.psb");
    if psd.is_file() {
        Some(psd)
    } else if psb.is_file() {
        Some(psb)
    } else {
        None
    }
}

fn fixture_expected(kind: &str, name: &str) -> Option<PathBuf> {
    let dir = test_corpus::corpus_root().join(kind).join(name);
    let psd = dir.join("expected.psd");
    let psb = dir.join("expected.psb");
    if psd.is_file() {
        Some(psd)
    } else if psb.is_file() {
        Some(psb)
    } else {
        None
    }
}

fn read_opts_resolved() -> ReadOptions {
    ReadOptions {
        use_image_data: Some(true),
        skip_thumbnail: Some(true),
        resolve_inherited_fonts: Some(true),
        ..ReadOptions::default()
    }
}

fn read_opts_unresolved() -> ReadOptions {
    ReadOptions {
        use_image_data: Some(true),
        skip_thumbnail: Some(true),
        resolve_inherited_fonts: Some(false),
        ..ReadOptions::default()
    }
}

/// For no-op byte identity vs ag-psd `expected.psd`: upstream-oracle read
/// (`resolve_inherited_fonts: Some(false)`). Session still receives
/// [`FontResolution::Resolved`] as the caller's proof token.
fn read_opts_byte_oracle() -> ReadOptions {
    ReadOptions {
        use_image_data: Some(true),
        use_raw_thumbnail: Some(true),
        throw_for_missing_features: Some(true),
        resolve_inherited_fonts: Some(false),
        ..ReadOptions::default()
    }
}

fn first_box_text_path(psd: &psdx::psd::Psd) -> Option<Vec<usize>> {
    fn walk(layers: &[Layer], prefix: &mut Vec<usize>) -> Option<Vec<usize>> {
        for (i, layer) in layers.iter().enumerate() {
            prefix.push(i);
            if let Some(text) = layer.additional_info.text.as_ref() {
                if text.shape_type == Some(psdx::psd::TextShapeType::Box) {
                    return Some(prefix.clone());
                }
            }
            if let Some(children) = layer.children.as_ref() {
                if let Some(found) = walk(children, prefix) {
                    return Some(found);
                }
            }
            prefix.pop();
        }
        None
    }
    psd.children.as_ref().and_then(|c| walk(c, &mut Vec::new()))
}

fn layer_text<'a>(psd: &'a psdx::psd::Psd, path: &[usize]) -> &'a str {
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
        .additional_info
        .text
        .as_ref()
        .expect("text")
        .text
        .as_str()
}

fn layer_json(psd: &psdx::psd::Psd, path: &[usize]) -> serde_json::Value {
    let mut layers = psd.children.as_ref().expect("children");
    let mut cur = None;
    for (depth, &idx) in path.iter().enumerate() {
        cur = layers.get(idx);
        let layer = cur.expect("path");
        if depth + 1 < path.len() {
            layers = layer.children.as_ref().expect("children");
        }
    }
    serde_json::to_value(cur.expect("layer")).expect("json")
}

/// No-op set_text → byte-identical to expected.psd (not src.psd).
/// Uses upstream-oracle read (`resolve_inherited_fonts: Some(false)`) so bytes
/// match ag-psd `expected.*`; default read would diverge on `text-box`.
#[test]
fn noop_set_text_matches_expected_psd() {
    let Some(src) = fixture_src("read-write", "text-box") else {
        eprintln!("skip: read-write/text-box missing");
        return;
    };
    let Some(expected_path) = fixture_expected("read-write", "text-box") else {
        eprintln!("skip: read-write/text-box expected missing");
        return;
    };
    let expected = fs::read(&expected_path).expect("expected");
    let bytes = fs::read(&src).expect("src");
    let mut psd = read_psd(&bytes, &read_opts_byte_oracle()).expect("read");
    let path = first_box_text_path(&psd).expect("box text layer");
    let current = layer_text(&psd, &path).to_string();

    {
        let mut session = TextEdit::begin(&mut psd, RasterPolicy::Leave, FontResolution::Resolved)
            .expect("begin");
        session
            .layer_at(&path)
            .expect("layer")
            .set_text(&current)
            .expect("noop set_text");
        let report = session.finish();
        assert_eq!(report.mutations, 0);
        assert!(!report.doc_text_blob_dropped);
    }

    let written = write_psd(
        &psd,
        &WriteOptions {
            log_missing_features: Some(true),
            ..WriteOptions::default()
        },
    )
    .expect("write");
    assert_eq!(
        written,
        expected,
        "noop set_text must match expected.psd (len {} vs {})",
        written.len(),
        expected.len()
    );
}

/// After a real change: reread text is new; doc-level text blob missing.
#[test]
fn set_text_updates_string_and_drops_doc_blob() {
    let Some(src) = fixture_src("read-write", "text-box") else {
        eprintln!("skip: read-write/text-box missing");
        return;
    };
    let bytes = fs::read(&src).expect("src");
    let mut psd = read_psd(&bytes, &read_opts_resolved()).expect("read");
    assert!(
        psd.additional_info.engine_data.is_some(),
        "fixture should carry doc-level Txt2"
    );
    let path = first_box_text_path(&psd).expect("box text");
    let old = layer_text(&psd, &path).to_string();
    let new_text = format!("{old}!");

    {
        let mut session = TextEdit::begin(&mut psd, RasterPolicy::Leave, FontResolution::Resolved)
            .expect("begin");
        session
            .layer_at(&path)
            .expect("layer")
            .set_text(&new_text)
            .expect("set_text");
        let report = session.finish();
        assert_eq!(report.mutations, 1);
        assert!(report.doc_text_blob_dropped);
    }

    assert!(psd.additional_info.engine_data.is_none());
    let written = write_psd(&psd, &WriteOptions::default()).expect("write");
    let reread = read_psd(&written, &read_opts_resolved()).expect("reread");
    assert!(reread.additional_info.engine_data.is_none());
    assert_eq!(layer_text(&reread, &path), new_text);
}

/// Only the target layer changes (two top-level box text layers).
#[test]
fn only_target_layer_changes() {
    let Some(src) = fixture_src("read", "alias") else {
        eprintln!("skip: read/alias missing");
        return;
    };
    let bytes = fs::read(&src).expect("src");
    let mut psd = read_psd(&bytes, &read_opts_resolved()).expect("read");

    // alias has path_type=1 (box), not path text (type 2) — begin must succeed.
    let path_a = vec![1usize];
    let path_b = vec![2usize];
    assert!(
        psd.children.as_ref().unwrap()[1]
            .additional_info
            .text
            .is_some()
    );
    assert!(
        psd.children.as_ref().unwrap()[2]
            .additional_info
            .text
            .is_some()
    );

    let other_before = layer_json(&psd, &path_b);

    {
        let mut session = TextEdit::begin(&mut psd, RasterPolicy::Leave, FontResolution::Resolved)
            .expect("begin");
        let mut layer = session.layer_named("Windows").expect("named");
        assert_eq!(layer.path(), path_a.as_slice());
        layer.set_text("Edited").expect("set_text");
        let _ = session.finish();
    }

    let other_after = layer_json(&psd, &path_b);
    assert_eq!(
        other_before, other_after,
        "non-target text layer must be unchanged"
    );
    assert_eq!(layer_text(&psd, &path_a), "Edited");
}

/// Same edit applied twice → identical write bytes.
#[test]
fn set_text_idempotent() {
    let Some(src) = fixture_src("read-write", "text-box") else {
        eprintln!("skip: read-write/text-box missing");
        return;
    };
    let bytes = fs::read(&src).expect("src");

    let write_once = |apply_twice: bool| {
        let mut psd = read_psd(&bytes, &read_opts_resolved()).expect("read");
        let path = first_box_text_path(&psd).expect("box");
        {
            let mut session =
                TextEdit::begin(&mut psd, RasterPolicy::Leave, FontResolution::Resolved)
                    .expect("begin");
            let mut layer = session.layer_at(&path).expect("layer");
            layer.set_text("Once").expect("first");
            if apply_twice {
                layer.set_text("Once").expect("second");
            }
            let _ = session.finish();
        }
        write_psd(&psd, &WriteOptions::default()).expect("write")
    };

    let a = write_once(false);
    let b = write_once(true);
    assert_eq!(a, b, "double apply must be byte-idempotent");
}

#[test]
fn begin_errors_when_fonts_unresolved() {
    let Some(src) = fixture_src("read-write", "text-box") else {
        eprintln!("skip: read-write/text-box missing");
        return;
    };
    let bytes = fs::read(&src).expect("src");
    let mut psd = read_psd(&bytes, &read_opts_unresolved()).expect("read");
    let err = match TextEdit::begin(&mut psd, RasterPolicy::Leave, FontResolution::Unresolved) {
        Ok(_) => panic!("unresolved fonts must fail begin"),
        Err(e) => e,
    };
    assert_eq!(err, TextEditError::FontsNotResolved);
}

#[test]
fn begin_refuses_path_text_fixture() {
    let Some(src) = fixture_src("read", "text-path") else {
        eprintln!("skip: read/text-path missing");
        return;
    };
    let bytes = fs::read(&src).expect("src");
    let mut psd = read_psd(&bytes, &read_opts_resolved()).expect("read");
    let err = match TextEdit::begin(&mut psd, RasterPolicy::Leave, FontResolution::Resolved) {
        Ok(_) => panic!("path text must fail begin"),
        Err(e) => e,
    };
    assert_eq!(err, TextEditError::PathTextPresent);
}

#[test]
fn raster_policy_leave_preserves_pixels() {
    let Some(src) = fixture_src("read-write", "text-box") else {
        eprintln!("skip: read-write/text-box missing");
        return;
    };
    let bytes = fs::read(&src).expect("src");
    let mut psd = read_psd(&bytes, &read_opts_resolved()).expect("read");
    let path = first_box_text_path(&psd).expect("box");
    let before = {
        let mut layers = psd.children.as_ref().unwrap().as_slice();
        let mut cur = None;
        for (depth, &idx) in path.iter().enumerate() {
            cur = layers.get(idx);
            if depth + 1 < path.len() {
                layers = cur.unwrap().children.as_ref().unwrap();
            }
        }
        cur.unwrap().image_data.clone()
    };

    {
        let mut session = TextEdit::begin(&mut psd, RasterPolicy::Leave, FontResolution::Resolved)
            .expect("begin");
        session.layer_at(&path).unwrap().set_text("Leave").unwrap();
        let _ = session.finish();
    }

    let after = {
        let mut layers = psd.children.as_ref().unwrap().as_slice();
        let mut cur = None;
        for (depth, &idx) in path.iter().enumerate() {
            cur = layers.get(idx);
            if depth + 1 < path.len() {
                layers = cur.unwrap().children.as_ref().unwrap();
            }
        }
        cur.unwrap().image_data.clone()
    };
    match (before, after) {
        (Some(a), Some(b)) => {
            assert_eq!(a.width, b.width);
            assert_eq!(a.height, b.height);
            assert_eq!(a.data, b.data);
        }
        (None, None) => {}
        other => panic!("unexpected pixel presence: {other:?}"),
    }
}

#[test]
fn raster_policy_drop_transparent_keeps_bounds() {
    let Some(src) = fixture_src("read-write", "text-box") else {
        eprintln!("skip: read-write/text-box missing");
        return;
    };
    let bytes = fs::read(&src).expect("src");
    let mut psd = read_psd(&bytes, &read_opts_resolved()).expect("read");
    let path = first_box_text_path(&psd).expect("box");
    let rect_before = {
        let layer = &psd.children.as_ref().unwrap()[path[0]];
        (layer.top, layer.left, layer.bottom, layer.right)
    };

    {
        let mut session =
            TextEdit::begin(&mut psd, RasterPolicy::Drop, FontResolution::Resolved).expect("begin");
        session.layer_at(&path).unwrap().set_text("Drop").unwrap();
        let _ = session.finish();
    }

    let layer = &psd.children.as_ref().unwrap()[path[0]];
    assert_eq!(
        (layer.top, layer.left, layer.bottom, layer.right),
        rect_before
    );
    let img = layer.image_data.as_ref().expect("image_data");
    assert!(
        img.data.chunks_exact(4).all(|px| px[3] == 0),
        "Drop must install transparent pixels"
    );
}

#[test]
fn raster_policy_provide_installs_pixels() {
    let Some(src) = fixture_src("read-write", "text-box") else {
        eprintln!("skip: read-write/text-box missing");
        return;
    };
    let bytes = fs::read(&src).expect("src");
    let mut psd = read_psd(&bytes, &read_opts_resolved()).expect("read");
    let path = first_box_text_path(&psd).expect("box");
    let provided = PixelData::rgba8(4, 3, vec![9u8; 4 * 3 * 4]);

    {
        let mut session = TextEdit::begin(
            &mut psd,
            RasterPolicy::Provide(provided.clone()),
            FontResolution::Resolved,
        )
        .expect("begin");
        session
            .layer_at(&path)
            .unwrap()
            .set_text("Provide")
            .unwrap();
        let _ = session.finish();
    }

    let layer = &psd.children.as_ref().unwrap()[path[0]];
    let img = layer.image_data.as_ref().expect("image_data");
    assert_eq!((img.width, img.height), (4, 3));
    assert_eq!(img.data, provided.data);
    assert!(layer.raw_data.is_none());
}

/// Global `invalidate_text_layers` still works without the session.
#[test]
fn global_invalidate_text_layers_still_independent() {
    let Some(src) = fixture_src("read-write", "text-box") else {
        eprintln!("skip: read-write/text-box missing");
        return;
    };
    let bytes = fs::read(&src).expect("src");
    let psd = read_psd(&bytes, &read_opts_byte_oracle()).expect("read");
    assert!(psd.additional_info.engine_data.is_some());

    let written = write_psd(
        &psd,
        &WriteOptions {
            invalidate_text_layers: Some(true),
            ..WriteOptions::default()
        },
    )
    .expect("write");
    let reread = read_psd(&written, &read_opts_byte_oracle()).expect("reread");
    assert!(
        reread.additional_info.engine_data.is_none(),
        "global invalidate must still omit Txt2"
    );
}

/// `write_psd` must not mutate the in-memory model.
#[test]
fn write_does_not_mutate_model_after_edit() {
    let Some(src) = fixture_src("read-write", "text-box") else {
        eprintln!("skip: read-write/text-box missing");
        return;
    };
    let bytes = fs::read(&src).expect("src");
    let mut psd = read_psd(&bytes, &read_opts_resolved()).expect("read");
    let path = first_box_text_path(&psd).expect("box");
    {
        let mut session = TextEdit::begin(&mut psd, RasterPolicy::Leave, FontResolution::Resolved)
            .expect("begin");
        session.layer_at(&path).unwrap().set_text("NoMut").unwrap();
        let _ = session.finish();
    }
    let before = serde_json::to_value(&psd).expect("json before");
    let _ = write_psd(&psd, &WriteOptions::default()).expect("write");
    let after = serde_json::to_value(&psd).expect("json after");
    assert_eq!(before, after, "write_psd must not mutate the model");
}

fn layer_text_data<'a>(psd: &'a psdx::psd::Psd, path: &[usize]) -> &'a LayerTextData {
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
        .additional_info
        .text
        .as_ref()
        .expect("text")
}

fn layer_text_data_mut<'a>(psd: &'a mut psdx::psd::Psd, path: &[usize]) -> &'a mut LayerTextData {
    fn at<'b>(layers: &'b mut [Layer], path: &[usize]) -> Option<&'b mut Layer> {
        match path {
            [] => None,
            [i] => layers.get_mut(*i),
            [i, rest @ ..] => {
                let layer = layers.get_mut(*i)?;
                at(layer.children.as_mut()?, rest)
            }
        }
    }
    at(psd.children.as_mut().expect("children"), path)
        .expect("layer")
        .additional_info
        .text
        .as_mut()
        .expect("text")
}

fn utf16_len(s: &str) -> usize {
    s.encode_utf16().count()
}

fn style_run_length_sum(text: &LayerTextData) -> Option<usize> {
    text.style_runs.as_ref().map(|runs| {
        runs.iter()
            .map(|r| {
                if !r.length.is_finite() || r.length <= 0.0 {
                    0
                } else {
                    r.length.round() as usize
                }
            })
            .sum()
    })
}

/// No-op set_text_reflow → byte-identical to expected.psd.
#[test]
fn noop_set_text_reflow_matches_expected_psd() {
    let Some(src) = fixture_src("read-write", "text-box") else {
        eprintln!("skip: read-write/text-box missing");
        return;
    };
    let Some(expected_path) = fixture_expected("read-write", "text-box") else {
        eprintln!("skip: read-write/text-box expected missing");
        return;
    };
    let expected = fs::read(&expected_path).expect("expected");
    let bytes = fs::read(&src).expect("src");
    let mut psd = read_psd(&bytes, &read_opts_byte_oracle()).expect("read");
    let path = first_box_text_path(&psd).expect("box text layer");
    let current = layer_text(&psd, &path).to_string();

    {
        let mut session = TextEdit::begin(&mut psd, RasterPolicy::Leave, FontResolution::Resolved)
            .expect("begin");
        session
            .layer_at(&path)
            .expect("layer")
            .set_text_reflow(&current)
            .expect("noop set_text_reflow");
        let report = session.finish();
        assert_eq!(report.mutations, 0);
        assert!(!report.doc_text_blob_dropped);
    }

    let written = write_psd(
        &psd,
        &WriteOptions {
            log_missing_features: Some(true),
            ..WriteOptions::default()
        },
    )
    .expect("write");
    assert_eq!(
        written,
        expected,
        "noop set_text_reflow must match expected.psd (len {} vs {})",
        written.len(),
        expected.len()
    );
}

/// No-op set_run_text → byte-identical to expected.psd (when style runs exist).
#[test]
fn noop_set_run_text_matches_expected_psd() {
    let Some(src) = fixture_src("read-write", "text-box") else {
        eprintln!("skip: read-write/text-box missing");
        return;
    };
    let Some(expected_path) = fixture_expected("read-write", "text-box") else {
        eprintln!("skip: read-write/text-box expected missing");
        return;
    };
    let expected = fs::read(&expected_path).expect("expected");
    let bytes = fs::read(&src).expect("src");
    let mut psd = read_psd(&bytes, &read_opts_byte_oracle()).expect("read");
    let path = first_box_text_path(&psd).expect("box text layer");
    let text = layer_text_data(&psd, &path);
    let Some(runs) = text.style_runs.as_ref() else {
        eprintln!("skip: text-box has no style_runs after decode");
        return;
    };
    if runs.is_empty() {
        eprintln!("skip: text-box style_runs empty");
        return;
    }
    let first_len = if runs[0].length.is_finite() && runs[0].length > 0.0 {
        runs[0].length.round() as usize
    } else {
        0
    };
    let units: Vec<u16> = text.text.encode_utf16().collect();
    let end = first_len.min(units.len());
    let first_slice = String::from_utf16_lossy(&units[..end]);

    {
        let mut session = TextEdit::begin(&mut psd, RasterPolicy::Leave, FontResolution::Resolved)
            .expect("begin");
        session
            .layer_at(&path)
            .expect("layer")
            .set_run_text(0, &first_slice)
            .expect("noop set_run_text");
        let report = session.finish();
        assert_eq!(report.mutations, 0);
        assert!(!report.doc_text_blob_dropped);
    }

    let written = write_psd(
        &psd,
        &WriteOptions {
            log_missing_features: Some(true),
            ..WriteOptions::default()
        },
    )
    .expect("write");
    assert_eq!(
        written,
        expected,
        "noop set_run_text must match expected.psd (len {} vs {})",
        written.len(),
        expected.len()
    );
}

/// After reflow, model run lengths sum to UTF-16 text length before write;
/// write→read preserves run count / lengths / distinguishing style flags.
#[test]
fn reflow_round_trip_preserves_run_structure() {
    let Some(src) = fixture_src("read-write", "text-box") else {
        eprintln!("skip: read-write/text-box missing");
        return;
    };
    let bytes = fs::read(&src).expect("src");
    let mut psd = read_psd(&bytes, &read_opts_resolved()).expect("read");
    let path = first_box_text_path(&psd).expect("box");

    {
        let text = layer_text_data_mut(&mut psd, &path);
        let base = text.text.clone();
        // Force a two-run model so reflow has boundaries to keep.
        let split = (utf16_len(&base) / 2).max(1);
        let rest = utf16_len(&base).saturating_sub(split);
        text.style_runs = Some(vec![
            TextStyleRun {
                length: split as f64,
                style: TextStyle {
                    faux_bold: Some(true),
                    ..Default::default()
                },
            },
            TextStyleRun {
                length: rest as f64,
                style: TextStyle {
                    faux_italic: Some(true),
                    ..Default::default()
                },
            },
        ]);
    }

    let new_text = {
        let old = layer_text(&psd, &path).to_string();
        format!("{old}!!")
    };

    {
        let mut session = TextEdit::begin(&mut psd, RasterPolicy::Leave, FontResolution::Resolved)
            .expect("begin");
        session
            .layer_at(&path)
            .unwrap()
            .set_text_reflow(&new_text)
            .unwrap();
        let _ = session.finish();
    }

    let before = layer_text_data(&psd, &path);
    assert_eq!(style_run_length_sum(before), Some(utf16_len(&before.text)));
    let runs_before = before.style_runs.as_ref().expect("runs").clone();
    assert_eq!(runs_before.len(), 2);
    assert_eq!(runs_before[0].style.faux_bold, Some(true));
    assert_eq!(runs_before[1].style.faux_italic, Some(true));

    let written = write_psd(&psd, &WriteOptions::default()).expect("write");
    let reread = read_psd(&written, &read_opts_resolved()).expect("reread");
    let after = layer_text_data(&reread, &path);
    assert_eq!(after.text, new_text);
    let runs_after = after.style_runs.as_ref().expect("runs after");
    assert_eq!(runs_after.len(), runs_before.len());
    for (a, b) in runs_before.iter().zip(runs_after.iter()) {
        assert_eq!(a.length.round() as usize, b.length.round() as usize);
    }
    assert_eq!(runs_after[0].style.faux_bold, Some(true));
    assert_eq!(runs_after[1].style.faux_italic, Some(true));
    assert_eq!(style_run_length_sum(after), Some(utf16_len(&after.text)));
}

/// set_run_text then write→read: only the edited run's length changes.
#[test]
fn set_run_text_round_trip() {
    let Some(src) = fixture_src("read-write", "text-box") else {
        eprintln!("skip: read-write/text-box missing");
        return;
    };
    let bytes = fs::read(&src).expect("src");
    let mut psd = read_psd(&bytes, &read_opts_resolved()).expect("read");
    let path = first_box_text_path(&psd).expect("box");

    {
        let text = layer_text_data_mut(&mut psd, &path);
        let base = text.text.clone();
        let split = (utf16_len(&base) / 2).max(1);
        let rest = utf16_len(&base).saturating_sub(split);
        assert!(rest > 0, "fixture text too short for two runs");
        text.style_runs = Some(vec![
            TextStyleRun {
                length: split as f64,
                style: TextStyle {
                    faux_bold: Some(true),
                    ..Default::default()
                },
            },
            TextStyleRun {
                length: rest as f64,
                style: TextStyle {
                    faux_italic: Some(true),
                    ..Default::default()
                },
            },
        ]);
    }

    let second_len_before = layer_text_data(&psd, &path).style_runs.as_ref().unwrap()[1].length;

    {
        let mut session = TextEdit::begin(&mut psd, RasterPolicy::Leave, FontResolution::Resolved)
            .expect("begin");
        session
            .layer_at(&path)
            .unwrap()
            .set_run_text(0, "Z")
            .unwrap();
        let _ = session.finish();
    }

    let before_write = layer_text_data(&psd, &path);
    assert_eq!(
        style_run_length_sum(before_write),
        Some(utf16_len(&before_write.text))
    );
    assert_eq!(
        before_write.style_runs.as_ref().unwrap()[1].length,
        second_len_before
    );

    let written = write_psd(&psd, &WriteOptions::default()).expect("write");
    let reread = read_psd(&written, &read_opts_resolved()).expect("reread");
    let after = layer_text_data(&reread, &path);
    assert!(after.text.starts_with('Z'));
    let runs = after.style_runs.as_ref().expect("runs");
    assert_eq!(runs.len(), 2);
    assert_eq!(runs[0].length.round() as usize, 1);
    assert_eq!(
        runs[1].length.round() as usize,
        second_len_before.round() as usize
    );
    assert_eq!(style_run_length_sum(after), Some(utf16_len(&after.text)));
}

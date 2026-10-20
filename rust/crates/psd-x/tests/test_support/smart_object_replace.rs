//! Embedded smart-object replace (same-size, frame, warp, fork).
//!
//! Self-loop tests (read → edit → write → read). Byte assertions compare to
//! `expected.psd`, never `src.psd`. Skips cleanly when fixtures are absent.
//! Pure frame math lives in `smart_object::frame` unit tests; identity mesh
//! predicate in `smart_object::warp`.

use psdx::test_corpus;
use std::path::PathBuf;

use psdx::psd::{
    ColorMode, Layer, LayerAdditionalInfo, LinkedFile, PixelData, PlacedLayer, Psd, ReadOptions,
    Warp, WriteOptions,
};
use psdx::smart_object::{
    FramePolicy, LayerTarget, ReplaceScope, Replacement, SmartObjectError, WarpPolicy,
    find_smart_objects, generate_linked_file_guid, guid_associations_hold, is_guid,
    is_identity_warp_mesh, replace_smart_object,
};
use psdx::{read_psd, write_psd};

fn fixtures_root() -> PathBuf {
    test_corpus::corpus_root()
}

fn read_write_dir(name: &str) -> PathBuf {
    fixtures_root().join("read-write").join(name)
}

fn read_write_expected(name: &str) -> Option<Vec<u8>> {
    std::fs::read(read_write_dir(name).join("expected.psd")).ok()
}

fn read_write_src(name: &str) -> Option<Vec<u8>> {
    std::fs::read(read_write_dir(name).join("src.psd")).ok()
}

/// Options that make `read(src) → write` match `expected.psd` (see `read_write_bytes`).
fn read_opts() -> ReadOptions {
    ReadOptions {
        use_image_data: Some(true),
        use_raw_thumbnail: Some(true),
        throw_for_missing_features: Some(true),
        ..ReadOptions::default()
    }
}

fn write_opts() -> WriteOptions {
    WriteOptions {
        log_missing_features: Some(true),
        ..WriteOptions::default()
    }
}

fn load_from_src(name: &str) -> Option<Psd> {
    let bytes = read_write_src(name)?;
    read_psd(&bytes, &read_opts()).ok()
}

fn linked_data<'a>(psd: &'a Psd, id: &str) -> Option<&'a [u8]> {
    psd.linked_files
        .as_deref()?
        .iter()
        .find(|f| f.id == id)?
        .data
        .as_deref()
}

fn first_smart(psd: &Psd) -> (Vec<usize>, String, String) {
    let infos = find_smart_objects(psd, &LayerTarget::Path(vec![]));
    assert!(!infos.is_empty(), "expected at least one smart object");
    let info = &infos[0];
    (
        info.path.clone(),
        info.linked_id.clone(),
        info.file_name.clone().unwrap_or_else(|| "asset".into()),
    )
}

fn layer_at<'a>(psd: &'a Psd, path: &[usize]) -> &'a Layer {
    let mut layers = psd.children.as_deref().unwrap();
    let mut layer = &layers[path[0]];
    for &idx in &path[1..] {
        layers = layer.children.as_deref().unwrap();
        layer = &layers[idx];
    }
    layer
}

fn transform_of(psd: &Psd, path: &[usize]) -> Vec<f64> {
    layer_at(psd, path)
        .additional_info
        .placed_layer
        .as_ref()
        .unwrap()
        .transform
        .clone()
}

fn warp_of(psd: &Psd, path: &[usize]) -> Option<Warp> {
    layer_at(psd, path)
        .additional_info
        .placed_layer
        .as_ref()
        .unwrap()
        .warp
        .clone()
}

fn mesh_bytes(warp: &Option<Warp>) -> Option<Vec<u8>> {
    let w = warp.as_ref()?;
    let cew = w.custom_envelope_warp.as_ref()?;
    let mut out = Vec::with_capacity(cew.mesh_points.len() * 16);
    for p in &cew.mesh_points {
        out.extend_from_slice(&p.x.to_bits().to_le_bytes());
        out.extend_from_slice(&p.y.to_bits().to_le_bytes());
    }
    Some(out)
}

/// Empty-op byte equality against `expected.psd` (never `src.psd`).
#[test]
fn noop_replace_bytes_equal_expected() {
    let Some(src_bytes) = read_write_src("smart") else {
        eprintln!("skip: read-write/smart missing");
        return;
    };
    let expected_bytes = read_write_expected("smart").expect("expected.psd");
    let mut psd = read_psd(&src_bytes, &read_opts()).expect("read src");
    assert!(guid_associations_hold(&psd));

    let (path, linked_id, name) = first_smart(&psd);
    let data = linked_data(&psd, &linked_id)
        .expect("embedded data")
        .to_vec();

    let report = replace_smart_object(
        &mut psd,
        &LayerTarget::Path(path.clone()),
        Replacement::new(&data, name),
    )
    .expect("noop replace");
    assert_eq!(report.linked_id, linked_id);
    assert_eq!(report.old_size, report.new_size);
    assert!(guid_associations_hold(&psd));

    let written = write_psd(&psd, &write_opts()).expect("write");
    assert_eq!(
        written, expected_bytes,
        "noop replace must be byte-identical to expected.psd"
    );
}

/// Same-size replace updates linked bytes; placement geometry unchanged.
#[test]
fn same_size_replace_updates_data_keeps_geometry() {
    let Some(mut psd) = load_from_src("smart") else {
        eprintln!("skip: read-write/smart missing");
        return;
    };
    let (path, linked_id, _name) = first_smart(&psd);
    let old_data = linked_data(&psd, &linked_id).expect("data").to_vec();
    let geom_before = transform_of(&psd, &path);
    let w = psd
        .children
        .as_ref()
        .unwrap()
        .iter()
        .find_map(|l| {
            l.additional_info
                .placed_layer
                .as_ref()
                .filter(|p| p.id == linked_id)
                .map(|p| (p.width, p.height))
        })
        .unwrap();

    // Flip a byte that is not in the image header so sniff size stays valid.
    let mut new_data = old_data.clone();
    let flip_at = new_data.len() / 2;
    new_data[flip_at] ^= 0x5A;

    replace_smart_object(
        &mut psd,
        &LayerTarget::LinkedId(linked_id.clone()),
        Replacement::new(&new_data, "replaced.bin"),
    )
    .expect("replace");

    let written = write_psd(&psd, &write_opts()).expect("write");
    let reread = read_psd(&written, &read_opts()).expect("reread");
    let got = linked_data(&reread, &linked_id).expect("data after reread");
    assert_eq!(got, new_data.as_slice());
    assert_eq!(transform_of(&reread, &path), geom_before);
    let placed = reread
        .children
        .as_ref()
        .unwrap()
        .iter()
        .find_map(|l| {
            l.additional_info
                .placed_layer
                .as_ref()
                .filter(|p| p.id == linked_id)
        })
        .unwrap();
    assert_eq!(placed.width, w.0);
    assert_eq!(placed.height, w.1);
}

/// Only the targeted linked file changes; the other smart object is untouched.
#[test]
fn only_target_linked_file_changes() {
    let Some(mut psd) = load_from_src("smart") else {
        eprintln!("skip: read-write/smart missing");
        return;
    };
    let infos = find_smart_objects(&psd, &LayerTarget::Path(vec![]));
    assert!(infos.len() >= 2, "smart fixture needs two placements");
    let target = &infos[0];
    let other = &infos[1];
    let other_before = linked_data(&psd, &other.linked_id)
        .expect("other data")
        .to_vec();
    let mut new_data = linked_data(&psd, &target.linked_id)
        .expect("target data")
        .to_vec();
    let mid = new_data.len() / 2;
    new_data[mid] ^= 0x11;

    replace_smart_object(
        &mut psd,
        &LayerTarget::Path(target.path.clone()),
        Replacement::new(&new_data, target.file_name.clone().unwrap()),
    )
    .expect("replace");

    assert_eq!(
        linked_data(&psd, &other.linked_id).unwrap(),
        other_before.as_slice()
    );
}

#[test]
fn guid_associations_hold_before_and_after() {
    let Some(mut psd) = load_from_src("smart") else {
        eprintln!("skip: read-write/smart missing");
        return;
    };
    assert!(guid_associations_hold(&psd));
    let (path, linked_id, name) = first_smart(&psd);
    let data = linked_data(&psd, &linked_id).unwrap().to_vec();
    replace_smart_object(
        &mut psd,
        &LayerTarget::Path(path),
        Replacement::new(&data, name),
    )
    .unwrap();
    assert!(guid_associations_hold(&psd));
}

#[test]
fn replace_is_idempotent_on_bytes() {
    let Some(mut psd) = load_from_src("smart") else {
        eprintln!("skip: read-write/smart missing");
        return;
    };
    let (path, linked_id, name) = first_smart(&psd);
    let mut data = linked_data(&psd, &linked_id).unwrap().to_vec();
    let at = data.len() / 3;
    data[at] ^= 0x22;

    replace_smart_object(
        &mut psd,
        &LayerTarget::Path(path.clone()),
        Replacement::new(&data, &name),
    )
    .unwrap();
    let once = write_psd(&psd, &write_opts()).unwrap();

    let mut psd2 = read_psd(&once, &read_opts()).unwrap();
    replace_smart_object(
        &mut psd2,
        &LayerTarget::Path(path),
        Replacement::new(&data, &name),
    )
    .unwrap();
    let twice = write_psd(&psd2, &write_opts()).unwrap();
    assert_eq!(once, twice);
}

#[test]
fn invalid_guid_rejected_at_api_boundary() {
    let mut psd = minimal_rgb_doc();
    let err = replace_smart_object(
        &mut psd,
        &LayerTarget::LinkedId("not-a-guid".into()),
        Replacement::new(&[0u8; 8], "x"),
    )
    .unwrap_err();
    assert!(matches!(err, SmartObjectError::InvalidGuid { .. }));

    let err = replace_smart_object(
        &mut psd,
        &LayerTarget::PlacedId("UPPER-CASE-0000-0000-0000-000000000000".into()),
        Replacement::new(&[0u8; 8], "x"),
    )
    .unwrap_err();
    assert!(matches!(err, SmartObjectError::InvalidGuid { .. }));
}

/// Non-Photoshop linked-file tags (`png `, `SVG ` / `ART5`) survive a noop replace.
#[test]
fn non_photoshop_tags_round_trip() {
    let Some(src_bytes) = read_write_src("shapes") else {
        eprintln!("skip: read-write/shapes missing");
        return;
    };
    let expected_bytes = read_write_expected("shapes").expect("expected");
    let mut psd = read_psd(&src_bytes, &read_opts()).expect("read shapes");
    let infos = find_smart_objects(&psd, &LayerTarget::Path(vec![]));
    let png = infos
        .iter()
        .find(|i| i.file_name.as_deref() == Some("apple.png"))
        .expect("apple.png smart object");
    let file = psd
        .linked_files
        .as_ref()
        .unwrap()
        .iter()
        .find(|f| f.id == png.linked_id)
        .unwrap();
    // Model stores trimmed tag ("png"); writer pads back to "png ".
    assert_eq!(file.file_type.as_deref(), Some("png"));
    let data = file.data.as_ref().unwrap().clone();
    let name = file.name.clone();

    replace_smart_object(
        &mut psd,
        &LayerTarget::Path(png.path.clone()),
        Replacement::new(&data, name),
    )
    .expect("noop png");

    let written = write_psd(&psd, &write_opts()).expect("write");
    assert_eq!(
        written, expected_bytes,
        "noop png replace must match expected.psd (tags included)"
    );
    assert!(written.windows(4).any(|w| w == b"png "));

    // SVG + ART5 (SVG is not sniffable — pass size from the placed layer).
    let mut psd = read_psd(&src_bytes, &read_opts()).unwrap();
    let svg = find_smart_objects(&psd, &LayerTarget::Path(vec![]))
        .into_iter()
        .find(|i| i.file_name.as_deref() == Some("calendar.svg"))
        .expect("calendar.svg");
    let file = psd
        .linked_files
        .as_ref()
        .unwrap()
        .iter()
        .find(|f| f.id == svg.linked_id)
        .unwrap()
        .clone();
    assert_eq!(file.file_type.as_deref(), Some("SVG"));
    assert_eq!(file.creator.as_deref(), Some("ART5"));
    let size = (
        svg.width.expect("w").round() as u32,
        svg.height.expect("h").round() as u32,
    );
    replace_smart_object(
        &mut psd,
        &LayerTarget::Path(svg.path),
        Replacement {
            size: Some(size),
            ..Replacement::new(file.data.as_ref().unwrap(), file.name)
        },
    )
    .unwrap();
    let written = write_psd(&psd, &write_opts()).unwrap();
    assert_eq!(written, expected_bytes);
    assert!(written.windows(4).any(|w| w == b"SVG "));
    assert!(written.windows(4).any(|w| w == b"ART5"));
}

/// Version-selecting Option fields stay present (including zero values).
#[test]
fn record_version_fields_preserved() {
    let Some(mut psd) = load_from_src("smart-object-curves") else {
        eprintln!("skip: read-write/smart-object-curves missing");
        return;
    };
    let (path, linked_id, name) = first_smart(&psd);
    let before = psd
        .linked_files
        .as_ref()
        .unwrap()
        .iter()
        .find(|f| f.id == linked_id)
        .unwrap()
        .clone();
    assert!(before.child_document_id.is_some());
    assert!(before.asset_mod_time.is_some());
    assert!(before.asset_locked_state.is_some());

    let data = before.data.as_ref().unwrap().clone();
    replace_smart_object(
        &mut psd,
        &LayerTarget::Path(path),
        Replacement::new(&data, name),
    )
    .unwrap();

    let after = psd
        .linked_files
        .as_ref()
        .unwrap()
        .iter()
        .find(|f| f.id == linked_id)
        .unwrap();
    assert_eq!(after.child_document_id, before.child_document_id);
    assert_eq!(after.asset_mod_time, before.asset_mod_time);
    assert_eq!(after.asset_locked_state, before.asset_locked_state);
    assert_eq!(after.file_type, before.file_type);
    assert_eq!(after.creator, before.creator);
    assert_eq!(after.id, before.id);
}

#[test]
fn reject_skipped_linked_data() {
    let Some(bytes) = read_write_src("smart") else {
        eprintln!("skip: smart missing");
        return;
    };
    let mut psd = read_psd(
        &bytes,
        &ReadOptions {
            use_image_data: Some(true),
            use_raw_thumbnail: Some(true),
            skip_linked_files_data: Some(true),
            ..ReadOptions::default()
        },
    )
    .unwrap();
    let (path, _, name) = first_smart(&psd);
    let err = replace_smart_object(
        &mut psd,
        &LayerTarget::Path(path),
        Replacement::new(&[0u8; 16], name),
    )
    .unwrap_err();
    assert_eq!(err, SmartObjectError::LinkedDataSkipped);
}

#[test]
fn reject_external_linked_file() {
    let mut psd = minimal_rgb_doc();
    let id = "20953ddb-9391-11ec-b4f1-c15674f50bc4".to_string();
    psd.linked_files = Some(vec![LinkedFile {
        id: id.clone(),
        name: "ext.jpg".into(),
        linked_file: Some(psdx::psd::ExternalLinkedFile {
            file_size: 10.0,
            name: "ext.jpg".into(),
            full_path: "/tmp/ext.jpg".into(),
            original_path: String::new(),
            relative_path: String::new(),
        }),
        data: None,
        ..LinkedFile::default()
    }]);
    attach_placed(&mut psd, &id, 10, 10);
    let err = replace_smart_object(
        &mut psd,
        &LayerTarget::Path(vec![0]),
        Replacement {
            size: Some((10, 10)),
            ..Replacement::new(&[0u8; 4], "ext.jpg")
        },
    )
    .unwrap_err();
    assert_eq!(err, SmartObjectError::ExternalLinkNotSupported);
}

#[test]
fn reject_non_rgb() {
    let mut psd = minimal_rgb_doc();
    psd.color_mode = Some(ColorMode::Grayscale);
    let id = "20953ddb-9391-11ec-b4f1-c15674f50bc4".to_string();
    psd.linked_files = Some(vec![LinkedFile {
        id: id.clone(),
        name: "a.png".into(),
        data: Some(vec![1, 2, 3, 4]),
        ..LinkedFile::default()
    }]);
    attach_placed(&mut psd, &id, 1, 1);
    let err = replace_smart_object(
        &mut psd,
        &LayerTarget::Path(vec![0]),
        Replacement {
            size: Some((1, 1)),
            ..Replacement::new(&[1, 2, 3, 4], "a.png")
        },
    )
    .unwrap_err();
    assert_eq!(err, SmartObjectError::NonRgbDocument);
}

#[test]
fn reject_shared_resource_without_fork() {
    let mut psd = minimal_rgb_doc();
    let id = "20953ddb-9391-11ec-b4f1-c15674f50bc4".to_string();
    let data = vec![9u8; 32];
    psd.linked_files = Some(vec![LinkedFile {
        id: id.clone(),
        name: "shared.png".into(),
        data: Some(data.clone()),
        ..LinkedFile::default()
    }]);
    // Two placements, one linked file.
    let mut a = placed_layer(&id, "aa5448f7-350c-11eb-b49a-c15674f50bc4", 4, 4);
    a.additional_info.name = Some("A".into());
    let mut b = placed_layer(&id, "aa5448f8-350c-11eb-b49a-c15674f50bc4", 4, 4);
    b.additional_info.name = Some("B".into());
    psd.children = Some(vec![a, b]);

    let err = replace_smart_object(
        &mut psd,
        &LayerTarget::Name("A".into()),
        Replacement {
            size: Some((4, 4)),
            scope: ReplaceScope::RequireExclusive,
            ..Replacement::new(&data, "shared.png")
        },
    )
    .unwrap_err();
    assert!(matches!(
        err,
        SmartObjectError::SharedResource { layer_count: 2 }
    ));
}

fn shared_two_layer_doc(data: Vec<u8>) -> (Psd, String) {
    let id = "20953ddb-9391-11ec-b4f1-c15674f50bc4".to_string();
    let mut psd = minimal_rgb_doc();
    psd.linked_files = Some(vec![LinkedFile {
        id: id.clone(),
        name: "shared.png".into(),
        data: Some(data),
        file_type: Some("png ".into()),
        creator: Some("8BIM".into()),
        child_document_id: Some(String::new()),
        asset_mod_time: Some(0.0),
        asset_locked_state: Some(0.0),
        ..LinkedFile::default()
    }]);
    let mut a = placed_layer(&id, "aa5448f7-350c-11eb-b49a-c15674f50bc4", 4, 4);
    a.additional_info.name = Some("A".into());
    let mut b = placed_layer(&id, "aa5448f8-350c-11eb-b49a-c15674f50bc4", 4, 4);
    b.additional_info.name = Some("B".into());
    psd.children = Some(vec![a, b]);
    (psd, id)
}

fn linked_id_of(psd: &Psd, name: &str) -> String {
    psd.children
        .as_ref()
        .unwrap()
        .iter()
        .find(|l| l.additional_info.name.as_deref() == Some(name))
        .unwrap()
        .additional_info
        .placed_layer
        .as_ref()
        .unwrap()
        .id
        .clone()
}

fn placed_core(
    psd: &Psd,
    name: &str,
) -> (String, Option<String>, Vec<f64>, Option<f64>, Option<f64>) {
    let p = psd
        .children
        .as_ref()
        .unwrap()
        .iter()
        .find(|l| l.additional_info.name.as_deref() == Some(name))
        .unwrap()
        .additional_info
        .placed_layer
        .as_ref()
        .unwrap();
    (
        p.id.clone(),
        p.placed.clone(),
        p.transform.clone(),
        p.width,
        p.height,
    )
}

/// InPlace: every user of the shared record sees the new bytes; GUIDs stay put.
#[test]
fn inplace_shared_replace_updates_all_keeps_guids() {
    let old = vec![9u8; 32];
    let (mut psd, id) = shared_two_layer_doc(old);
    let mut new_data = vec![7u8; 32];
    new_data[0] = 0xAB;

    let report = replace_smart_object(
        &mut psd,
        &LayerTarget::Name("A".into()),
        Replacement {
            size: Some((4, 4)),
            scope: ReplaceScope::InPlace,
            ..Replacement::new(&new_data, "shared.png")
        },
    )
    .expect("InPlace shared replace");

    assert_eq!(report.linked_id, id);
    assert_eq!(linked_id_of(&psd, "A"), id);
    assert_eq!(linked_id_of(&psd, "B"), id);
    assert_eq!(linked_data(&psd, &id), Some(new_data.as_slice()));
    assert_eq!(psd.linked_files.as_ref().unwrap().len(), 1);
    assert!(guid_associations_hold(&psd));
}

/// ThisLayerOnly: fork a new record for the target; the other placement is unchanged.
#[test]
fn fork_this_layer_only_leaves_other_byte_identical() {
    let old = vec![9u8; 32];
    let (mut psd, old_id) = shared_two_layer_doc(old.clone());
    let other_before = placed_core(&psd, "B");
    let old_file_before = psd.linked_files.as_ref().unwrap()[0].clone();
    let mut new_data = vec![7u8; 32];
    new_data[3] = 0x5A;

    let report = replace_smart_object(
        &mut psd,
        &LayerTarget::Name("A".into()),
        Replacement {
            size: Some((4, 4)),
            scope: ReplaceScope::ThisLayerOnly,
            ..Replacement::new(&new_data, "forked.png")
        },
    )
    .expect("fork");

    let new_id = report.linked_id;
    assert_ne!(new_id, old_id);
    assert!(is_guid(&new_id));
    let variant = new_id.as_bytes()[19];
    assert!(matches!(variant, b'8' | b'9' | b'a' | b'b'));

    assert_eq!(linked_id_of(&psd, "A"), new_id);
    assert_eq!(linked_id_of(&psd, "B"), old_id);
    assert_eq!(placed_core(&psd, "B"), other_before);
    assert_eq!(
        psd.linked_files
            .as_ref()
            .unwrap()
            .iter()
            .find(|f| f.id == old_id)
            .unwrap()
            .data
            .as_deref(),
        Some(old.as_slice())
    );
    // Old linked-file record fields other than identity of the vec stay equal.
    let old_after = psd
        .linked_files
        .as_ref()
        .unwrap()
        .iter()
        .find(|f| f.id == old_id)
        .unwrap();
    assert_eq!(old_after.name, old_file_before.name);
    assert_eq!(old_after.file_type, old_file_before.file_type);
    assert_eq!(old_after.creator, old_file_before.creator);
    assert_eq!(
        old_after.child_document_id,
        old_file_before.child_document_id
    );
    assert_eq!(old_after.asset_mod_time, old_file_before.asset_mod_time);
    assert_eq!(
        old_after.asset_locked_state,
        old_file_before.asset_locked_state
    );

    assert_eq!(linked_data(&psd, &new_id), Some(new_data.as_slice()));
    assert_eq!(psd.linked_files.as_ref().unwrap().len(), 2);
    assert!(guid_associations_hold(&psd));

    // Deterministic for the same seed inputs.
    let again = generate_linked_file_guid(
        [
            &old_id,
            "aa5448f7-350c-11eb-b49a-c15674f50bc4",
            "aa5448f8-350c-11eb-b49a-c15674f50bc4",
        ],
        &format!("{old_id}|aa5448f7-350c-11eb-b49a-c15674f50bc4|0"),
    );
    assert_eq!(again, new_id);
}

/// Default KeepScale same-size leaves placement geometry untouched (byte identity).
#[test]
fn keep_scale_same_size_matches_ticket_06_bytes() {
    let Some(src_bytes) = read_write_src("smart") else {
        eprintln!("skip: read-write/smart missing");
        return;
    };
    let expected_bytes = read_write_expected("smart").expect("expected.psd");
    let mut psd = read_psd(&src_bytes, &read_opts()).expect("read src");
    let (path, linked_id, name) = first_smart(&psd);
    let data = linked_data(&psd, &linked_id)
        .expect("embedded data")
        .to_vec();

    let report = replace_smart_object(
        &mut psd,
        &LayerTarget::Path(path),
        Replacement {
            frame: FramePolicy::KeepScale,
            ..Replacement::new(&data, name)
        },
    )
    .expect("keep-scale same-size");
    assert!(!report.content_stretched);
    assert_eq!(report.old_size, report.new_size);

    let written = write_psd(&psd, &write_opts()).expect("write");
    assert_eq!(
        written, expected_bytes,
        "default KeepScale same-size must match ticket 06 / expected.psd"
    );
}

#[test]
fn frame_policies_on_resize_update_size_and_clear_non_affine() {
    let id = "20953ddb-9391-11ec-b4f1-c15674f50bc4".to_string();
    let data = vec![7u8; 16];
    let cases: &[(FramePolicy, (u32, u32), [f64; 8], bool)] = &[
        // enlarge
        (
            FramePolicy::KeepScale,
            (8, 8),
            [0.0, 0.0, 8.0, 0.0, 8.0, 8.0, 0.0, 8.0],
            false,
        ),
        // shrink
        (
            FramePolicy::KeepScale,
            (2, 2),
            [0.0, 0.0, 2.0, 0.0, 2.0, 2.0, 0.0, 2.0],
            false,
        ),
        // aspect change
        (
            FramePolicy::KeepScale,
            (8, 2),
            [0.0, 0.0, 8.0, 0.0, 8.0, 2.0, 0.0, 2.0],
            false,
        ),
        (
            FramePolicy::KeepFrame,
            (8, 8),
            [0.0, 0.0, 4.0, 0.0, 4.0, 4.0, 0.0, 4.0],
            false,
        ),
        (
            FramePolicy::KeepFrame,
            (2, 2),
            [0.0, 0.0, 4.0, 0.0, 4.0, 4.0, 0.0, 4.0],
            false,
        ),
        (
            FramePolicy::KeepFrame,
            (8, 2),
            [0.0, 0.0, 4.0, 0.0, 4.0, 4.0, 0.0, 4.0],
            true,
        ),
        (
            FramePolicy::FitInFrame,
            (8, 8),
            [0.0, 0.0, 4.0, 0.0, 4.0, 4.0, 0.0, 4.0],
            false,
        ),
        (
            FramePolicy::FitInFrame,
            (2, 2),
            [0.0, 0.0, 4.0, 0.0, 4.0, 4.0, 0.0, 4.0],
            false,
        ),
        (
            FramePolicy::FitInFrame,
            (8, 2),
            [0.0, 0.0, 4.0, 0.0, 4.0, 1.0, 0.0, 1.0],
            false,
        ),
        (
            FramePolicy::Exact([1.0, 1.0, 9.0, 1.0, 9.0, 5.0, 1.0, 5.0]),
            (8, 8),
            [1.0, 1.0, 9.0, 1.0, 9.0, 5.0, 1.0, 5.0],
            false,
        ),
        (
            FramePolicy::Exact([0.0, 0.0, 1.0, 0.0, 1.0, 1.0, 0.0, 1.0]),
            (2, 2),
            [0.0, 0.0, 1.0, 0.0, 1.0, 1.0, 0.0, 1.0],
            false,
        ),
        (
            FramePolicy::Exact([2.0, 2.0, 6.0, 2.0, 6.0, 3.0, 2.0, 3.0]),
            (8, 2),
            [2.0, 2.0, 6.0, 2.0, 6.0, 3.0, 2.0, 3.0],
            false,
        ),
    ];

    for (policy, new_size, expect_tf, expect_stretch) in cases {
        let mut psd = minimal_rgb_doc();
        psd.linked_files = Some(vec![LinkedFile {
            id: id.clone(),
            name: "a.bin".into(),
            data: Some(data.clone()),
            ..LinkedFile::default()
        }]);
        let mut layer = placed_layer(&id, "aa5448f7-350c-11eb-b49a-c15674f50bc4", 4, 4);
        layer
            .additional_info
            .placed_layer
            .as_mut()
            .unwrap()
            .non_affine_transform = Some(vec![0.0, 0.0, 4.0, 0.5, 4.0, 4.0, 0.0, 4.0]);
        psd.children = Some(vec![layer]);

        let report = replace_smart_object(
            &mut psd,
            &LayerTarget::Path(vec![0]),
            Replacement {
                size: Some(*new_size),
                frame: policy.clone(),
                ..Replacement::new(&data, "a.bin")
            },
        )
        .unwrap_or_else(|e| panic!("policy {policy:?} size {new_size:?}: {e}"));

        assert_eq!(report.old_size, (4, 4));
        assert_eq!(report.new_size, *new_size);
        assert_eq!(report.content_stretched, *expect_stretch, "{policy:?}");

        let placed = psd.children.as_ref().unwrap()[0]
            .additional_info
            .placed_layer
            .as_ref()
            .unwrap();
        assert_eq!(placed.width, Some(new_size.0 as f64));
        assert_eq!(placed.height, Some(new_size.1 as f64));
        assert!(
            placed.non_affine_transform.is_none(),
            "non_affine must clear under {policy:?}"
        );
        assert_eq!(placed.transform, expect_tf.to_vec(), "{policy:?}");
        // Frame update must not touch layer raster bounds.
        let layer = &psd.children.as_ref().unwrap()[0];
        assert_eq!(layer.left, Some(0.0));
        assert_eq!(layer.top, Some(0.0));
        assert_eq!(layer.right, Some(4.0));
        assert_eq!(layer.bottom, Some(4.0));
    }
}

#[test]
fn keep_frame_aspect_change_reports_stretch() {
    let mut psd = minimal_rgb_doc();
    let id = "20953ddb-9391-11ec-b4f1-c15674f50bc4".to_string();
    let data = vec![1u8; 8];
    psd.linked_files = Some(vec![LinkedFile {
        id: id.clone(),
        name: "a.bin".into(),
        data: Some(data.clone()),
        ..LinkedFile::default()
    }]);
    attach_placed(&mut psd, &id, 10, 5);

    let report = replace_smart_object(
        &mut psd,
        &LayerTarget::Path(vec![0]),
        Replacement {
            size: Some((10, 10)),
            frame: FramePolicy::KeepFrame,
            ..Replacement::new(&data, "a.bin")
        },
    )
    .expect("keep frame");
    assert!(
        report.content_stretched,
        "aspect change under KeepFrame must warn via content_stretched"
    );
}

#[test]
fn invalid_frame_length_rejected() {
    let mut psd = minimal_rgb_doc();
    let id = "20953ddb-9391-11ec-b4f1-c15674f50bc4".to_string();
    let data = vec![1u8; 8];
    psd.linked_files = Some(vec![LinkedFile {
        id: id.clone(),
        name: "a.bin".into(),
        data: Some(data.clone()),
        ..LinkedFile::default()
    }]);
    let mut layer = placed_layer(&id, "aa5448f7-350c-11eb-b49a-c15674f50bc4", 4, 4);
    layer
        .additional_info
        .placed_layer
        .as_mut()
        .unwrap()
        .transform = vec![0.0; 6]; // malformed: not 8
    psd.children = Some(vec![layer]);

    let err = replace_smart_object(
        &mut psd,
        &LayerTarget::Path(vec![0]),
        Replacement {
            size: Some((8, 8)),
            frame: FramePolicy::KeepScale,
            ..Replacement::new(&data, "a.bin")
        },
    )
    .unwrap_err();
    assert!(matches!(err, SmartObjectError::InvalidFrame { length: 6 }));
}

#[test]
fn find_by_name_and_layer_id() {
    let Some(psd) = load_from_src("smart") else {
        eprintln!("skip: smart missing");
        return;
    };
    let all = find_smart_objects(&psd, &LayerTarget::Path(vec![]));
    let by_name = find_smart_objects(&psd, &LayerTarget::Name(all[0].layer_name.clone().unwrap()));
    assert_eq!(by_name.len(), 1);
    assert_eq!(by_name[0].linked_id, all[0].linked_id);

    let id = all[0].layer_id.expect("layer id");
    let by_id = find_smart_objects(&psd, &LayerTarget::LayerId(id));
    assert_eq!(by_id.len(), 1);
}

// ----- warp policies ----------------------------------------------------------

#[test]
fn auto_same_size_keeps_warp_mesh_bytes() {
    let Some(mut psd) = load_from_src("smart") else {
        eprintln!("skip: smart missing");
        return;
    };
    let (path, linked_id, name) = first_smart(&psd);
    let before = mesh_bytes(&warp_of(&psd, &path)).expect("smart has custom mesh");
    let data = linked_data(&psd, &linked_id)
        .expect("embedded data")
        .to_vec();

    replace_smart_object(
        &mut psd,
        &LayerTarget::Path(path.clone()),
        Replacement {
            warp: WarpPolicy::Auto,
            ..Replacement::new(&data, name)
        },
    )
    .expect("auto same-size");

    let after = mesh_bytes(&warp_of(&psd, &path)).expect("warp kept");
    assert_eq!(
        before, after,
        "Auto same-size must leave mesh bits unchanged"
    );
}

#[test]
fn auto_resize_resets_warp_to_writer_identity() {
    let Some(mut psd) = load_from_src("smart") else {
        eprintln!("skip: smart missing");
        return;
    };
    let (path, linked_id, name) = first_smart(&psd);
    assert!(warp_of(&psd, &path).is_some());
    let data = linked_data(&psd, &linked_id)
        .expect("embedded data")
        .to_vec();
    let placed = layer_at(&psd, &path)
        .additional_info
        .placed_layer
        .as_ref()
        .unwrap();
    let old_size = (
        placed.width.unwrap().round() as u32,
        placed.height.unwrap().round() as u32,
    );
    let new_size = (old_size.0 + 8, old_size.1 + 8);

    replace_smart_object(
        &mut psd,
        &LayerTarget::Path(path.clone()),
        Replacement {
            size: Some(new_size),
            warp: WarpPolicy::Auto,
            frame: FramePolicy::KeepScale,
            ..Replacement::new(&data, name)
        },
    )
    .expect("auto resize");

    assert!(
        warp_of(&psd, &path).is_none(),
        "Auto + size change clears placed.warp for writer synthesis"
    );

    let written = write_psd(&psd, &write_opts()).expect("write");
    let again = read_psd(&written, &read_opts()).expect("re-read");
    let warp = warp_of(&again, &path).expect("writer synthesises warp");
    assert!(
        is_identity_warp_mesh(&warp, new_size.0 as f64, new_size.1 as f64),
        "re-read warp must be identity for the new domain"
    );
}

#[test]
fn reset_clears_model_rereads_as_identity_and_can_change_bytes() {
    let Some(src_bytes) = read_write_src("smart") else {
        eprintln!("skip: smart missing");
        return;
    };
    let mut psd = read_psd(&src_bytes, &read_opts()).expect("read");
    let (path, linked_id, name) = first_smart(&psd);
    let placed = layer_at(&psd, &path)
        .additional_info
        .placed_layer
        .as_ref()
        .unwrap();
    let (w, h) = (placed.width.unwrap(), placed.height.unwrap());
    let data = linked_data(&psd, &linked_id)
        .expect("embedded data")
        .to_vec();

    // Perturb stored warp encoding while keeping an identity mesh: Reset must
    // drop this and let the writer synthesise a clean identity (documented as
    // not a byte no-op; one corpus clear grew a file by ~808 bytes).
    {
        let warp = layer_at(&psd, &path)
            .additional_info
            .placed_layer
            .as_ref()
            .unwrap()
            .warp
            .as_ref()
            .unwrap()
            .clone();
        let mut noisy = warp;
        noisy.values = Some(vec![0.0, 1.0, 2.0, 3.0]);
        noisy.value = None;
        psd.children.as_mut().unwrap()[path[0]]
            .additional_info
            .placed_layer
            .as_mut()
            .unwrap()
            .warp = Some(noisy);
    }

    let keep_bytes = {
        let mut keep_psd = psd.clone();
        replace_smart_object(
            &mut keep_psd,
            &LayerTarget::Path(path.clone()),
            Replacement {
                warp: WarpPolicy::Keep,
                ..Replacement::new(&data, name.clone())
            },
        )
        .expect("keep");
        write_psd(&keep_psd, &write_opts()).expect("write keep")
    };

    replace_smart_object(
        &mut psd,
        &LayerTarget::Path(path.clone()),
        Replacement {
            warp: WarpPolicy::Reset,
            ..Replacement::new(&data, name)
        },
    )
    .expect("reset");

    assert!(warp_of(&psd, &path).is_none());
    let written = write_psd(&psd, &write_opts()).expect("write reset");
    assert_ne!(
        written, keep_bytes,
        "Reset re-synthesis must differ from keeping a non-canonical warp encoding"
    );

    let again = read_psd(&written, &read_opts()).expect("re-read");
    let warp = warp_of(&again, &path).expect("synthesised");
    assert!(is_identity_warp_mesh(&warp, w, h));
}

#[test]
fn keep_preserves_warp_mesh_bytes_across_resize() {
    let Some(mut psd) = load_from_src("smart") else {
        eprintln!("skip: smart missing");
        return;
    };
    let (path, linked_id, name) = first_smart(&psd);
    let before = mesh_bytes(&warp_of(&psd, &path)).expect("mesh");
    let data = linked_data(&psd, &linked_id)
        .expect("embedded data")
        .to_vec();
    let placed = layer_at(&psd, &path)
        .additional_info
        .placed_layer
        .as_ref()
        .unwrap();
    let old_w = placed.width.unwrap().round() as u32;
    let old_h = placed.height.unwrap().round() as u32;

    replace_smart_object(
        &mut psd,
        &LayerTarget::Path(path.clone()),
        Replacement {
            size: Some((old_w + 16, old_h + 16)),
            warp: WarpPolicy::Keep,
            frame: FramePolicy::KeepFrame,
            ..Replacement::new(&data, name)
        },
    )
    .expect("keep");

    let after = mesh_bytes(&warp_of(&psd, &path)).expect("warp kept");
    assert_eq!(
        before, after,
        "Keep must leave mesh bits unchanged after resize"
    );
}

#[test]
fn float_rect_bounds_warp_is_read_only_on_reset() {
    let Some(mut psd) = load_from_src("smart-filters-2") else {
        eprintln!("skip: smart-filters-2 missing");
        return;
    };
    let infos = find_smart_objects(&psd, &LayerTarget::Path(vec![]));
    let info = infos
        .iter()
        .find(|i| i.has_embedded_data && !i.shared && !i.is_external)
        .expect("exclusive embedded smart object");
    let warp = warp_of(&psd, &info.path).expect("warp");
    assert_eq!(
        warp.bounds_class_id.as_deref(),
        Some("classFloatRect"),
        "fixture must carry modern float-rect bounds"
    );
    let data = linked_data(&psd, &info.linked_id)
        .expect("embedded data")
        .to_vec();
    let name = info.file_name.clone().unwrap_or_else(|| "asset".into());

    let err = replace_smart_object(
        &mut psd,
        &LayerTarget::Path(info.path.clone()),
        Replacement {
            warp: WarpPolicy::Reset,
            ..Replacement::new(&data, name.clone())
        },
    )
    .unwrap_err();
    assert!(
        matches!(err, SmartObjectError::WarpFloatRectReadOnly),
        "got {err}"
    );
    assert!(
        err.to_string().contains("classFloatRect"),
        "error should name the bounds class: {err}"
    );

    // Auto + size change also mutates warp → same refusal.
    let (ow, oh) = (
        info.width.unwrap().round() as u32,
        info.height.unwrap().round() as u32,
    );
    let err = replace_smart_object(
        &mut psd,
        &LayerTarget::Path(info.path.clone()),
        Replacement {
            size: Some((ow + 4, oh + 4)),
            warp: WarpPolicy::Auto,
            frame: FramePolicy::KeepScale,
            ..Replacement::new(&data, name)
        },
    )
    .unwrap_err();
    assert!(matches!(err, SmartObjectError::WarpFloatRectReadOnly));
}

fn minimal_rgb_doc() -> Psd {
    Psd {
        width: 8.0,
        height: 8.0,
        color_mode: Some(ColorMode::Rgb),
        bits_per_channel: Some(8.0),
        image_data: Some(PixelData::rgba8(8, 8, vec![0u8; 8 * 8 * 4])),
        ..Psd::default()
    }
}

fn attach_placed(psd: &mut Psd, linked_id: &str, w: u32, h: u32) {
    psd.children = Some(vec![placed_layer(
        linked_id,
        "aa5448f7-350c-11eb-b49a-c15674f50bc4",
        w,
        h,
    )]);
}

fn placed_layer(linked_id: &str, placed_id: &str, w: u32, h: u32) -> Layer {
    Layer {
        additional_info: LayerAdditionalInfo {
            name: Some("so".into()),
            id: Some(3.0),
            placed_layer: Some(PlacedLayer {
                id: linked_id.into(),
                placed: Some(placed_id.into()),
                width: Some(w as f64),
                height: Some(h as f64),
                transform: vec![0.0, 0.0, w as f64, 0.0, w as f64, h as f64, 0.0, h as f64],
                ..PlacedLayer::default()
            }),
            ..LayerAdditionalInfo::default()
        },
        top: Some(0.0),
        left: Some(0.0),
        bottom: Some(h as f64),
        right: Some(w as f64),
        image_data: Some(PixelData::rgba8(w, h, vec![0u8; (w * h * 4) as usize])),
        ..Layer::default()
    }
}

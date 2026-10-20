//! Smart-object replace preview policy.
//!
//! Three strategies: Leave (default), Provide, Drop. Report always marks
//! preview / composite / thumbnail stale; document composite and thumbnail
//! bytes are never cleared by replace.

use psdx::psd::{
    ChannelId, ColorMode, Compression, Layer, LayerAdditionalInfo, LayerRawData,
    LayerRawDataChannel, LinkedFile, PixelData, PlacedLayer, PlacedLayerType, Psd, WriteOptions,
};
use psdx::smart_object::{
    FramePolicy, LayerTarget, PreviewPolicy, ReplaceScope, Replacement, SmartObjectError,
    WarpPolicy, replace_smart_object,
};
use psdx::write_psd;

fn linked_id() -> String {
    "20953ddb-9391-11ec-b4f1-c15674f50bc4".into()
}

fn placed_id() -> String {
    "aa5448f7-350c-11eb-b49a-c15674f50bc4".into()
}

fn minimal_doc(layer_w: u32, layer_h: u32, fill: u8) -> Psd {
    let id = linked_id();
    let data = vec![0xAAu8; 64];
    let mut layer = Layer {
        additional_info: LayerAdditionalInfo {
            name: Some("so".into()),
            id: Some(3.0),
            placed_layer: Some(PlacedLayer {
                id: id.clone(),
                placed: Some(placed_id()),
                layer_type: Some(PlacedLayerType::Raster),
                width: Some(layer_w as f64),
                height: Some(layer_h as f64),
                transform: vec![
                    0.0,
                    0.0,
                    layer_w as f64,
                    0.0,
                    layer_w as f64,
                    layer_h as f64,
                    0.0,
                    layer_h as f64,
                ],
                ..PlacedLayer::default()
            }),
            ..LayerAdditionalInfo::default()
        },
        top: Some(4.0),
        left: Some(2.0),
        bottom: Some(4.0 + layer_h as f64),
        right: Some(2.0 + layer_w as f64),
        image_data: Some(PixelData::rgba8(
            layer_w,
            layer_h,
            vec![fill; (layer_w * layer_h * 4) as usize],
        )),
        ..Layer::default()
    };
    // Distinct non-zero preview so Leave can prove byte identity.
    if let Some(img) = layer.image_data.as_mut() {
        for (i, b) in img.data.iter_mut().enumerate() {
            *b = fill.wrapping_add((i % 251) as u8);
        }
    }

    Psd {
        width: 32.0,
        height: 32.0,
        color_mode: Some(ColorMode::Rgb),
        bits_per_channel: Some(8.0),
        image_data: Some(PixelData::rgba8(32, 32, vec![0x11; 32 * 32 * 4])),
        image_resources: Some(psdx::psd::ImageResources {
            thumbnail: Some(PixelData::rgba8(8, 8, vec![0x22; 8 * 8 * 4])),
            ..Default::default()
        }),
        linked_files: Some(vec![LinkedFile {
            id,
            name: "asset.bin".into(),
            data: Some(data),
            ..LinkedFile::default()
        }]),
        children: Some(vec![layer]),
        ..Psd::default()
    }
}

fn layer0(psd: &Psd) -> &Layer {
    &psd.children.as_ref().unwrap()[0]
}

fn layer0_mut(psd: &mut Psd) -> &mut Layer {
    &mut psd.children.as_mut().unwrap()[0]
}

fn assert_stale_report(report: &psdx::smart_object::ReplaceReport) {
    assert!(report.preview_stale, "preview must be marked stale");
    assert!(report.composite_stale, "composite must be marked stale");
    assert!(report.thumbnail_stale, "thumbnail must be marked stale");
}

fn snapshot_doc_derivatives(psd: &Psd) -> (Vec<u8>, Vec<u8>) {
    let composite = psd
        .image_data
        .as_ref()
        .map(|p| p.data.clone())
        .unwrap_or_default();
    let thumb = psd
        .image_resources
        .as_ref()
        .and_then(|r| r.thumbnail.as_ref())
        .map(|p| p.data.clone())
        .unwrap_or_default();
    (composite, thumb)
}

fn assert_doc_derivatives_untouched(psd: &Psd, before: &(Vec<u8>, Vec<u8>)) {
    let composite = psd
        .image_data
        .as_ref()
        .map(|p| p.data.as_slice())
        .unwrap_or(&[]);
    let thumb = psd
        .image_resources
        .as_ref()
        .and_then(|r| r.thumbnail.as_ref())
        .map(|p| p.data.as_slice())
        .unwrap_or(&[]);
    assert_eq!(
        composite,
        before.0.as_slice(),
        "document composite must be untouched"
    );
    assert_eq!(
        thumb,
        before.1.as_slice(),
        "document thumbnail must be untouched"
    );
}

fn assert_pixel_data_eq(got: &Option<PixelData>, want: &Option<PixelData>) {
    match (got, want) {
        (None, None) => {}
        (Some(a), Some(b)) => {
            assert_eq!((a.width, a.height, a.depth), (b.width, b.height, b.depth));
            assert_eq!(a.data, b.data);
        }
        _ => panic!("pixel presence mismatch: got_is_some={}", got.is_some()),
    }
}

fn flip_linked(psd: &mut Psd) -> Vec<u8> {
    let data = psd.linked_files.as_ref().unwrap()[0]
        .data
        .as_ref()
        .unwrap()
        .clone();
    let mut new_data = data;
    let at = new_data.len() / 2;
    new_data[at] ^= 0x5A;
    new_data
}

#[test]
fn leave_keeps_layer_pixels_and_bounds_bytewise() {
    let mut psd = minimal_doc(6, 4, 0x40);
    let before_img = layer0(&psd).image_data.clone();
    let before_bounds = (
        layer0(&psd).left,
        layer0(&psd).top,
        layer0(&psd).right,
        layer0(&psd).bottom,
    );
    let derivatives = snapshot_doc_derivatives(&psd);
    let new_data = flip_linked(&mut psd);

    let report = replace_smart_object(
        &mut psd,
        &LayerTarget::Path(vec![0]),
        Replacement {
            size: Some((6, 4)),
            preview: PreviewPolicy::Leave,
            ..Replacement::new(&new_data, "asset.bin")
        },
    )
    .expect("Leave replace");

    assert_stale_report(&report);
    assert_doc_derivatives_untouched(&psd, &derivatives);
    assert_pixel_data_eq(&layer0(&psd).image_data, &before_img);
    assert_eq!(
        (
            layer0(&psd).left,
            layer0(&psd).top,
            layer0(&psd).right,
            layer0(&psd).bottom
        ),
        before_bounds
    );
}

#[test]
fn leave_is_default_preview_policy() {
    let mut psd = minimal_doc(3, 3, 0x55);
    let before = layer0(&psd).image_data.clone();
    let new_data = flip_linked(&mut psd);
    let report = replace_smart_object(
        &mut psd,
        &LayerTarget::Path(vec![0]),
        Replacement {
            size: Some((3, 3)),
            ..Replacement::new(&new_data, "asset.bin")
        },
    )
    .unwrap();
    assert_stale_report(&report);
    assert_pixel_data_eq(&layer0(&psd).image_data, &before);
}

#[test]
fn drop_keeps_rect_and_installs_transparent_pixels() {
    let mut psd = minimal_doc(5, 3, 0x7F);
    let before_bounds = (
        layer0(&psd).left,
        layer0(&psd).top,
        layer0(&psd).right,
        layer0(&psd).bottom,
    );
    let derivatives = snapshot_doc_derivatives(&psd);
    let new_data = flip_linked(&mut psd);

    let report = replace_smart_object(
        &mut psd,
        &LayerTarget::Path(vec![0]),
        Replacement {
            size: Some((5, 3)),
            preview: PreviewPolicy::Drop,
            ..Replacement::new(&new_data, "asset.bin")
        },
    )
    .expect("Drop replace");

    assert_stale_report(&report);
    assert_doc_derivatives_untouched(&psd, &derivatives);
    assert_eq!(
        (
            layer0(&psd).left,
            layer0(&psd).top,
            layer0(&psd).right,
            layer0(&psd).bottom
        ),
        before_bounds,
        "Drop must keep layer rect (not zero-size collapse)"
    );
    let img = layer0(&psd).image_data.as_ref().expect("pixels");
    assert_eq!((img.width, img.height), (5, 3));
    assert!(
        img.data.iter().all(|&b| b == 0),
        "Drop must install fully transparent pixels"
    );
    assert!(layer0(&psd).raw_data.is_none());
}

#[test]
fn provide_sets_bounds_to_provided_size() {
    let mut psd = minimal_doc(6, 4, 0x33);
    let derivatives = snapshot_doc_derivatives(&psd);
    let new_data = flip_linked(&mut psd);
    let (pw, ph) = (2u32, 5u32);
    let mut rgba = vec![0u8; (pw * ph * 4) as usize];
    for (i, px) in rgba.chunks_exact_mut(4).enumerate() {
        px[0] = i as u8;
        px[1] = 10;
        px[2] = 20;
        px[3] = 255;
    }

    let report = replace_smart_object(
        &mut psd,
        &LayerTarget::Path(vec![0]),
        Replacement {
            size: Some((6, 4)),
            preview: PreviewPolicy::Provide {
                width: pw,
                height: ph,
                rgba: rgba.clone(),
            },
            ..Replacement::new(&new_data, "asset.bin")
        },
    )
    .expect("Provide replace");

    assert_stale_report(&report);
    assert_doc_derivatives_untouched(&psd, &derivatives);
    let layer = layer0(&psd);
    assert_eq!(layer.left, Some(2.0));
    assert_eq!(layer.top, Some(4.0));
    assert_eq!(layer.right, Some(2.0 + pw as f64));
    assert_eq!(layer.bottom, Some(4.0 + ph as f64));
    let img = layer.image_data.as_ref().unwrap();
    assert_eq!((img.width, img.height), (pw, ph));
    assert_eq!(img.data, rgba);
}

#[test]
fn provide_rejects_wrong_buffer_length() {
    let mut psd = minimal_doc(2, 2, 0x01);
    let before = psd.linked_files.as_ref().unwrap()[0]
        .data
        .as_ref()
        .unwrap()
        .clone();
    let err = replace_smart_object(
        &mut psd,
        &LayerTarget::Path(vec![0]),
        Replacement {
            size: Some((2, 2)),
            preview: PreviewPolicy::Provide {
                width: 2,
                height: 2,
                rgba: vec![0u8; 7],
            },
            ..Replacement::new(&before, "asset.bin")
        },
    )
    .unwrap_err();
    assert!(matches!(
        err,
        SmartObjectError::InvalidPreviewBuffer {
            expected: 16,
            got: 7
        }
    ));
    // Failed validation must not mutate linked bytes.
    assert_eq!(
        psd.linked_files.as_ref().unwrap()[0].data.as_ref().unwrap(),
        &before
    );
}

#[test]
fn late_preview_failure_is_atomic_and_preserves_prior_success() {
    let mut psd = minimal_doc(2, 2, 0x31);
    let first_data = flip_linked(&mut psd);
    replace_smart_object(
        &mut psd,
        &LayerTarget::Path(vec![0]),
        Replacement {
            size: Some((2, 2)),
            ..Replacement::new(&first_data, "first-success.bin")
        },
    )
    .expect("first replacement succeeds");

    layer0_mut(&mut psd).raw_data = Some(LayerRawData {
        color_mode: ColorMode::Rgb,
        bits_per_channel: 8.0,
        large: false,
        channels: vec![LayerRawDataChannel {
            id: ChannelId::UserMask as i16,
            compression: Compression::RawData,
            data: Some(vec![0, 0, 0, 0]),
        }],
    });

    let before_structure = serde_json::to_value(&psd).expect("snapshot document");
    let before_bytes = write_psd(&psd, &WriteOptions::default()).expect("write pre-failure");
    let prior_success_data = psd.linked_files.as_ref().unwrap()[0]
        .data
        .as_ref()
        .unwrap()
        .clone();
    let mut failing_data = prior_success_data.clone();
    failing_data[0] ^= 0x7f;

    let err = replace_smart_object(
        &mut psd,
        &LayerTarget::Path(vec![0]),
        Replacement {
            size: Some((2, 2)),
            preview: PreviewPolicy::Provide {
                width: 2,
                height: 2,
                rgba: vec![0x44; 2 * 2 * 4],
            },
            ..Replacement::new(&failing_data, "must-not-apply.bin")
        },
    )
    .expect_err("raw preview materialization must fail");

    assert!(matches!(err, SmartObjectError::PreviewApplyFailed(_)));
    assert_eq!(
        serde_json::to_value(&psd).expect("snapshot after failure"),
        before_structure,
        "every observable document field must remain unchanged"
    );
    assert_eq!(
        write_psd(&psd, &WriteOptions::default()).expect("write post-failure"),
        before_bytes,
        "failed replacement must preserve serialized bytes"
    );
    assert_eq!(
        psd.linked_files.as_ref().unwrap()[0].data.as_deref(),
        Some(prior_success_data.as_slice()),
        "the earlier successful replacement must survive the later failure"
    );
}

#[test]
fn all_policies_leave_composite_and_thumbnail_untouched() {
    for policy in [
        PreviewPolicy::Leave,
        PreviewPolicy::Drop,
        PreviewPolicy::Provide {
            width: 3,
            height: 3,
            rgba: vec![0xAB; 3 * 3 * 4],
        },
    ] {
        let mut psd = minimal_doc(3, 3, 0x90);
        let derivatives = snapshot_doc_derivatives(&psd);
        let new_data = flip_linked(&mut psd);
        let report = replace_smart_object(
            &mut psd,
            &LayerTarget::Path(vec![0]),
            Replacement {
                size: Some((3, 3)),
                preview: policy.clone(),
                ..Replacement::new(&new_data, "asset.bin")
            },
        )
        .unwrap_or_else(|e| panic!("policy {policy:?}: {e}"));
        assert_stale_report(&report);
        assert_doc_derivatives_untouched(&psd, &derivatives);
        // Replace must keep Options present (not clear to None).
        assert!(psd.image_data.is_some());
        assert!(
            psd.image_resources
                .as_ref()
                .and_then(|r| r.thumbnail.as_ref())
                .is_some()
        );
    }
}

#[test]
fn drop_does_not_collapse_zero_size_when_rect_nonzero() {
    let mut psd = minimal_doc(4, 2, 0xEE);
    // Force a non-square offset rect that Drop must preserve exactly.
    {
        let layer = layer0_mut(&mut psd);
        layer.left = Some(10.0);
        layer.top = Some(20.0);
        layer.right = Some(14.0);
        layer.bottom = Some(22.0);
    }
    let new_data = flip_linked(&mut psd);
    replace_smart_object(
        &mut psd,
        &LayerTarget::Path(vec![0]),
        Replacement {
            size: Some((4, 2)),
            preview: PreviewPolicy::Drop,
            ..Replacement::new(&new_data, "asset.bin")
        },
    )
    .unwrap();
    let layer = layer0(&psd);
    assert_eq!(layer.left, Some(10.0));
    assert_eq!(layer.top, Some(20.0));
    assert_eq!(layer.right, Some(14.0));
    assert_eq!(layer.bottom, Some(22.0));
    let img = layer.image_data.as_ref().unwrap();
    assert_ne!((img.width, img.height), (0, 0));
    assert_eq!((img.width, img.height), (4, 2));
}

#[test]
fn preview_apply_preserves_resize_fork_warp_and_resolution_placement_updates() {
    for preview in [
        PreviewPolicy::Drop,
        PreviewPolicy::Provide {
            width: 3,
            height: 2,
            rgba: vec![0x6d; 3 * 2 * 4],
        },
    ] {
        let old_id = linked_id();
        let mut psd = minimal_doc(4, 4, 0x52);
        let mut other = layer0(&psd).clone();
        other.additional_info.name = Some("other".into());
        other.additional_info.id = Some(4.0);
        other.additional_info.placed_layer.as_mut().unwrap().placed =
            Some("aa5448f8-350c-11eb-b49a-c15674f50bc4".into());
        psd.children.as_mut().unwrap().push(other);
        let new_data = flip_linked(&mut psd);
        let report = replace_smart_object(
            &mut psd,
            &LayerTarget::Path(vec![0]),
            Replacement {
                size: Some((8, 6)),
                frame: FramePolicy::Exact([10.0, 20.0, 18.0, 20.0, 18.0, 26.0, 10.0, 26.0]),
                warp: WarpPolicy::Auto,
                resolution: Some(144.0),
                scope: ReplaceScope::ThisLayerOnly,
                preview,
                ..Replacement::new(&new_data, "forked.bin")
            },
        )
        .expect("combined replacement");

        let target = layer0(&psd);
        let placed = target.additional_info.placed_layer.as_ref().unwrap();
        assert_ne!(
            report.linked_id, old_id,
            "target must use forked linked file"
        );
        assert_eq!(placed.id, report.linked_id);
        assert_eq!(placed.width, Some(8.0));
        assert_eq!(placed.height, Some(6.0));
        assert_eq!(
            placed.transform,
            vec![10.0, 20.0, 18.0, 20.0, 18.0, 26.0, 10.0, 26.0]
        );
        assert!(
            placed.warp.is_none(),
            "resize-driven warp reset must survive preview apply"
        );
        assert_eq!(
            placed
                .resolution
                .as_ref()
                .map(|resolution| resolution.value),
            Some(144.0)
        );
        assert_eq!(
            psd.children.as_ref().unwrap()[1]
                .additional_info
                .placed_layer
                .as_ref()
                .unwrap()
                .id,
            old_id,
            "other placement must remain on the original linked file"
        );
    }
}

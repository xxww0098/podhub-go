use super::{read_image_resource, write_image_resource};
use crate::psd::*;
use crate::reader::{PsdReader, check_signature, read_uint16, read_uint32};
use crate::writer::{create_writer, write_section, write_signature, write_uint16};

/// Mirror the resource-block framing: signature '8BIM', id (u16), pascal name,
/// size (u32), then padded-to-even payload. Used to test framing round-trip.
fn write_block(id: u16, name: &str, target: &ImageResources, index: usize) -> Vec<u8> {
    let mut w = create_writer(256);
    write_signature(&mut w, "8BIM").expect("signature");
    write_uint16(&mut w, id);
    // pascal name padded to 2 (mirror writePascalString(name, 2)).
    crate::writer::write_pascal_string(&mut w, name, 2).expect("pascal string");
    write_section(
        &mut w,
        2,
        |w| {
            write_image_resource(id, w, target, index).unwrap();
            Ok(())
        },
        false,
        false,
    )
    .expect("write_block section");
    w.to_bytes()
}

/// Read back a framed block, returning (id, remaining payload consumed via handler).
fn read_block(bytes: &[u8]) -> ImageResources {
    let mut r = PsdReader::new(bytes, None, None);
    check_signature(&mut r, "8BIM", None).unwrap();
    let id = read_uint16(&mut r).unwrap();
    let _name = crate::reader::read_pascal_string(&mut r, 2).unwrap();
    let mut target = ImageResources::default();
    // read the section length, then dispatch with `left`.
    let len = read_uint32(&mut r).unwrap() as usize;
    let payload_start = r.offset;
    read_image_resource(id, &mut r, &mut target, len).unwrap();
    // advance to padded end (pad-to-even)
    let mut end = payload_start + len;
    if len % 2 != 0 {
        end += 1;
    }
    r.offset = end;
    target
}

#[test]
fn resolution_info_round_trip() {
    let mut target = ImageResources::default();
    target.resolution_info = Some(ResolutionInfo {
        horizontal_resolution: 300.0,
        horizontal_resolution_unit: ResolutionUnit::Ppi,
        width_unit: DimensionUnit::Inches,
        vertical_resolution: 300.0,
        vertical_resolution_unit: ResolutionUnit::Ppcm,
        height_unit: DimensionUnit::Centimeters,
    });

    let mut w = create_writer(64);
    write_image_resource(1005, &mut w, &target, 0).unwrap();
    let bytes = w.to_bytes();

    let mut r = PsdReader::new(&bytes, None, None);
    let mut out = ImageResources::default();
    read_image_resource(1005, &mut r, &mut out, bytes.len()).unwrap();

    let a = target.resolution_info.unwrap();
    let b = out.resolution_info.unwrap();
    assert_eq!(a.horizontal_resolution, b.horizontal_resolution);
    assert_eq!(a.horizontal_resolution_unit, b.horizontal_resolution_unit);
    assert_eq!(a.width_unit, b.width_unit);
    assert_eq!(a.vertical_resolution, b.vertical_resolution);
    assert_eq!(a.vertical_resolution_unit, b.vertical_resolution_unit);
    assert_eq!(a.height_unit, b.height_unit);
}

#[test]
fn xmp_metadata_string_round_trip() {
    let mut target = ImageResources::default();
    target.xmp_metadata = Some("<x:xmpmeta>data</x:xmpmeta>".to_string());

    let mut w = create_writer(64);
    write_image_resource(1060, &mut w, &target, 0).unwrap();
    let bytes = w.to_bytes();

    let mut r = PsdReader::new(&bytes, None, None);
    let mut out = ImageResources::default();
    read_image_resource(1060, &mut r, &mut out, bytes.len()).unwrap();
    assert_eq!(out.xmp_metadata, target.xmp_metadata);
}

#[test]
fn caption_digest_round_trip() {
    let mut target = ImageResources::default();
    target.caption_digest = Some("0123456789abcdef0123456789abcdef".to_string());

    let mut w = create_writer(64);
    write_image_resource(1061, &mut w, &target, 0).unwrap();
    let bytes = w.to_bytes();
    assert_eq!(bytes.len(), 16);

    let mut r = PsdReader::new(&bytes, None, None);
    let mut out = ImageResources::default();
    read_image_resource(1061, &mut r, &mut out, bytes.len()).unwrap();
    assert_eq!(out.caption_digest, target.caption_digest);
}

#[test]
fn framing_odd_length_pad() {
    // url resource: ASCII string of odd length forces pad-to-even on the block.
    let mut target = ImageResources::default();
    target.url = Some("abc".to_string()); // 3 bytes -> needs 1 pad byte

    let bytes = write_block(1035, "", &target, 0);
    // Find the section length and assert payload is padded to even.
    // Layout: 4 (8BIM) + 2 (id) + pascal name (1 len byte + 0 chars + 1 pad = 2)
    //         + 4 (size) + payload(3) + pad(1)
    let header = 4 + 2 + 2 + 4;
    let payload_len = 3usize;
    assert_eq!(bytes.len(), header + payload_len + 1); // +1 pad to even

    let out = read_block(&bytes);
    assert_eq!(out.url, target.url);
}

#[test]
fn print_scale_round_trip() {
    let mut target = ImageResources::default();
    target.print_scale = Some(PrintScale {
        style: Some(PrintScaleStyle::UserDefined),
        x: Some(1.5),
        y: Some(2.5),
        scale: Some(0.75),
    });

    let mut w = create_writer(64);
    write_image_resource(1062, &mut w, &target, 0).unwrap();
    let bytes = w.to_bytes();

    let mut r = PsdReader::new(&bytes, None, None);
    let mut out = ImageResources::default();
    read_image_resource(1062, &mut r, &mut out, bytes.len()).unwrap();
    let p = out.print_scale.unwrap();
    assert_eq!(p.style, Some(PrintScaleStyle::UserDefined));
    assert_eq!(p.x, Some(1.5));
    assert_eq!(p.y, Some(2.5));
    assert!((p.scale.unwrap() - 0.75).abs() < 1e-6);
}

#[test]
fn version_info_round_trip() {
    let mut target = ImageResources::default();
    target.version_info = Some(VersionInfo {
        has_real_merged_data: true,
        writer_name: "ag-psd".to_string(),
        reader_name: "ag-psd".to_string(),
        file_version: 1.0,
    });

    let mut w = create_writer(64);
    write_image_resource(1057, &mut w, &target, 0).unwrap();
    let bytes = w.to_bytes();

    let mut r = PsdReader::new(&bytes, None, None);
    let mut out = ImageResources::default();
    read_image_resource(1057, &mut r, &mut out, bytes.len()).unwrap();
    let v = out.version_info.unwrap();
    assert!(v.has_real_merged_data);
    assert_eq!(v.writer_name, "ag-psd");
    assert_eq!(v.reader_name, "ag-psd");
    assert_eq!(v.file_version, 1.0);
}

#[test]
fn grid_and_guides_round_trip() {
    let mut target = ImageResources::default();
    target.grid_and_guides_information = Some(GridAndGuidesInformation {
        grid: Some(GridInfo {
            horizontal: 576.0,
            vertical: 576.0,
        }),
        guides: Some(vec![
            GuideInfo {
                location: 10.0,
                direction: GuideDirection::Horizontal,
            },
            GuideInfo {
                location: 20.0,
                direction: GuideDirection::Vertical,
            },
        ]),
    });

    let mut w = create_writer(64);
    write_image_resource(1032, &mut w, &target, 0).unwrap();
    let bytes = w.to_bytes();

    let mut r = PsdReader::new(&bytes, None, None);
    let mut out = ImageResources::default();
    read_image_resource(1032, &mut r, &mut out, bytes.len()).unwrap();
    let info = out.grid_and_guides_information.unwrap();
    let grid = info.grid.unwrap();
    assert_eq!(grid.horizontal, 576.0);
    assert_eq!(grid.vertical, 576.0);
    let guides = info.guides.unwrap();
    assert_eq!(guides.len(), 2);
    assert_eq!(guides[0].location, 10.0);
    assert_eq!(guides[0].direction, GuideDirection::Horizontal);
    assert_eq!(guides[1].direction, GuideDirection::Vertical);
}

#[test]
fn alpha_identifiers_round_trip() {
    let mut target = ImageResources::default();
    target.alpha_identifiers = Some(vec![1.0, 2.0, 3.0]);

    let mut w = create_writer(64);
    write_image_resource(1053, &mut w, &target, 0).unwrap();
    let bytes = w.to_bytes();

    let mut r = PsdReader::new(&bytes, None, None);
    let mut out = ImageResources::default();
    read_image_resource(1053, &mut r, &mut out, bytes.len()).unwrap();
    assert_eq!(out.alpha_identifiers, Some(vec![1.0, 2.0, 3.0]));
}

#[test]
fn url_list_round_trip() {
    let mut target = ImageResources::default();
    target.urls_list = Some(vec![UrlListItem {
        id: 7.0,
        r#ref: "slice".to_string(),
        url: "http://example.com".to_string(),
    }]);

    let mut w = create_writer(128);
    write_image_resource(1054, &mut w, &target, 0).unwrap();
    let bytes = w.to_bytes();

    let mut r = PsdReader::new(&bytes, None, None);
    let mut out = ImageResources::default();
    read_image_resource(1054, &mut r, &mut out, bytes.len()).unwrap();
    let list = out.urls_list.unwrap();
    assert_eq!(list.len(), 1);
    assert_eq!(list[0].id, 7.0);
    assert_eq!(list[0].url, "http://example.com");
    assert_eq!(list[0].r#ref, "slice");
}

#[test]
fn pixel_aspect_ratio_round_trip() {
    let mut target = ImageResources::default();
    target.pixel_aspect_ratio = Some(PixelAspectRatio { aspect: 1.25 });

    let mut w = create_writer(64);
    write_image_resource(1064, &mut w, &target, 0).unwrap();
    let bytes = w.to_bytes();

    let mut r = PsdReader::new(&bytes, None, None);
    let mut out = ImageResources::default();
    read_image_resource(1064, &mut r, &mut out, bytes.len()).unwrap();
    assert_eq!(out.pixel_aspect_ratio.unwrap().aspect, 1.25);
}

#[test]
fn animations_round_trip() {
    let mut target = ImageResources::default();
    target.animations = Some(Animations {
        frames: vec![
            AnimationFrameInfo {
                id: 1.0,
                delay: 0.1,
                dispose: Some(AnimationDispose::Auto),
            },
            AnimationFrameInfo {
                id: 2.0,
                delay: 0.0,
                dispose: Some(AnimationDispose::None),
            },
        ],
        animations: vec![AnimationInfo {
            id: 10.0,
            frames: vec![1.0, 2.0],
            repeats: Some(3.0),
            active_frame: Some(1.0),
        }],
    });

    let mut w = create_writer(512);
    write_image_resource(4000, &mut w, &target, 0).unwrap();
    let bytes = w.to_bytes();

    let mut r = PsdReader::new(&bytes, None, None);
    let mut out = ImageResources::default();
    read_image_resource(4000, &mut r, &mut out, bytes.len()).unwrap();
    let a = out.animations.unwrap();
    assert_eq!(a.frames.len(), 2);
    assert_eq!(a.frames[0].id, 1.0);
    assert!((a.frames[0].delay - 0.1).abs() < 1e-6);
    assert_eq!(a.frames[1].dispose, Some(AnimationDispose::None));
    assert_eq!(a.animations.len(), 1);
    assert_eq!(a.animations[0].id, 10.0);
    assert_eq!(a.animations[0].frames, vec![1.0, 2.0]);
    assert_eq!(a.animations[0].repeats, Some(3.0));
}

#[test]
fn slices_round_trip() {
    let mut target = ImageResources::default();
    target.slices = Some(vec![SliceGroup {
        bounds: LtrbBounds {
            left: 0.0,
            top: 0.0,
            right: 100.0,
            bottom: 80.0,
        },
        group_name: "group".to_string(),
        slices: vec![Slice {
            id: 1.0,
            group_id: 0.0,
            origin: Some(SliceOrigin::UserGenerated),
            associated_layer_id: 0.0,
            name: Some("slice 1".to_string()),
            slice_type: Some(SliceType::Image),
            bounds: LtrbBounds {
                left: 1.0,
                top: 2.0,
                right: 3.0,
                bottom: 4.0,
            },
            url: "u".to_string(),
            target: "t".to_string(),
            message: "m".to_string(),
            alt_tag: "a".to_string(),
            cell_text_is_html: true,
            cell_text: "c".to_string(),
            horizontal_alignment: Some(SliceAlignment::Default),
            vertical_alignment: Some(SliceAlignment::Default),
            background_color_type: Some(SliceBackgroundColorType::None),
            background_color: Rgba {
                r: 0.0,
                g: 0.0,
                b: 0.0,
                a: 0.0,
            },
            top_outset: None,
            left_outset: None,
            bottom_outset: None,
            right_outset: None,
        }],
    }]);

    let mut w = create_writer(1024);
    write_image_resource(1050, &mut w, &target, 0).unwrap();
    let bytes = w.to_bytes();

    let mut r = PsdReader::new(&bytes, None, None);
    let mut out = ImageResources::default();
    read_image_resource(1050, &mut r, &mut out, bytes.len()).unwrap();
    let groups = out.slices.unwrap();
    assert_eq!(groups.len(), 1);
    let g = &groups[0];
    assert_eq!(g.group_name, "group");
    assert_eq!(g.bounds.right, 100.0);
    assert_eq!(g.slices.len(), 1);
    let s = &g.slices[0];
    assert_eq!(s.id, 1.0);
    assert_eq!(s.name.as_deref(), Some("slice 1"));
    assert_eq!(s.slice_type, Some(SliceType::Image));
    assert_eq!(s.url, "u");
    assert_eq!(s.cell_text_is_html, true);
    assert_eq!(s.bounds.left, 1.0);
    assert_eq!(s.bounds.bottom, 4.0);
}

#[test]
fn print_information_round_trip() {
    let mut target = ImageResources::default();
    target.print_information = Some(PrintInformation {
        printer_manages_colors: None,
        printer_name: Some("My Printer".to_string()),
        printer_profile: Some("sRGB".to_string()),
        print_sixteen_bit: Some(false),
        rendering_intent: Some(RenderingIntent::RelativeColorimetric),
        hard_proof: Some(true),
        black_point_compensation: Some(true),
        proof_setup: Some(ProofSetup::Builtin {
            builtin: "proofCMYK".to_string(),
        }),
    });

    let mut w = create_writer(512);
    write_image_resource(1082, &mut w, &target, 0).unwrap();
    let bytes = w.to_bytes();

    let mut r = PsdReader::new(&bytes, None, None);
    let mut out = ImageResources::default();
    read_image_resource(1082, &mut r, &mut out, bytes.len()).unwrap();
    let info = out.print_information.unwrap();
    assert_eq!(info.printer_name.as_deref(), Some("My Printer"));
    assert_eq!(info.printer_profile.as_deref(), Some("sRGB"));
    assert_eq!(
        info.rendering_intent,
        Some(RenderingIntent::RelativeColorimetric)
    );
    assert_eq!(info.black_point_compensation, Some(true));
    match info.proof_setup {
        Some(ProofSetup::Builtin { builtin }) => assert_eq!(builtin, "proofCMYK"),
        _ => panic!("expected builtin proof setup"),
    }
}

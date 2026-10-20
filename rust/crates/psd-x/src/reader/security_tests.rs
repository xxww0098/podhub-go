//! Regressions for untrusted channel geometry and decoded allocation costs.
use super::*;
use crate::psd::{BlendingRange, ColorMode, LayerAdditionalInfo, PatternBounds, PatternInfo};
use flate2::{Compression as ZlibCompression, write::ZlibEncoder};
use std::io::Write;
use std::panic::{AssertUnwindSafe, catch_unwind};

fn zip(bytes: &[u8]) -> Vec<u8> {
    let mut encoder = ZlibEncoder::new(Vec::new(), ZlibCompression::default());
    encoder.write_all(bytes).unwrap();
    encoder.finish().unwrap()
}

#[test]
fn repro_prediction_short_planes_return_errors_without_panicking() {
    for depth in [8, 16, 32] {
        let expected = 4 * bytes_per_sample(depth);
        for length in [0, 1, expected - 1] {
            let reader = PsdReader::new(&[], None, None);
            let compressed = zip(&vec![0; length]);
            let mut output = DecodeTarget::rgba_depth(2, 2, depth);
            let result = catch_unwind(AssertUnwindSafe(|| {
                read_data_zip(
                    &reader,
                    &compressed,
                    Some(&mut output),
                    2,
                    2,
                    depth,
                    4,
                    0,
                    true,
                    0,
                    false,
                )
            }));
            assert!(result.is_ok(), "short {depth}-bit plane panicked");
            assert_eq!(result.unwrap(), Err(ReadError::UnexpectedEndOfBuffer));
            assert_eq!(reader.allocation_observations().live_bytes, 0);
            assert!(output.data.iter().all(|&byte| byte == 0));
        }
    }
}

#[test]
fn prediction_complete_planes_preserve_samples_and_row_resets() {
    let cases = [
        (8, vec![10, 5, 30, 7], vec![10, 15, 30, 37]),
        (
            16,
            [1000_u16, 200, 5000, 100]
                .into_iter()
                .flat_map(u16::to_be_bytes)
                .collect(),
            [1000_u16, 1200, 5000, 5100]
                .into_iter()
                .flat_map(u16::to_ne_bytes)
                .collect(),
        ),
        (
            32,
            // Planar big-endian bytes for 1.0, 0.5 / 0.25, 0.125, then byte deltas.
            vec![
                0x3f, 0, 0x41, 0x80, 0, 0, 0, 0, 0x3e, 0, 0x42, 0x80, 0, 0, 0, 0,
            ],
            [1.0_f32, 0.5, 0.25, 0.125]
                .into_iter()
                .flat_map(f32::to_ne_bytes)
                .collect(),
        ),
    ];
    for (depth, encoded, expected) in cases {
        let reader = PsdReader::new(&[], None, None);
        let mut output = DecodeTarget::rgba_depth(2, 2, depth);
        read_data_zip(
            &reader,
            &zip(&encoded),
            Some(&mut output),
            2,
            2,
            depth,
            4,
            0,
            true,
            0,
            false,
        )
        .unwrap();
        let bps = bytes_per_sample(depth);
        let samples: Vec<u8> = output
            .data
            .chunks_exact(4 * bps)
            .flat_map(|pixel| pixel[..bps].iter().copied())
            .collect();
        assert_eq!(samples, expected, "{depth}-bit samples");
        assert_eq!(reader.allocation_observations().live_bytes, 0);
    }
}

#[test]
fn zip_ignored_channels_and_non_prediction_recovery_remain_unchanged() {
    let reader = PsdReader::new(&[], None, None);
    let compressed = zip(&[7]);
    for depth in [8, 16, 32] {
        let mut output = DecodeTarget::rgba_depth(2, 2, depth);
        // No target: the samples are not consumed, so even a fatal reader stays quiet.
        read_data_zip(&reader, &compressed, None, 2, 2, depth, 4, 0, true, 0, true).unwrap();
        // Alpha plane of an RGBA target: `offset >= step` is skipped, still quiet.
        read_data_zip(
            &reader,
            &compressed,
            Some(&mut output),
            2,
            2,
            depth,
            4,
            4,
            true,
            0,
            true,
        )
        .unwrap();
        // Lenient reader: a short non-predicted plane keeps the historical recovery.
        read_data_zip(
            &reader,
            &compressed,
            Some(&mut output),
            2,
            2,
            depth,
            4,
            0,
            false,
            0,
            false,
        )
        .unwrap();
        assert_eq!(reader.allocation_observations().live_bytes, 0);
    }
}

#[test]
fn consuming_reader_reports_corrupt_channels_instead_of_zeroing_them() {
    // A short non-predicted plane would be copied partially and zero-filled.
    let reader = PsdReader::new(&[], None, None);
    let short = zip(&[7, 8, 9]);
    let mut output = DecodeTarget::rgba_depth(2, 2, 8);
    let error = read_data_zip(
        &reader,
        &short,
        Some(&mut output),
        2,
        2,
        8,
        4,
        0,
        false,
        3,
        true,
    )
    .unwrap_err();
    match error {
        ReadError::CorruptChannel {
            channel,
            ref detail,
        } => {
            assert_eq!(channel, 3, "channel id is reported back");
            assert!(detail.contains("short of the 4 byte plane"), "{detail}");
        }
        other => panic!("expected CorruptChannel, got {other:?}"),
    }
    assert_eq!(reader.allocation_observations().live_bytes, 0);
    assert!(output.data.iter().all(|&byte| byte == 0));

    // An inflated stream past the ceiling is reported the same way.
    let oversized = zip(&vec![0_u8; 2 * 2 * 4 + 64 * 1024 + 1]);
    let mut output = DecodeTarget::rgba_depth(2, 2, 8);
    let error = read_data_zip(
        &reader,
        &oversized,
        Some(&mut output),
        2,
        2,
        8,
        4,
        0,
        false,
        -1,
        true,
    )
    .unwrap_err();
    assert!(
        matches!(error, ReadError::CorruptChannel { channel: -1, .. }),
        "{error:?}"
    );

    // Bytes that are not a zlib stream at all are the canonical case.
    let mut output = DecodeTarget::rgba_depth(2, 2, 8);
    let error = read_data_zip(
        &reader,
        &[0x41; 24],
        Some(&mut output),
        2,
        2,
        8,
        4,
        0,
        false,
        0,
        true,
    )
    .unwrap_err();
    match error {
        ReadError::CorruptChannel {
            channel,
            ref detail,
        } => {
            assert_eq!(channel, 0);
            assert!(detail.contains("not decodable"), "{detail}");
        }
        other => panic!("expected CorruptChannel, got {other:?}"),
    }
    assert_eq!(reader.allocation_observations().live_bytes, 0);
}

fn blending_bytes(channel_ranges: usize) -> Vec<u8> {
    let length = (channel_ranges + 1) * 8;
    let mut bytes = (length as u32).to_be_bytes().to_vec();
    bytes.extend((0..length).map(|index| (index % 256) as u8));
    bytes
}

fn blending_cost(channel_ranges: usize) -> usize {
    (channel_ranges + 1) * 8 * size_of::<f64>() + channel_ranges * size_of::<BlendingRange>()
}

#[test]
fn repro_blending_expansion_is_rejected_before_allocating_or_reading_ranges() {
    let bytes = blending_bytes(32);
    let cost = blending_cost(32);
    for (total, metadata) in [(usize::MAX, cost - 1), (cost - 1, usize::MAX)] {
        let mut reader = PsdReader::new(&bytes, None, None);
        reader.configure_allocation_limits(total, metadata).unwrap();
        assert!(matches!(read_layer_blending_ranges(&mut reader),
            Err(ReadError::ExceededMemoryLimit { observed, category: AllocationCategory::Metadata, .. })
            if observed == cost));
        assert_eq!(reader.offset, 4);
        assert_eq!(reader.allocation_observations().high_water_bytes, 0);
    }
}

#[test]
fn blending_exact_budget_preserves_values_and_retains_aggregate_charge() {
    for count in [0, 1, 32] {
        let bytes = blending_bytes(count);
        let cost = blending_cost(count);
        let mut reader = PsdReader::new(&bytes, None, None);
        reader.configure_allocation_limits(cost, cost).unwrap();
        let ranges = read_layer_blending_ranges(&mut reader).unwrap().unwrap();
        assert_eq!(ranges.composite_gray_blend_source, [0.0, 1.0, 2.0, 3.0]);
        assert_eq!(
            ranges.composite_graph_blend_destination_range,
            [4.0, 5.0, 6.0, 7.0]
        );
        assert_eq!(ranges.ranges.len(), count);
        if count != 0 {
            assert_eq!(ranges.ranges[0].source_range, [8.0, 9.0, 10.0, 11.0]);
            assert_eq!(ranges.ranges[0].dest_range, [12.0, 13.0, 14.0, 15.0]);
        }
        assert_eq!(reader.allocation_observations().live_bytes, cost);
        assert!(
            reader
                .reserve_allocation(AllocationCategory::Metadata, 1)
                .is_err()
        );
    }
    let mut reader = PsdReader::new(&[0; 4], None, None);
    assert!(read_layer_blending_ranges(&mut reader).unwrap().is_none());
}

#[test]
fn blending_misaligned_sections_reject_before_allocating_or_crossing_boundaries() {
    for length in [1_u32, 7, 9, 15] {
        let mut bytes = length.to_be_bytes().to_vec();
        bytes.extend([0; 32]); // following bytes cannot complete a partial range
        let mut reader = PsdReader::new(&bytes, None, None);
        assert!(matches!(
            read_layer_blending_ranges(&mut reader),
            Err(ReadError::StrictViolation(_))
        ));
        assert_eq!(reader.offset, 4);
        assert_eq!(reader.allocation_observations().high_water_bytes, 0);
    }
}

fn pattern_bytes(
    mode: ColorMode,
    bounds: [u32; 4],
    channel: [u32; 4],
    compression: u8,
    payload: &[u8],
) -> Vec<u8> {
    let mut bytes = Vec::new();
    bytes.extend(0_u32.to_be_bytes()); // length, fixed below
    bytes.extend(1_u32.to_be_bytes());
    bytes.extend((mode as u32).to_be_bytes());
    bytes.extend([0; 4]); // x / y
    bytes.extend(0_u32.to_be_bytes()); // empty Unicode name
    bytes.push(0); // empty Pascal id
    if mode == ColorMode::Indexed {
        for value in 0..=255_u8 {
            bytes.extend([value, value.wrapping_add(1), value.wrapping_add(2)]);
        }
        bytes.extend([0; 4]);
    }
    bytes.extend(3_u32.to_be_bytes());
    bytes.extend(0_u32.to_be_bytes()); // VMAL length (not used by reader)
    for value in bounds {
        bytes.extend(value.to_be_bytes());
    }
    bytes.extend(1_u32.to_be_bytes()); // one channel + two absent slots
    bytes.extend(1_u32.to_be_bytes());
    bytes.extend((23 + payload.len() as u32).to_be_bytes());
    bytes.extend(8_u32.to_be_bytes());
    for value in channel {
        bytes.extend(value.to_be_bytes());
    }
    bytes.extend(8_u16.to_be_bytes());
    bytes.push(compression);
    bytes.extend(payload);
    bytes.extend([0; 8]);
    while (bytes.len() - 4) % 4 != 0 {
        bytes.push(0);
    }
    let length = (bytes.len() - 4) as u32;
    bytes[..4].copy_from_slice(&length.to_be_bytes());
    bytes
}

#[test]
fn repro_raw_patterns_require_complete_payload_for_every_color_mode() {
    for mode in [ColorMode::Rgb, ColorMode::Grayscale, ColorMode::Indexed] {
        let bytes = pattern_bytes(mode, [0, 0, 2, 2], [0, 0, 2, 2], 0, &[1]);
        let mut reader = PsdReader::new(&bytes, None, None);
        assert_eq!(
            read_pattern(&mut reader).unwrap_err(),
            ReadError::UnexpectedEndOfBuffer
        );
        assert_eq!(reader.allocation_observations().live_bytes, 0);
    }
}

#[test]
fn pattern_invalid_rectangles_and_huge_work_fail_without_panicking() {
    for mode in [ColorMode::Rgb, ColorMode::Grayscale, ColorMode::Indexed] {
        for channel in [
            [0, 0, 1, u32::MAX],
            [0, 0, u32::MAX, 1],
            [1, 0, 0, 1],
            [0, 1, 1, 0],
            [0, 0, 1, 2],
        ] {
            let bytes = pattern_bytes(mode, [0, 0, 1, 1], channel, 0, &[1]);
            let result = catch_unwind(|| read_pattern(&mut PsdReader::new(&bytes, None, None)));
            assert!(matches!(result, Ok(Err(_))), "{mode:?} / {channel:?}");
        }
    }
}

#[test]
fn pattern_empty_planes_and_oversized_rasters_are_bounded() {
    for bounds in [[0, 0, u32::MAX, 0], [0, 0, 0, u32::MAX]] {
        let bytes = pattern_bytes(ColorMode::Rgb, bounds, bounds, 0, &[]);
        let mut reader = PsdReader::new(&bytes, None, None);
        reader.configure_allocation_limits(0, 0).unwrap();
        assert!(read_pattern(&mut reader).unwrap().data.is_empty());
        assert_eq!(reader.allocation_observations().high_water_bytes, 0);
    }
    let bytes = pattern_bytes(ColorMode::Rgb, [0, 0, 2, 2], [0, 0, 2, 2], 0, &[1, 2, 3, 4]);
    let mut reader = PsdReader::new(&bytes, None, None);
    reader.configure_allocation_limits(15, 0).unwrap();
    assert!(matches!(
        read_pattern(&mut reader),
        Err(ReadError::ExceededMemoryLimit {
            observed: 16,
            category: AllocationCategory::Raster,
            ..
        })
    ));
    assert_eq!(reader.allocation_observations().high_water_bytes, 0);
}

#[test]
fn pattern_channel_lengths_cannot_consume_following_pattern_bytes() {
    let bytes = pattern_bytes(ColorMode::Rgb, [0, 0, 1, 1], [0, 0, 1, 1], 0, &[1]);
    // Empty strings put the first channel's has / length at 49 / 53.
    for length in [0_u32, 22, u32::MAX, 31] {
        let mut malformed = bytes.clone();
        malformed[53..57].copy_from_slice(&length.to_be_bytes());
        if length == 31 {
            malformed[..4].copy_from_slice(&((81 - 4) as u32).to_be_bytes());
        }
        malformed.extend([0; 64]);
        assert!(read_pattern(&mut PsdReader::new(&malformed, None, None)).is_err());
    }
    let mut excessive_slots = bytes.clone();
    excessive_slots[45..49].copy_from_slice(&u32::MAX.to_be_bytes());
    let mut reader = PsdReader::new(&excessive_slots, None, None);
    assert_eq!(
        read_pattern(&mut reader).unwrap_err(),
        ReadError::UnexpectedEndOfBuffer
    );
    assert_eq!(reader.allocation_observations().high_water_bytes, 0);
}

#[test]
fn raw_pattern_subrectangles_preserve_rgb_grayscale_and_palette_pixels() {
    for mode in [ColorMode::Rgb, ColorMode::Grayscale, ColorMode::Indexed] {
        let bytes = pattern_bytes(mode, [10, 20, 12, 22], [11, 21, 12, 22], 0, &[7]);
        let mut reader = PsdReader::new(&bytes, None, None);
        reader.configure_allocation_limits(16, 0).unwrap();
        let pattern = read_pattern(&mut reader).unwrap();
        let expected = match mode {
            ColorMode::Rgb => [7, 0, 0, 255],
            ColorMode::Grayscale => [7, 7, 7, 255],
            _ => [7, 8, 9, 255],
        };
        assert_eq!(
            &pattern.data[..12],
            &[0, 0, 0, 255, 0, 0, 0, 255, 0, 0, 0, 255]
        );
        assert_eq!(&pattern.data[12..], &expected);
        assert_eq!(reader.offset, bytes.len());
        assert_eq!(reader.allocation_observations().live_bytes, 16);
    }
}

#[test]
fn pattern_rle_temporary_allocations_are_released_and_total_budget_is_enforced() {
    let bytes = pattern_bytes(
        ColorMode::Grayscale,
        [0, 0, 2, 2],
        [0, 0, 2, 2],
        1,
        &[0, 3, 0, 3, 1, 7, 8, 1, 9, 10],
    );
    let mut reader = PsdReader::new(&bytes, None, None);
    let peak = 16 + 4 + 2 * size_of::<usize>() + 3;
    reader.configure_allocation_limits(peak, 0).unwrap();
    let pattern = read_pattern(&mut reader).unwrap();
    assert_eq!(
        pattern.data,
        [7, 7, 7, 255, 8, 8, 8, 255, 9, 9, 9, 255, 10, 10, 10, 255]
    );
    assert_eq!(reader.allocation_observations().live_bytes, 16);
    assert_eq!(reader.allocation_observations().high_water_bytes, peak);

    let mut rejected = PsdReader::new(&bytes, None, None);
    rejected.configure_allocation_limits(19, 0).unwrap();
    assert!(matches!(
        read_pattern(&mut rejected),
        Err(ReadError::ExceededMemoryLimit {
            observed: 20,
            category: AllocationCategory::Channel,
            ..
        })
    ));
    assert_eq!(rejected.allocation_observations().live_bytes, 0);
}

#[test]
fn pattern_ignored_rle_channels_do_not_allocate_decoded_planes() {
    for (mode, applicable) in [(ColorMode::Rgb, 3_u32), (ColorMode::Grayscale, 1)] {
        let bounds = [0, 0, 2, 2];
        let raw = pattern_bytes(mode, bounds, bounds, 0, &[7, 8, 9, 10]);
        let rle = pattern_bytes(mode, bounds, bounds, 1, &[0]);
        // Empty names put the channel count at 45 and the first channel at 49.
        let mut bytes = raw[..49].to_vec();
        bytes[45..49].copy_from_slice(&(applicable + 32).to_be_bytes());
        for _ in 0..applicable {
            bytes.extend(&raw[49..84]); // 31-byte header + four raw pixels
        }
        for _ in 0..32 {
            bytes.extend(&rle[49..81]); // ignored RLE payload need not decode
        }
        bytes.extend([0; 8]); // two absent slots
        while (bytes.len() - 4) % 4 != 0 {
            bytes.push(0);
        }
        let length = (bytes.len() - 4) as u32;
        bytes[..4].copy_from_slice(&length.to_be_bytes());
        for limit in [20, 16] {
            let mut reader = PsdReader::new(&bytes, None, None);
            reader.configure_allocation_limits(limit, 0).unwrap();
            let pattern = read_pattern(&mut reader).unwrap();
            let stats = reader.allocation_observations();
            assert_eq!(
                stats.category_high_water_bytes.channel, 0,
                "{mode:?} / {limit}"
            );
            assert_eq!(stats.live_bytes, 16);
            assert_eq!(stats.high_water_bytes, 16);
            assert_eq!(reader.offset, bytes.len());
            assert_eq!(
                pattern.data,
                [7, 7, 7, 255, 8, 8, 8, 255, 9, 9, 9, 255, 10, 10, 10, 255]
            );
        }
    }
}

#[test]
fn pattern_indexed_rle_remains_unsupported() {
    let bytes = pattern_bytes(ColorMode::Indexed, [0, 0, 2, 2], [0, 0, 2, 2], 1, &[0]);
    let mut reader = PsdReader::new(&bytes, None, None);
    assert_eq!(
        read_pattern(&mut reader).unwrap_err(),
        ReadError::StrictViolation("Indexed pattern color mode not implemented".into())
    );
    assert_eq!(reader.allocation_observations().live_bytes, 0);
}

#[test]
fn pattern_shared_entry_points_reject_hostile_raw_and_preserve_normal_patterns() {
    for payload in [&[1][..], &[1, 2, 3, 4][..]] {
        let bytes = pattern_bytes(ColorMode::Grayscale, [0, 0, 2, 2], [0, 0, 2, 2], 0, payload);
        let valid = payload.len() == 4;
        for version in [6_i16, 7, 9, 10] {
            let mut abr = version.to_be_bytes().to_vec();
            abr.extend(1_i16.to_be_bytes());
            abr.extend(b"8BIMpatt");
            abr.extend((bytes.len() as u32).to_be_bytes());
            abr.extend(&bytes);
            let result = crate::abr::read_abr(&abr, &crate::abr::ReadAbrOptions::default());
            assert_eq!(result.is_ok(), valid, "ABR {version}");
        }
        for key in ["Patt", "Pat2", "Pat3"] {
            let options = ReadOptions::default();
            let mut ctx = crate::additional_info::ReadCtx::new(&options, false);
            let mut reader = PsdReader::new(&bytes, None, None);
            let mut info = LayerAdditionalInfo::default();
            let result = crate::additional_info::read_additional_info_key(
                key,
                &mut reader,
                &mut info,
                &|r| bytes.len().saturating_sub(r.offset),
                &mut ctx,
            );
            assert_eq!(result.is_ok(), valid, "{key}");
            if valid {
                assert_eq!(info.patterns.unwrap()[0].data[0], 1);
            }
        }
    }
}

#[test]
fn writer_rle_patterns_still_parse() {
    let pattern = PatternInfo {
        id: "test".into(),
        name: "pattern".into(),
        x: 0.0,
        y: 0.0,
        bounds: PatternBounds {
            x: 20.0,
            y: 10.0,
            w: 2.0,
            h: 2.0,
        },
        data: vec![1, 2, 3, 255, 4, 5, 6, 255, 7, 8, 9, 255, 10, 11, 12, 255],
    };
    let mut writer = crate::writer::create_writer_default();
    crate::writer::write_pattern(&mut writer, &pattern);
    let bytes = writer.to_bytes();
    let decoded = read_pattern(&mut PsdReader::new(&bytes, None, None)).unwrap();
    assert_eq!(decoded.data, pattern.data);
    assert_eq!(decoded.name, pattern.name);
}

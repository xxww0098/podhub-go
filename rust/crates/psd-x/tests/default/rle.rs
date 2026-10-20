//! Port of upstream ag-psd `src/test/helpers.spec.ts` `writeDataRLE` cases
//! (1 zero-size + 24 round-trips). Optionally asserts a few hardcoded JS
//! encoder byte vectors captured from the upstream PackBits implementation.

use psdx::helpers::write_data_rle;
use psdx::psd::PixelData;
use psdx::reader::{DecodeTarget, PsdReader, read_data_rle};

fn to_data(samples: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(samples.len() * 4);
    for &s in samples {
        out.extend_from_slice(&[s, s, s, s]);
    }
    out
}

fn from_data(rgba: &[u8]) -> Vec<u8> {
    rgba.iter().step_by(4).copied().collect()
}

fn repeat(times: usize, values: &[u8]) -> Vec<u8> {
    assert!(!values.is_empty());
    let mut out = Vec::with_capacity(times * values.len());
    for _ in 0..times {
        out.extend_from_slice(values);
    }
    out
}

fn range(start: u8, length: usize) -> Vec<u8> {
    (0..length).map(|i| start.wrapping_add(i as u8)).collect()
}

struct RleCase {
    name: &'static str,
    width: u32,
    height: u32,
    data: Vec<u8>,
}

fn rle_tests() -> Vec<RleCase> {
    vec![
        RleCase {
            name: "1",
            width: 1,
            height: 1,
            data: vec![1],
        },
        RleCase {
            name: "1 1",
            width: 2,
            height: 1,
            data: vec![1, 1],
        },
        RleCase {
            name: "1 2",
            width: 2,
            height: 1,
            data: vec![1, 2],
        },
        RleCase {
            name: "3 x 1",
            width: 3,
            height: 1,
            data: vec![1, 1, 1],
        },
        RleCase {
            name: "1 2 3",
            width: 3,
            height: 1,
            data: vec![1, 2, 3],
        },
        RleCase {
            name: "1 1 1 3 2 1",
            width: 6,
            height: 1,
            data: vec![1, 1, 1, 3, 2, 1],
        },
        RleCase {
            name: "1 2 3 1 1 1",
            width: 6,
            height: 1,
            data: vec![1, 2, 3, 1, 1, 1],
        },
        RleCase {
            name: "1 1 1 1 1 0",
            width: 6,
            height: 1,
            data: vec![1, 1, 1, 1, 1, 0],
        },
        RleCase {
            name: "3x2 1 1 1 3 2 1",
            width: 3,
            height: 2,
            data: vec![1, 1, 1, 3, 2, 1],
        },
        RleCase {
            name: "3x2 1 2 3 1 1 1",
            width: 3,
            height: 2,
            data: vec![1, 2, 3, 1, 1, 1],
        },
        RleCase {
            name: "3x3 1 1 1 1 2 2 2 1 1",
            width: 3,
            height: 3,
            data: vec![1, 1, 1, 1, 2, 2, 2, 1, 1],
        },
        RleCase {
            name: "3x3 upper range",
            width: 3,
            height: 3,
            data: vec![255, 255, 255, 254, 254, 254, 1, 1, 0],
        },
        RleCase {
            name: "128 x 1",
            width: 128,
            height: 1,
            data: repeat(128, &[1]),
        },
        RleCase {
            name: "130 x 1",
            width: 130,
            height: 1,
            data: repeat(130, &[1]),
        },
        RleCase {
            name: "130 x 1 2",
            width: 130,
            height: 1,
            data: repeat(65, &[1, 2]),
        },
        RleCase {
            name: "150 x 1",
            width: 150,
            height: 1,
            data: repeat(150, &[1]),
        },
        RleCase {
            name: "100 x 1",
            width: 200,
            height: 1,
            data: repeat(200, &[1]),
        },
        RleCase {
            name: "300 x 1",
            width: 300,
            height: 1,
            data: repeat(300, &[1]),
        },
        RleCase {
            name: "500 x 1",
            width: 500,
            height: 1,
            data: repeat(500, &[1]),
        },
        RleCase {
            name: "100x5 only 1",
            width: 100,
            height: 5,
            data: repeat(500, &[1]),
        },
        RleCase {
            name: "large list of 1s with some random numbers in it",
            width: 100,
            height: 5,
            data: {
                let mut d = Vec::new();
                d.extend(repeat(10, &[1]));
                d.extend_from_slice(&[3, 3, 3]);
                d.extend(repeat(164, &[1]));
                d.push(3);
                d.extend(repeat(9, &[1]));
                d.push(5);
                d.extend(repeat(5, &[1]));
                d.extend_from_slice(&[3, 3, 3]);
                d.extend(repeat(304, &[1]));
                d
            },
        },
        RleCase {
            name: "small batch in sea of 0s",
            width: 146,
            height: 1,
            data: {
                let mut d = repeat(50, &[0]);
                d.extend_from_slice(&[
                    1, 13, 30, 42, 54, 64, 72, 77, 82, 86, 89, 90, 93, 94, 94, 95, 95, 95, 96, 96,
                    96, 96, 95, 95, 95, 94, 93, 92, 91, 89, 87, 84, 82, 80, 76, 72, 67, 62, 57, 49,
                    42, 34, 26, 19, 12, 5,
                ]);
                d.extend(repeat(50, &[0]));
                d
            },
        },
        RleCase {
            name: "from broken psd",
            width: 141,
            height: 1,
            data: vec![
                237, 234, 233, 233, 233, 232, 233, 236, 238, 239, 239, 240, 241, 241, 238, 220,
                217, 217, 215, 212, 205, 201, 203, 207, 208, 210, 218, 226, 234, 236, 236, 238,
                240, 234, 228, 208, 180, 163, 178, 189, 205, 218, 219, 214, 214, 213, 205, 181,
                171, 154, 132, 133, 163, 177, 179, 173, 76, 122, 168, 174, 143, 116, 117, 133, 181,
                130, 172, 190, 159, 4, 0, 45, 179, 190, 177, 167, 18, 44, 110, 174, 212, 223, 229,
                228, 213, 210, 170, 88, 200, 222, 210, 152, 152, 151, 190, 198, 210, 179, 183, 188,
                189, 189, 187, 187, 186, 186, 184, 193, 213, 222, 229, 232, 231, 228, 229, 233,
                237, 240, 240, 238, 236, 231, 226, 228, 230, 229, 222, 211, 201, 193, 189, 187,
                186, 186, 186, 185, 184, 184, 186, 193, 198,
            ],
        },
        RleCase {
            name: "127 different + 3 repeated",
            width: 130,
            height: 1,
            data: {
                let mut d = range(0, 127);
                d.extend_from_slice(&[1, 1, 1]);
                d
            },
        },
    ]
}

fn round_trip(width: u32, height: u32, samples: &[u8]) -> (Vec<u8>, Vec<u8>) {
    assert_eq!(
        (width as usize) * (height as usize),
        samples.len(),
        "invalid image data size"
    );

    let input = PixelData::rgba8(width, height, to_data(samples));
    let mut buffer = vec![0u8; 16 * 1024 * 1024];
    let encoded = write_data_rle(&mut buffer, &input, &[0], false)
        .unwrap_or_else(|| panic!("write_data_rle returned None for {width}x{height}"));

    let mut output = DecodeTarget::rgba(width as usize, height as usize);
    let mut reader = PsdReader::new(&encoded, None, None);
    read_data_rle(
        &mut reader,
        Some(&mut output),
        width as usize,
        height as usize,
        8,
        4,
        &[0],
        false,
    )
    .unwrap_or_else(|e| panic!("read_data_rle failed for {width}x{height}: {e:?}"));

    (encoded, from_data(&output.data))
}

#[test]
fn write_data_rle_returns_none_for_zero_size() {
    let empty = PixelData::rgba8(0, 0, vec![]);
    let mut buf = [0u8; 1];
    assert!(write_data_rle(&mut buf, &empty, &[0], false).is_none());

    let zero_w = PixelData::rgba8(0, 100, vec![]);
    assert!(write_data_rle(&mut buf, &zero_w, &[0], false).is_none());

    let zero_h = PixelData::rgba8(100, 0, vec![]);
    assert!(write_data_rle(&mut buf, &zero_h, &[0], false).is_none());
}

#[test]
fn write_data_rle_round_trips_all_cases() {
    let cases = rle_tests();
    assert_eq!(cases.len(), 24, "expected 24 rleTests from helpers.spec.ts");

    for case in &cases {
        let (encoded, decoded) = round_trip(case.width, case.height, &case.data);
        assert_eq!(
            decoded, case.data,
            "RLE round-trip mismatch for `{}`; encoded={encoded:?}",
            case.name
        );
    }
}

/// Byte-level vectors from upstream JS `writeDataRLE` (helpers.ts), captured
/// with the same PackBits algorithm for a handful of small cases.
#[test]
fn write_data_rle_matches_js_encoder_vectors() {
    let ones_128 = repeat(128, &[1]);
    let ones_130 = repeat(130, &[1]);

    let vectors: &[(&str, u32, u32, &[u8], &[u8])] = &[
        ("1", 1, 1, &[1], &[0, 2, 0, 1]),
        ("1 1", 2, 1, &[1, 1], &[0, 3, 1, 1, 1]),
        ("1 2", 2, 1, &[1, 2], &[0, 3, 1, 1, 2]),
        ("3 x 1", 3, 1, &[1, 1, 1], &[0, 2, 254, 1]),
        ("1 2 3", 3, 1, &[1, 2, 3], &[0, 4, 2, 1, 2, 3]),
        (
            "1 1 1 1 1 0",
            6,
            1,
            &[1, 1, 1, 1, 1, 0],
            &[0, 4, 252, 1, 0, 0],
        ),
        ("128 x 1", 128, 1, ones_128.as_slice(), &[0, 2, 129, 1]),
        (
            "130 x 1",
            130,
            1,
            ones_130.as_slice(),
            &[0, 5, 129, 1, 1, 1, 1],
        ),
    ];

    for &(name, width, height, samples, expected) in vectors {
        let input = PixelData::rgba8(width, height, to_data(samples));
        let mut buffer = vec![0u8; 16 * 1024];
        let encoded = write_data_rle(&mut buffer, &input, &[0], false)
            .unwrap_or_else(|| panic!("write_data_rle returned None for `{name}`"));
        assert_eq!(
            encoded.as_slice(),
            expected,
            "JS encoder vector mismatch for `{name}`"
        );
    }
}

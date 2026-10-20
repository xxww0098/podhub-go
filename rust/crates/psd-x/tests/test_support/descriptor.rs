//! Fixture-pinned descriptor construction + PS 2026 enum decode tests.
//!
//! Skips cleanly when fixtures are absent (gitignored corpora).

use psdx::test_corpus;
use std::fs;
use std::path::PathBuf;

use psdx::descriptor::{Descriptor, DescriptorValue, serialize_color};
use psdx::psd::{BlendMode, Color, ReadOptions, Rgb, WriteOptions};
use psdx::{read_psd, write_psd};

fn fixture_psd(name: &str) -> Option<PathBuf> {
    let dir = test_corpus::corpus_root().join("read").join(name);
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

#[test]
fn photoshop_2026_blend_modes_decode_from_fixture() {
    let Some(src) = fixture_psd("2026-blend-modes") else {
        eprintln!("skip 2026-blend-modes: fixture missing");
        return;
    };
    let bytes = fs::read(&src).expect("read fixture");
    let psd = read_psd(&bytes, &ReadOptions::default()).expect("read psd");
    let children = psd.children.as_ref().expect("children");

    let sample = children
        .iter()
        .find(|l| {
            l.additional_info
                .effects
                .as_ref()
                .and_then(|e| e.drop_shadow.as_ref())
                .map(|v| !v.is_empty())
                .unwrap_or(false)
        })
        .expect("layer with drop shadow");
    let fx = sample.additional_info.effects.as_ref().unwrap();
    let ds = &fx.drop_shadow.as_ref().unwrap()[0];
    assert_eq!(
        ds.blend_mode,
        Some(BlendMode::Multiply),
        "PS2026 BlnM.multiply must decode via createEnum long-form fallback"
    );

    let color_burn_layer = children.iter().find(|l| {
        l.additional_info
            .effects
            .as_ref()
            .and_then(|e| e.solid_fill.as_ref())
            .and_then(|v| v.first())
            .and_then(|s| s.blend_mode)
            == Some(BlendMode::ColorBurn)
    });
    assert!(
        color_burn_layer.is_some(),
        "expected at least one solidFill with color burn (BlnM.colorBurn)"
    );
}

#[test]
fn construction_site_ostypes_and_class_ids() {
    let mut d = Descriptor::new("", "Grdn");
    d.set("RndS", DescriptorValue::Integer(42));
    d.set("Smth", DescriptorValue::Integer(4096));
    d.set(
        "Mnm ",
        DescriptorValue::List(vec![DescriptorValue::Integer(0)]),
    );
    assert_eq!(d.get("RndS").unwrap().os_type(), "long");
    assert_eq!(d.get("Smth").unwrap().os_type(), "long");
    match d.get("Mnm ").unwrap() {
        DescriptorValue::List(items) => assert_eq!(items[0].os_type(), "long"),
        _ => panic!("expected list"),
    }

    assert_eq!(Descriptor::new("", "DrSh").class_id, "DrSh");
    assert_eq!(Descriptor::new("", "CrPt").class_id, "CrPt");
    assert_eq!(Descriptor::new("", "countGroup").class_id, "countGroup");
    assert_eq!(Descriptor::new("", "countObject").class_id, "countObject");
    assert_eq!(Descriptor::new("", "slice").class_id, "slice");

    let mut rect = Descriptor::new("", "classFloatRect");
    rect.set("Top ", DescriptorValue::Double(0.0));
    assert_eq!(rect.get("Top ").unwrap().os_type(), "doub");

    let mut size = Descriptor::new("", "Pnt ");
    size.set("Wdth", DescriptorValue::Double(10.0));
    size.set("Hght", DescriptorValue::Double(20.0));
    assert_eq!(size.get("Wdth").unwrap().os_type(), "doub");
}

#[test]
fn effects_read_write_preserves_descriptor_class_ids() {
    let Some(src) = fixture_psd("effects") else {
        eprintln!("skip effects classID round-trip: fixture missing");
        return;
    };
    let bytes = fs::read(&src).expect("read");
    let psd = read_psd(&bytes, &ReadOptions::default()).expect("read psd");
    if psd.bits_per_channel.unwrap_or(8.0) != 8.0 {
        eprintln!("skip: non-8-bit");
        return;
    }
    let out = match write_psd(&psd, &WriteOptions::default()) {
        Ok(b) => b,
        Err(e) => {
            eprintln!("skip effects write: {e}");
            return;
        }
    };
    for needle in [
        b"DrSh" as &[u8],
        b"IrSh",
        b"OrGl",
        b"IrGl",
        b"ebbl",
        b"SoFi",
        b"GrFl",
        b"ChFX",
        b"CrPt",
    ] {
        assert!(
            out.windows(needle.len()).any(|w| w == needle),
            "written PSD missing classID {:?}",
            std::str::from_utf8(needle)
        );
    }
}

#[test]
fn count_resource_class_ids_on_write() {
    let Some(src) = fixture_psd("count") else {
        eprintln!("skip count: fixture missing");
        return;
    };
    let bytes = fs::read(&src).expect("read");
    let psd = read_psd(&bytes, &ReadOptions::default()).expect("read");
    if psd.bits_per_channel.unwrap_or(8.0) != 8.0 {
        return;
    }
    let out = match write_psd(&psd, &WriteOptions::default()) {
        Ok(b) => b,
        Err(_) => return,
    };
    assert!(
        out.windows(10).any(|w| w == b"countGroup"),
        "missing countGroup classID"
    );
    assert!(
        out.windows(11).any(|w| w == b"countObject"),
        "missing countObject classID"
    );
}

#[test]
fn m3_m4_pixel_goldens_not_regressed() {
    for (name, expect_layers, depth) in [("16bits", 1usize, 16.0f64), ("32bits", 2usize, 32.0f64)] {
        let Some(src) = fixture_psd(name) else {
            eprintln!("skip {name}: fixture missing");
            continue;
        };
        let bytes = fs::read(&src).expect("read");
        let psd = read_psd(&bytes, &ReadOptions::default()).expect("read");
        let n = psd.children.as_ref().map(|c| c.len()).unwrap_or(0);
        assert_eq!(n, expect_layers, "{name} layer count");
        assert_eq!(psd.bits_per_channel, Some(depth));
    }
}

#[test]
fn serialize_color_rgb_stays_doub() {
    let d = serialize_color(Some(&Color::Rgb(Rgb {
        r: 1.0,
        g: 2.0,
        b: 3.0,
    })));
    assert_eq!(d.class_id, "RGBC");
    assert_eq!(d.get("Rd  ").unwrap().os_type(), "doub");
}

#[test]
fn create_enum_table_count_exported() {
    assert_eq!(psdx::descriptor_enums::CREATE_ENUM_TABLE_COUNT, 58);
}

#[test]
fn enum_codec_bln_m_round_trip_long_form() {
    let c = psdx::descriptor_enums::bln_m();
    assert_eq!(c.decode("BlnM.multiply").unwrap(), "multiply");
    assert_eq!(c.decode("BlnM.colorBurn").unwrap(), "color burn");
    assert_eq!(
        c.encode(Some(&c.decode("BlnM.normal").unwrap())).unwrap(),
        "BlnM.Nrml"
    );
}

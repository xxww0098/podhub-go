//! Corpus checks for image-header sniffing.
//!
//! For every embedded linked-file asset in the smart-object fixtures, the
//! sniffed pixel size must match the placed-layer width/height fields. When
//! PNG pHYs / JPEG JFIF density is present, sniffed DPI must match the
//! placed-layer resolution (Density units).
//!
//! Skips cleanly when `vendor/agpsd-fixtures` is absent.

use psdx::test_corpus;
use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;

use psdx::image_sniff::{ImageFormat, sniff_image};
use psdx::psd::{Layer, ReadOptions, Units, UnitsValue};
use psdx::read_psd;

fn fixture_psd(name: &str) -> Option<PathBuf> {
    let dir = test_corpus::corpus_root().join("read").join(name);
    for fname in ["src.psd", "src.psb"] {
        let p = dir.join(fname);
        if p.is_file() {
            return Some(p);
        }
    }
    None
}

fn read_fixture(name: &str) -> Option<psdx::psd::Psd> {
    let src = fixture_psd(name)?;
    let bytes = fs::read(src).ok()?;
    let opts = ReadOptions {
        use_image_data: Some(true),
        skip_thumbnail: Some(true),
        ..ReadOptions::default()
    };
    read_psd(&bytes, &opts).ok()
}

fn collect_placed<'a>(layer: &'a Layer, out: &mut Vec<&'a Layer>) {
    if layer.additional_info.placed_layer.is_some() {
        out.push(layer);
    }
    if let Some(children) = layer.children.as_ref() {
        for child in children {
            collect_placed(child, out);
        }
    }
}

fn density_dpi(res: &UnitsValue) -> Option<f64> {
    match res.units {
        Units::Density => Some(res.value),
        _ => None,
    }
}

const CORPUS: &[&str] = &[
    "smart-object",
    "smart-object-png",
    "smart-object-curves",
    "smart-filter",
    "smart-filter-blur",
    "placed-transform",
    "cyllinder-warp",
    "mesh-transform",
];

#[test]
fn corpus_embedded_assets_match_placed_layer_size() {
    let mut saw_any = false;
    let mut checked = 0usize;

    for name in CORPUS {
        let Some(psd) = read_fixture(name) else {
            eprintln!("skip {name}: fixture missing");
            continue;
        };
        saw_any = true;

        let linked = psd.linked_files.as_deref().unwrap_or(&[]);
        let mut by_id: HashMap<&str, &psdx::psd::LinkedFile> = HashMap::new();
        for f in linked {
            by_id.insert(f.id.as_str(), f);
        }

        let mut placed_layers = Vec::new();
        if let Some(children) = psd.children.as_ref() {
            for layer in children {
                collect_placed(layer, &mut placed_layers);
            }
        }

        for layer in placed_layers {
            let placed = layer.additional_info.placed_layer.as_ref().expect("placed");
            let Some(file) = by_id.get(placed.id.as_str()) else {
                continue;
            };
            let Some(data) = file.data.as_deref() else {
                eprintln!(
                    "skip {name}/{}: linked file has no embedded data",
                    file.name
                );
                continue;
            };

            let sniff = sniff_image(data);
            assert!(
                sniff.format.is_known(),
                "{name}: embedded '{}' format unknown (magic {:02x?})",
                file.name,
                &data[..data.len().min(8)]
            );
            let pw = placed.width.expect("placed.width") as u32;
            let ph = placed.height.expect("placed.height") as u32;
            assert_eq!(
                sniff.width,
                Some(pw),
                "{name}: '{}' width sniff={:?} placed={}",
                file.name,
                sniff.width,
                pw
            );
            assert_eq!(
                sniff.height,
                Some(ph),
                "{name}: '{}' height sniff={:?} placed={}",
                file.name,
                sniff.height,
                ph
            );

            // DPI: only when the container declares absolute density.
            if let Some(dpi) = sniff.dpi {
                if let Some(res) = placed.resolution.as_ref().and_then(density_dpi) {
                    let err_x = (dpi.x - res).abs();
                    let err_y = (dpi.y - res).abs();
                    assert!(
                        err_x < 0.05 && err_y < 0.05,
                        "{name}: '{}' DPI sniff=({:.4},{:.4}) placed={res}",
                        file.name,
                        dpi.x,
                        dpi.y
                    );
                }
            }

            // Sanity: PSD vs PSB by version.
            match sniff.format {
                ImageFormat::Psd | ImageFormat::Psb | ImageFormat::Png | ImageFormat::Jpeg => {}
                other => panic!("{name}: unexpected format {other:?} for '{}'", file.name),
            }

            checked += 1;
        }
    }

    if !saw_any {
        eprintln!("skip corpus: no smart-object fixtures present");
        return;
    }
    assert!(
        checked > 0,
        "expected at least one embedded asset with placed-layer size"
    );
}

#[test]
fn corpus_companion_files_match_headers() {
    // Cross-check extracted companion images next to src.psd (same sizes).
    let root = test_corpus::corpus_root().join("read");
    if !root.is_dir() {
        eprintln!("skip companion check: fixtures missing");
        return;
    }

    let cases = [
        (
            "smart-object/91094a9a15b22680de531aa125eeeb3b.jpg",
            ImageFormat::Jpeg,
            500,
            511,
            Some(72.0),
        ),
        ("smart-object/kitty.jpg", ImageFormat::Jpeg, 100, 111, None),
        (
            "smart-object-png/apolaugh.png",
            ImageFormat::Png,
            32,
            32,
            Some(299.9994),
        ),
        ("smart-filter/temmie.png", ImageFormat::Png, 525, 613, None),
        (
            "smart-object-curves/Layer 1 (merged).psb",
            ImageFormat::Psb,
            70,
            70,
            None,
        ),
        (
            "smart-filter-blur/Ellipse 1.psb",
            ImageFormat::Psb,
            191,
            191,
            None,
        ),
        (
            "placed-transform/Layer 1.psd",
            ImageFormat::Psd,
            259,
            435,
            None,
        ),
    ];

    let mut checked = 0usize;
    for (rel, fmt, w, h, dpi) in cases {
        let path = root.join(rel);
        if !path.is_file() {
            eprintln!("skip missing companion {rel}");
            continue;
        }
        let bytes = fs::read(&path).expect("read companion");
        let s = sniff_image(&bytes);
        assert_eq!(s.format, fmt, "{rel}");
        assert_eq!(s.width, Some(w), "{rel}");
        assert_eq!(s.height, Some(h), "{rel}");
        match dpi {
            Some(expected) => {
                let d = s.dpi.expect("dpi");
                assert!((d.x - expected).abs() < 0.05, "{rel} dpi.x");
                assert!((d.y - expected).abs() < 0.05, "{rel} dpi.y");
            }
            None => {}
        }
        checked += 1;
    }
    if checked == 0 {
        eprintln!("skip companion check: no companion files present");
    }
}

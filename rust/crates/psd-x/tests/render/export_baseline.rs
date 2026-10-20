//! Pin current Export As output as a regression baseline.
//!
//! Asserts only through the public `psdx::render` export interface. Digests are
//! SHA-256 of encoded bytes (repository golden discipline: never commit derived
//! image data). Skips visibly when fixtures are absent.

use psdx::test_corpus;
use std::fs;
use std::path::PathBuf;

use psdx::psd::{Layer, LayerAdditionalInfo, PixelData, Psd, ReadOptions};
use psdx::read_psd;
use psdx::render::{
    ExportBounds, ExportConcurrency, ExportError, ExportFormat, ExportOptions, ExportResult,
    ExportScale, export_groups,
};
use sha2::{Digest, Sha256};

const FETCH_FIXTURES: &str = "set PSDX_FIXTURES_DIR";

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

fn skip_missing(name: &str) -> bool {
    if fixture_psd(name).is_some() {
        return false;
    }
    eprintln!("skip {name}: fixture missing (run {FETCH_FIXTURES})");
    true
}

fn require_fixtures(names: &[&str]) -> bool {
    let mut missing = false;
    for name in names {
        if skip_missing(name) {
            missing = true;
        }
    }
    missing
}

fn load_fixture(name: &str) -> Psd {
    let path = fixture_psd(name).unwrap_or_else(|| panic!("fixture {name} missing"));
    let bytes = fs::read(&path).expect("read fixture");
    read_psd(&bytes, &ReadOptions::default()).expect("read_psd")
}

fn sha256_hex(bytes: &[u8]) -> String {
    let digest = Sha256::digest(bytes);
    digest.iter().map(|b| format!("{b:02x}")).collect()
}

fn off_options(format: ExportFormat) -> ExportOptions {
    ExportOptions {
        format,
        concurrency: ExportConcurrency::Off,
        ..ExportOptions::default()
    }
}

fn export(psd: &Psd, options: &ExportOptions) -> ExportResult {
    export_groups(psd, options).expect("export_groups")
}

fn assert_assets(result: &ExportResult, expected: &[(&str, &str, u32, u32, f64, &str)]) {
    assert_eq!(
        result.assets.len(),
        expected.len(),
        "asset count mismatch; got {:?}",
        result
            .assets
            .iter()
            .map(|a| (&a.file_name, sha256_hex(&a.bytes)))
            .collect::<Vec<_>>()
    );
    for (asset, &(group_name, file_name, width, height, scale, digest)) in
        result.assets.iter().zip(expected)
    {
        assert_eq!(asset.group_name, group_name);
        assert_eq!(asset.file_name, file_name);
        assert_eq!((asset.width, asset.height), (width, height));
        assert_eq!(asset.scale, scale);
        assert_eq!(sha256_hex(&asset.bytes), digest, "digest for {file_name}");
    }
}

fn solid(width: u32, height: u32, color: [u8; 4]) -> PixelData {
    PixelData::rgba8(width, height, color.repeat((width * height) as usize))
}

/// Four identically named top-level groups — exercises ordering and rename pins
/// without depending on fixture content for those paths.
fn duplicate_name_psd() -> Psd {
    let colors = [
        [255, 0, 0, 255],
        [0, 255, 0, 255],
        [0, 0, 255, 255],
        [255, 255, 0, 255],
    ];
    let children = colors
        .into_iter()
        .map(|color| {
            let pixel = Layer {
                left: Some(0.0),
                top: Some(0.0),
                right: Some(2.0),
                bottom: Some(2.0),
                image_data: Some(solid(2, 2, color)),
                ..Layer::default()
            };
            Layer {
                additional_info: LayerAdditionalInfo {
                    name: Some("Same Name".into()),
                    ..LayerAdditionalInfo::default()
                },
                children: Some(vec![pixel]),
                ..Layer::default()
            }
        })
        .collect();
    Psd {
        width: 2.0,
        height: 2.0,
        children: Some(children),
        ..Psd::default()
    }
}

#[test]
fn pins_png_jpeg_gif_digests_for_group_fixtures() {
    if require_fixtures(&["groups", "nested", "group-drop-shadows", "artboards"]) {
        return;
    }

    // groups — one exportable top-level group
    assert_assets(
        &export(&load_fixture("groups"), &off_options(ExportFormat::Png)),
        &[(
            "Group 1",
            "Group 1.png",
            273,
            189,
            1.0,
            "3c32473ed7e1e7bfb73dffa4c6a70be9dabaff9a976c8868bde1135b85143035",
        )],
    );
    assert_assets(
        &export(&load_fixture("groups"), &off_options(ExportFormat::Jpeg)),
        &[(
            "Group 1",
            "Group 1.jpg",
            273,
            189,
            1.0,
            "8624f58c603d76b74b6a9adf6f0e49fcb96ab1eb8bbec4f0d33f94f4decb2488",
        )],
    );
    assert_assets(
        &export(&load_fixture("groups"), &off_options(ExportFormat::Gif)),
        &[(
            "Group 1",
            "Group 1.gif",
            273,
            189,
            1.0,
            "ff016741ad10bacc353737c4b68b4d617be840c27e2c198d3f10a2db00d7d1e5",
        )],
    );

    // nested
    assert_assets(
        &export(&load_fixture("nested"), &off_options(ExportFormat::Png)),
        &[(
            "Folder1",
            "Folder1.png",
            1,
            1,
            1.0,
            "eb52dccdcd43a07c59b48944e7dfba6061dc8cdbf9b1d201f10da76cb2a858a3",
        )],
    );
    assert_assets(
        &export(&load_fixture("nested"), &off_options(ExportFormat::Jpeg)),
        &[(
            "Folder1",
            "Folder1.jpg",
            1,
            1,
            1.0,
            "f704dfe1f0a40acd651f32e46e8f7977c2e6e9d602d1b72733280cf195eb04ea",
        )],
    );
    assert_assets(
        &export(&load_fixture("nested"), &off_options(ExportFormat::Gif)),
        &[(
            "Folder1",
            "Folder1.gif",
            1,
            1,
            1.0,
            "e3a9cf663ad1478643a84c1d4ee1036cd2e0b49f865763374817434f02d13ffa",
        )],
    );

    // group-drop-shadows
    assert_assets(
        &export(
            &load_fixture("group-drop-shadows"),
            &off_options(ExportFormat::Png),
        ),
        &[(
            "Group 1",
            "Group 1.png",
            376,
            718,
            1.0,
            "2ca22eefb9f0c237eaaa6c8fb7569d33f792aa5418832b71a93cf25856cf3f8a",
        )],
    );
    assert_assets(
        &export(
            &load_fixture("group-drop-shadows"),
            &off_options(ExportFormat::Jpeg),
        ),
        &[(
            "Group 1",
            "Group 1.jpg",
            376,
            718,
            1.0,
            "070a4a27240e8544c153204d707a4e93a5d30e2862eec34c2681b15e8db1ec10",
        )],
    );
    assert_assets(
        &export(
            &load_fixture("group-drop-shadows"),
            &off_options(ExportFormat::Gif),
        ),
        &[(
            "Group 1",
            "Group 1.gif",
            376,
            718,
            1.0,
            "1c8334d12e98d5f5addd4fe74be2effcd73710b77d22657d5aaebada725ed89c",
        )],
    );

    // artboards — ordering is by content top, then top-level index
    assert_assets(
        &export(&load_fixture("artboards"), &off_options(ExportFormat::Png)),
        &[
            (
                "transparent board",
                "transparent board.png",
                1930,
                306,
                1.0,
                "56446d205df91d92bcb32eea72cef84063b1512c648709dff068c35fbfcb8b3f",
            ),
            (
                "white board",
                "white board.png",
                469,
                233,
                1.0,
                "4d1dde38d2f021d6dbe9cc4ba6aa9eb688a077f436c78448745aae9b9a8209ea",
            ),
        ],
    );
    assert_assets(
        &export(&load_fixture("artboards"), &off_options(ExportFormat::Jpeg)),
        &[
            (
                "transparent board",
                "transparent board.jpg",
                1930,
                306,
                1.0,
                "ef3c7c41e5631d7c9e4d1f457ac23ab30531fb0bc41609da107bdd9f56518958",
            ),
            (
                "white board",
                "white board.jpg",
                469,
                233,
                1.0,
                "25583dccff5d6dd9fab1b56b8f565326fa16001a3d11ab35280971490c205619",
            ),
        ],
    );
    assert_assets(
        &export(&load_fixture("artboards"), &off_options(ExportFormat::Gif)),
        &[
            (
                "transparent board",
                "transparent board.gif",
                1930,
                306,
                1.0,
                "79e5f377dbb5bffadbb48e9b08f59086579ad22f9e32c15e6d2110e304d0636a",
            ),
            (
                "white board",
                "white board.gif",
                469,
                233,
                1.0,
                "56f170b645204604c16ca1b5b34564178319d26bc26e904526756bdf9b80cd8d",
            ),
        ],
    );
}

#[test]
fn pins_scales_bounds_modes_and_transparency_toggle() {
    if skip_missing("groups") {
        return;
    }
    let psd = load_fixture("groups");

    let multi = export(
        &psd,
        &ExportOptions {
            format: ExportFormat::Png,
            bounds: ExportBounds::Trim,
            png_transparency: true,
            concurrency: ExportConcurrency::Off,
            scales: vec![
                ExportScale {
                    factor: 1.0,
                    suffix: String::new(),
                },
                ExportScale {
                    factor: 0.5,
                    suffix: "@0.5x".into(),
                },
                ExportScale {
                    factor: 2.0,
                    suffix: "@2x".into(),
                },
            ],
            ..ExportOptions::default()
        },
    );
    assert_assets(
        &multi,
        &[
            (
                "Group 1",
                "Group 1.png",
                273,
                189,
                1.0,
                "3c32473ed7e1e7bfb73dffa4c6a70be9dabaff9a976c8868bde1135b85143035",
            ),
            (
                "Group 1",
                "Group 1_0.5x.png",
                137,
                95,
                0.5,
                "ff127e4ffb51ebb8ed07480d3ca540ef879195d00a88d0fd1752c84ade70e6f9",
            ),
            (
                "Group 1",
                "Group 1_2x.png",
                546,
                378,
                2.0,
                "97bbd51275828ec219a54f08aed750a1b30d71cf8543a59317a59b4e2ffb6cf3",
            ),
        ],
    );

    let canvas_opaque = export(
        &psd,
        &ExportOptions {
            format: ExportFormat::Png,
            bounds: ExportBounds::Canvas,
            png_transparency: false,
            concurrency: ExportConcurrency::Off,
            ..ExportOptions::default()
        },
    );
    assert_assets(
        &canvas_opaque,
        &[(
            "Group 1",
            "Group 1.png",
            300,
            200,
            1.0,
            "0801188859001594e55db0f472dcc019f2bbdddb1059254f2170fc2b1df4b53c",
        )],
    );
    // IHDR color type byte: RGB (no alpha) when transparency is off.
    assert_eq!(canvas_opaque.assets[0].bytes[25], 2);

    let trim_transparent = export(&psd, &off_options(ExportFormat::Png));
    assert_eq!(trim_transparent.assets[0].bytes[25], 6);
}

#[test]
fn pins_asset_ordering_filenames_and_duplicate_renaming() {
    if skip_missing("groups") {
        return;
    }

    // base_name derivation + sanitization through the public options surface
    let named = export(
        &load_fixture("groups"),
        &ExportOptions {
            base_name: Some("My Export!".into()),
            concurrency: ExportConcurrency::Off,
            ..ExportOptions::default()
        },
    );
    assert_eq!(named.assets[0].file_name, "My Export_-1.png");

    // duplicate scale suffixes collide, then rename
    let dup_scales = export(
        &load_fixture("groups"),
        &ExportOptions {
            concurrency: ExportConcurrency::Off,
            scales: vec![
                ExportScale {
                    factor: 1.0,
                    suffix: String::new(),
                },
                ExportScale {
                    factor: 0.5,
                    suffix: String::new(),
                },
            ],
            ..ExportOptions::default()
        },
    );
    assert_eq!(dup_scales.assets[0].file_name, "Group 1.png");
    assert_eq!(dup_scales.assets[1].file_name, "Group 1-2.png");
    assert!(dup_scales.warnings.iter().any(|w| {
        w == "duplicate output name \"Group 1.png\" was renamed to \"Group 1-2.png\""
    }));

    // identical group names across top-level exports
    let dup_groups = export(
        &duplicate_name_psd(),
        &ExportOptions {
            concurrency: ExportConcurrency::Off,
            ..ExportOptions::default()
        },
    );
    assert_eq!(
        dup_groups
            .assets
            .iter()
            .map(|a| a.file_name.as_str())
            .collect::<Vec<_>>(),
        [
            "Same Name.png",
            "Same Name-2.png",
            "Same Name-3.png",
            "Same Name-4.png"
        ]
    );
    assert_eq!(
        dup_groups.warnings,
        [
            "duplicate output name \"Same Name.png\" was renamed to \"Same Name-2.png\"",
            "duplicate output name \"Same Name.png\" was renamed to \"Same Name-3.png\"",
            "duplicate output name \"Same Name.png\" was renamed to \"Same Name-4.png\"",
        ]
    );
}

#[test]
fn pins_warning_text_and_error_variants() {
    let psd = if let Some(path) = fixture_psd("groups") {
        let bytes = fs::read(path).expect("read fixture");
        read_psd(&bytes, &ReadOptions::default()).expect("read_psd")
    } else {
        eprintln!("skip groups: fixture missing (run {FETCH_FIXTURES})");
        // Error paths do not need fixture pixels — any document with groups works.
        duplicate_name_psd()
    };

    let quality = export_groups(
        &psd,
        &ExportOptions {
            format: ExportFormat::Jpeg,
            jpeg_quality: 8,
            concurrency: ExportConcurrency::Off,
            ..ExportOptions::default()
        },
    )
    .unwrap_err();
    assert!(matches!(quality, ExportError::InvalidJpegQuality(8)));
    assert_eq!(
        quality.to_string(),
        "JPEG quality must be in Photoshop's 0..=7 range, got 8"
    );

    let scale = export_groups(
        &psd,
        &ExportOptions {
            scales: vec![ExportScale {
                factor: 0.0,
                suffix: String::new(),
            }],
            concurrency: ExportConcurrency::Off,
            ..ExportOptions::default()
        },
    )
    .unwrap_err();
    assert!(matches!(scale, ExportError::InvalidScale(v) if v == 0.0));
    assert_eq!(scale.to_string(), "invalid export scale: 0");

    let workers = export_groups(
        &psd,
        &ExportOptions {
            concurrency: ExportConcurrency::Fixed(0),
            ..ExportOptions::default()
        },
    )
    .unwrap_err();
    assert!(matches!(workers, ExportError::InvalidConcurrency(0)));
    assert_eq!(
        workers.to_string(),
        "fixed export concurrency must be at least 1, got 0"
    );

    let limited = export(
        &duplicate_name_psd(),
        &ExportOptions {
            concurrency: ExportConcurrency::Fixed(4),
            parallel_memory_limit_bytes: Some(1),
            ..ExportOptions::default()
        },
    );
    assert_eq!(limited.workers_used, 1);
    assert_eq!(
        limited.warnings[0],
        "parallel export workers reduced from 4 to 1 by the 0 MiB memory limit"
    );
}

#[test]
fn pinned_export_output_is_deterministic() {
    if skip_missing("groups") {
        return;
    }
    let psd = load_fixture("groups");
    let options = ExportOptions {
        format: ExportFormat::Png,
        bounds: ExportBounds::Trim,
        png_transparency: true,
        concurrency: ExportConcurrency::Off,
        scales: vec![
            ExportScale {
                factor: 1.0,
                suffix: String::new(),
            },
            ExportScale {
                factor: 0.5,
                suffix: "@0.5x".into(),
            },
        ],
        ..ExportOptions::default()
    };

    let first = export(&psd, &options);
    let second = export(&psd, &options);
    assert_eq!(first.assets.len(), second.assets.len());
    for (a, b) in first.assets.iter().zip(&second.assets) {
        assert_eq!(a.file_name, b.file_name);
        assert_eq!(a.bytes, b.bytes);
        assert_eq!(sha256_hex(&a.bytes), sha256_hex(&b.bytes));
    }
    assert_eq!(first.warnings, second.warnings);

    // JPEG / GIF too — encoders must not drift across identical calls.
    for format in [ExportFormat::Jpeg, ExportFormat::Gif] {
        let opts = off_options(format);
        let a = export(&psd, &opts);
        let b = export(&psd, &opts);
        assert_eq!(a.assets[0].bytes, b.assets[0].bytes);
    }
}

use super::*;
use crate::psd::{Layer, LayerAdditionalInfo, PixelData};

fn solid(width: u32, height: u32, color: [u8; 4]) -> PixelData {
    PixelData::rgba8(width, height, color.repeat((width * height) as usize))
}

fn sample_psd() -> Psd {
    let red = Layer {
        left: Some(1.0),
        top: Some(1.0),
        right: Some(3.0),
        bottom: Some(3.0),
        image_data: Some(solid(2, 2, [255, 0, 0, 255])),
        ..Layer::default()
    };
    let group = Layer {
        additional_info: LayerAdditionalInfo {
            name: Some("Artwork".into()),
            ..LayerAdditionalInfo::default()
        },
        children: Some(vec![red]),
        ..Layer::default()
    };
    Psd {
        width: 4.0,
        height: 4.0,
        children: Some(vec![group]),
        ..Psd::default()
    }
}

fn multi_group_psd() -> Psd {
    let colors = [
        [255, 0, 0, 255],
        [0, 255, 0, 255],
        [0, 0, 255, 255],
        [255, 255, 0, 255],
    ];
    let children = colors
        .into_iter()
        .enumerate()
        .map(|(index, color)| {
            let pixels = Layer {
                left: Some(0.0),
                top: Some(0.0),
                right: Some(2.0),
                bottom: Some(2.0),
                image_data: Some(solid(2, 2, color)),
                ..Layer::default()
            };
            Layer {
                additional_info: LayerAdditionalInfo {
                    name: Some(format!("Group {index}")),
                    ..LayerAdditionalInfo::default()
                },
                children: Some(vec![pixels]),
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

fn named_group(name: &str, top: f64, color: [u8; 4]) -> Layer {
    let pixels = Layer {
        left: Some(0.0),
        top: Some(top),
        right: Some(2.0),
        bottom: Some(top + 2.0),
        image_data: Some(solid(2, 2, color)),
        ..Layer::default()
    };
    Layer {
        additional_info: LayerAdditionalInfo {
            name: Some(name.into()),
            ..LayerAdditionalInfo::default()
        },
        children: Some(vec![pixels]),
        ..Layer::default()
    }
}

#[test]
fn export_uses_photoshop_panel_order_for_slice_ordinals() {
    let psd = Psd {
        width: 2.0,
        height: 10.0,
        // Parsed children retain bottom-to-top compositing order. Canvas
        // positions are also deliberately different from panel order.
        children: Some(vec![
            named_group("PSD panel third", 1.0, [0, 0, 255, 255]),
            named_group("PSD panel second", 7.0, [0, 255, 0, 255]),
            named_group("PSD panel first", 4.0, [255, 0, 0, 255]),
        ]),
        ..Psd::default()
    };

    let result = export_groups(
        &psd,
        &ExportOptions {
            concurrency: ExportConcurrency::Off,
            ..ExportOptions::default()
        },
    )
    .unwrap();

    assert_eq!(
        result
            .assets
            .iter()
            .map(|asset| asset.group_name.as_str())
            .collect::<Vec<_>>(),
        ["PSD panel first", "PSD panel second", "PSD panel third"]
    );
}

#[test]
fn exports_trimmed_png() {
    let result = export_groups(&sample_psd(), &ExportOptions::default()).unwrap();
    assert_eq!(result.assets.len(), 1);
    assert_eq!((result.assets[0].width, result.assets[0].height), (2, 2));
    assert_eq!(&result.assets[0].bytes[..8], b"\x89PNG\r\n\x1a\n");
}

#[test]
fn exports_jpeg_with_photoshop_quality() {
    let options = ExportOptions {
        format: ExportFormat::Jpeg,
        jpeg_quality: 7,
        ..ExportOptions::default()
    };
    let result = export_groups(&sample_psd(), &options).unwrap();
    assert_eq!(&result.assets[0].bytes[..2], &[0xff, 0xd8]);
}

#[test]
fn exports_gif_and_applies_image_and_canvas_size() {
    let options = ExportOptions {
        format: ExportFormat::Gif,
        image_size: Some(ImageSize {
            width: 4,
            height: 4,
        }),
        canvas_size: Some(CanvasSize {
            width: 6,
            height: 5,
            anchor: CanvasAnchor::Center,
        }),
        ..ExportOptions::default()
    };
    let result = export_groups(&sample_psd(), &options).unwrap();
    assert_eq!((result.assets[0].width, result.assets[0].height), (6, 5));
    assert_eq!(&result.assets[0].bytes[..6], b"GIF89a");
}

#[test]
fn supports_all_photoshop_resampling_choices() {
    let methods = [
        ResampleMethod::Bicubic,
        ResampleMethod::Automatic,
        ResampleMethod::BicubicSharper,
        ResampleMethod::BicubicSmoother,
        ResampleMethod::Bilinear,
        ResampleMethod::Nearest,
        ResampleMethod::PreserveDetails,
    ];
    for resample in methods {
        let result = export_groups(
            &sample_psd(),
            &ExportOptions {
                image_size: Some(ImageSize {
                    width: 3,
                    height: 3,
                }),
                resample,
                ..ExportOptions::default()
            },
        )
        .unwrap();
        assert_eq!((result.assets[0].width, result.assets[0].height), (3, 3));
    }
}

#[test]
fn png_transparency_toggle_changes_png_color_type() {
    let transparent = export_groups(&sample_psd(), &ExportOptions::default()).unwrap();
    let opaque = export_groups(
        &sample_psd(),
        &ExportOptions {
            png_transparency: false,
            ..ExportOptions::default()
        },
    )
    .unwrap();
    assert_eq!(transparent.assets[0].bytes[25], 6, "RGBA PNG");
    assert_eq!(opaque.assets[0].bytes[25], 2, "RGB PNG");
}

#[test]
fn rejects_quality_outside_photoshop_range() {
    let error = export_groups(
        &sample_psd(),
        &ExportOptions {
            format: ExportFormat::Jpeg,
            jpeg_quality: 8,
            ..ExportOptions::default()
        },
    )
    .unwrap_err();
    assert!(matches!(error, ExportError::InvalidJpegQuality(8)));
}

#[test]
fn parallel_and_sequential_exports_are_byte_identical_and_ordered() {
    let psd = multi_group_psd();
    let sequential = export_groups(
        &psd,
        &ExportOptions {
            concurrency: ExportConcurrency::Off,
            ..ExportOptions::default()
        },
    )
    .unwrap();
    let parallel = export_groups(
        &psd,
        &ExportOptions {
            concurrency: ExportConcurrency::Fixed(3),
            parallel_memory_limit_bytes: None,
            ..ExportOptions::default()
        },
    )
    .unwrap();
    assert_eq!(parallel.assets.len(), sequential.assets.len());
    for (parallel, sequential) in parallel.assets.iter().zip(&sequential.assets) {
        assert_eq!(parallel.top_level_index, sequential.top_level_index);
        assert_eq!(parallel.group_name, sequential.group_name);
        assert_eq!(parallel.file_name, sequential.file_name);
        assert_eq!(parallel.bytes, sequential.bytes);
    }
    assert_eq!(
        parallel
            .assets
            .iter()
            .map(|asset| asset.group_name.as_str())
            .collect::<Vec<_>>(),
        ["Group 3", "Group 2", "Group 1", "Group 0"]
    );
}

#[test]
fn memory_limit_caps_parallelism_and_zero_workers_is_rejected() {
    let psd = multi_group_psd();
    let limited = export_groups(
        &psd,
        &ExportOptions {
            concurrency: ExportConcurrency::Fixed(4),
            parallel_memory_limit_bytes: Some(1),
            ..ExportOptions::default()
        },
    )
    .unwrap();
    assert!(
        limited
            .warnings
            .iter()
            .any(|warning| warning.contains("reduced from 4 to 1"))
    );

    // Auto uses the same memory-cap warning path.
    let auto = export_groups(
        &psd,
        &ExportOptions {
            concurrency: ExportConcurrency::Auto,
            parallel_memory_limit_bytes: Some(1),
            ..ExportOptions::default()
        },
    )
    .unwrap();
    assert_eq!(auto.workers_used, 1);
    let host = thread::available_parallelism().map_or(1, usize::from);
    if host > 1 {
        assert!(
            auto.warnings
                .iter()
                .any(|warning| warning.contains("reduced from")
                    && warning.contains("memory limit")),
            "Auto must report memory-budget reductions, got {:?}",
            auto.warnings
        );
    }

    let error = export_groups(
        &psd,
        &ExportOptions {
            concurrency: ExportConcurrency::Fixed(0),
            ..ExportOptions::default()
        },
    )
    .unwrap_err();
    assert!(matches!(error, ExportError::InvalidConcurrency(0)));
}

#[test]
fn wasm_fixed_concurrency_degrades_to_sequential_with_report() {
    let (workers, warning) = crate::degrade_export_workers(4, true);
    assert_eq!(workers, 1);
    assert!(
        warning
            .as_deref()
            .is_some_and(|text| text.contains("WebAssembly") && text.contains("1 worker"))
    );
    assert_eq!(crate::degrade_export_workers(4, false), (4, None));
    assert_eq!(crate::degrade_export_workers(1, true), (1, None));
}

#[test]
fn memory_worker_cap_reports_for_any_requested_count() {
    let (workers, warning) = memory_worker_cap(8, Some(1), 100);
    assert_eq!(workers, 1);
    assert!(
        warning
            .as_deref()
            .is_some_and(|text| text.contains("reduced from 8 to 1"))
    );
    assert_eq!(memory_worker_cap(2, None, 100), (2, None));
}

#[test]
fn unchanged_size_borrows_the_original_rgba_buffer() {
    let rgba = vec![1, 2, 3, 4];
    let resized = encode::resize_rgba(&rgba, 1, 1, 1, 1, ResampleMethod::Automatic).unwrap();
    assert!(matches!(resized, std::borrow::Cow::Borrowed(_)));
}

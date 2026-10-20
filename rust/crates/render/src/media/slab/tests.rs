use super::*;
use crate::media::document::plan_top_group_exports;
use crate::psd::render::{LayerMask, PlacedLayerInfo};
use crate::psd::{Bitmap, LayerNode, PlacedGeom, SourceContent};
use psdx::placed::MeshGrid;

fn layer(name: &str, left: i64, top: i64, width: u32, height: u32) -> LayerNode {
    let mut data = Vec::with_capacity(width as usize * height as usize * 4);
    for y in 0..height {
        for x in 0..width {
            data.extend_from_slice(&[
                (20 + x * 7) as u8,
                (40 + y * 11) as u8,
                180,
                if x == 0 && y == 0 { 0 } else { 255 },
            ]);
        }
    }
    LayerNode {
        name: name.to_owned(),
        left,
        top,
        right: left + i64::from(width),
        bottom: top + i64::from(height),
        blend_mode: "normal".to_owned(),
        opacity: 1.0,
        fill_opacity: 1.0,
        hidden: false,
        clipping: false,
        mask: None,
        placed: None,
        image_data: Some(Bitmap {
            data,
            width,
            height,
        }),
        children: Vec::new(),
    }
}

fn basic_document() -> RenderDocument {
    let child = layer("pixels", 1, 2, 8, 6);
    RenderDocument {
        width: 12,
        height: 12,
        children: vec![LayerNode {
            name: "export".to_owned(),
            left: 0,
            top: 0,
            right: 12,
            bottom: 12,
            blend_mode: "pass through".to_owned(),
            opacity: 1.0,
            fill_opacity: 1.0,
            hidden: false,
            clipping: false,
            mask: None,
            placed: None,
            image_data: None,
            children: vec![child],
        }],
        linked_files: Vec::new(),
    }
}

fn collect_document(document: RenderDocument, config: SlabConfig) -> (PreparedSlabExport, Vec<u8>) {
    collect_document_with_replacements(document, config, HashMap::new())
}

fn collect_document_with_replacements(
    document: RenderDocument,
    config: SlabConfig,
    replacements: HashMap<String, SourceContent>,
) -> (PreparedSlabExport, Vec<u8>) {
    let plan = plan_top_group_exports(&document);
    let group = &plan.groups[0];
    let prepared = prepare_group_export(
        &document,
        group,
        &replacements,
        ExportBounds::Trim,
        1.0,
        config,
        crate::psd::ProductResourcePolicy::default(),
        None,
        None,
        0,
    )
    .expect("prepare");
    let rows = SlabRgbaRows::new(
        &document,
        group,
        &replacements,
        prepared.clone(),
        config,
        None,
        None,
    );
    let mut output = Vec::new();
    let mut row = Vec::new();
    for y in 0..rows.height() {
        rows.read_rgba_row(y, &mut row).expect("row");
        output.extend_from_slice(&row);
    }
    (prepared, output)
}

fn collect(config: SlabConfig) -> (PreparedSlabExport, Vec<u8>) {
    collect_document(basic_document(), config)
}

#[test]
fn forced_small_slabs_match_one_band_reference_pixels() {
    let (small, small_pixels) = collect(SlabConfig { rows: 2 });
    let (reference, reference_pixels) = collect(SlabConfig { rows: 64 });
    assert_eq!(small.export_rect, reference.export_rect);
    assert_eq!(small_pixels, reference_pixels);
    assert!(small.observations.reserved_bytes < reference.observations.reserved_bytes);
}

/// The render loop stays slab-bounded and single-lane.
///
/// Slab bounding is the memory invariant: a group is encoded from bands, never
/// from a prepared full-frame RGBA. Single-lane is the platform:
/// `wasm32-unknown-unknown` has no threads — `thread::spawn` returns
/// `Err(Unsupported)` at runtime — so a scheduler reintroduced here would fail
/// every render in the browser rather than fail to compile.
#[test]
fn the_render_loop_is_slab_bounded_and_single_lane() {
    let render = include_str!("../render/mod.rs");
    let groups = include_str!("../render/groups.rs");
    let prepared_rgba = ["Prepared", "Slice"].concat();
    assert!(!render.contains(&prepared_rgba));
    assert!(groups.contains("prepare_group_export"));
    assert!(groups.contains("SlabRgbaRows"));
    assert!(render.contains("while let Some(task) = tasks.pop_front()"));
    for banned in ["std::thread", "spawn", "mpsc", "rayon", "catch_unwind"] {
        assert!(
            !render.contains(banned),
            "render/mod.rs must not use {banned}"
        );
        assert!(
            !groups.contains(banned),
            "render/groups.rs must not use {banned}"
        );
    }
    assert!(!render.contains("MAX_INFLIGHT_ENCODES"));
    assert!(!render.contains("PendingEncode"));
}

#[test]
fn window_rows_match_slab_refill_rows_for_trim_and_canvas_exports() {
    for export_bounds in [ExportBounds::Trim, ExportBounds::Canvas] {
        let document = basic_document();
        let plan = plan_top_group_exports(&document);
        let group = &plan.groups[0];
        let replacements = HashMap::new();
        let config = SlabConfig { rows: 2 };
        let windowed = prepare_group_export(
            &document,
            group,
            &replacements,
            export_bounds,
            1.0,
            config,
            crate::psd::ProductResourcePolicy::default(),
            None,
            None,
            0,
        )
        .expect("windowed prepare");
        let window = windowed.reuse_window().expect("window admitted");
        let starved = prepare_group_export(
            &document,
            group,
            &replacements,
            export_bounds,
            1.0,
            config,
            crate::psd::ProductResourcePolicy {
                max_canvas_pixels: 1,
                ..crate::psd::ProductResourcePolicy::default()
            },
            None,
            None,
            0,
        )
        .expect("starved prepare");
        assert!(starved.reuse_window().is_none(), "window must be starved");
        assert_eq!(starved.export_rect, windowed.export_rect);

        let window_rows = WindowRgbaRows::new(window, &document, group, &windowed, None);
        let slab_rows = SlabRgbaRows::new(
            &document,
            group,
            &replacements,
            starved.clone(),
            config,
            None,
            None,
        );
        let mut window_pixels = Vec::new();
        let mut slab_pixels = Vec::new();
        let mut row = Vec::new();
        for y in 0..window_rows.height() {
            window_rows.read_rgba_row(y, &mut row).expect("window row");
            window_pixels.extend_from_slice(&row);
            slab_rows.read_rgba_row(y, &mut row).expect("slab row");
            slab_pixels.extend_from_slice(&row);
        }
        assert_eq!(window_pixels, slab_pixels, "bounds={export_bounds:?}");
    }
}

#[test]
fn cancellation_is_observed_in_both_render_passes() {
    let document = basic_document();
    let plan = plan_top_group_exports(&document);
    let group = &plan.groups[0];
    let replacements = HashMap::new();
    let cancelled = ReadCancellationToken::new();
    cancelled.cancel();
    let first = prepare_group_export(
        &document,
        group,
        &replacements,
        ExportBounds::Trim,
        1.0,
        SlabConfig { rows: 2 },
        crate::psd::ProductResourcePolicy::default(),
        Some(&cancelled),
        None,
        0,
    )
    .unwrap_err();
    assert_eq!(first.code, MediaErrorCode::Aborted);
    assert_eq!(first.phase, "render-pass-1");

    let prepared = prepare_group_export(
        &document,
        group,
        &replacements,
        ExportBounds::Trim,
        1.0,
        SlabConfig { rows: 2 },
        crate::psd::ProductResourcePolicy::default(),
        None,
        None,
        0,
    )
    .expect("prepare");
    let second_cancelled = ReadCancellationToken::new();
    second_cancelled.cancel();
    let rows = SlabRgbaRows::new(
        &document,
        group,
        &replacements,
        prepared,
        SlabConfig { rows: 2 },
        Some(second_cancelled),
        None,
    );
    let second = rows.read_rgba_row(0, &mut Vec::new()).unwrap_err();
    assert_eq!(second.code, MediaErrorCode::Aborted);
    assert_eq!(second.phase, "render-pass-2");
}

fn capability_document(mode: &str, with_clip: bool, with_mask: bool) -> RenderDocument {
    let mut base = layer("base", 0, 0, 12, 12);
    base.image_data.as_mut().unwrap().data.fill(180);
    for alpha in base.image_data.as_mut().unwrap().data[3..]
        .iter_mut()
        .step_by(4)
    {
        *alpha = 255;
    }
    if with_mask {
        let mut mask = vec![0_u8; 12 * 12 * 4];
        for pixel in mask.chunks_exact_mut(4) {
            pixel[0] = 128;
            pixel[3] = 255;
        }
        base.mask = Some(LayerMask {
            left: 0,
            top: 0,
            right: 12,
            bottom: 12,
            default_color: 0,
            disabled: false,
            image_data: Some(Bitmap {
                data: mask,
                width: 12,
                height: 12,
            }),
        });
    }
    let mut upper = layer("upper", 0, 0, 12, 12);
    upper.blend_mode = mode.to_owned();
    upper.opacity = 0.75;
    upper.clipping = with_clip;
    for pixel in upper.image_data.as_mut().unwrap().data.chunks_exact_mut(4) {
        pixel.copy_from_slice(&[220, 40, 80, 200]);
    }
    RenderDocument {
        width: 12,
        height: 12,
        children: vec![LayerNode {
            name: "export".to_owned(),
            left: 0,
            top: 0,
            right: 12,
            bottom: 12,
            blend_mode: "pass through".to_owned(),
            opacity: 1.0,
            fill_opacity: 1.0,
            hidden: false,
            clipping: false,
            mask: None,
            placed: None,
            image_data: None,
            children: vec![base, upper],
        }],
        linked_files: Vec::new(),
    }
}

#[test]
fn masks_and_clipping_preserve_pixels_across_boundaries() {
    for (with_mask, with_clip) in [(true, false), (false, true), (true, true)] {
        let (_, small) = collect_document(
            capability_document("normal", with_clip, with_mask),
            SlabConfig { rows: 3 },
        );
        let (_, reference) = collect_document(
            capability_document("normal", with_clip, with_mask),
            SlabConfig { rows: 64 },
        );
        assert_eq!(small, reference, "mask={with_mask} clip={with_clip}");
    }
}

#[test]
fn uniform_mask_matches_the_independent_alpha_equation() {
    let mut document = capability_document("normal", false, true);
    document.children[0].children.pop();
    let (_, pixels) = collect_document(document, SlabConfig { rows: 3 });
    assert_eq!(&pixels[..4], &[180, 180, 180, 128]);
}

#[test]
fn approved_blends_match_one_band_for_every_slab_size() {
    for mode in [
        "normal",
        "multiply",
        "screen",
        "darken",
        "lighten",
        "overlay",
        "hard light",
    ] {
        let (_, reference) = collect_document(
            capability_document(mode, false, true),
            SlabConfig { rows: 64 },
        );
        for rows in [1, 2, 3, 5] {
            let (_, actual) =
                collect_document(capability_document(mode, false, true), SlabConfig { rows });
            assert_eq!(actual, reference, "mode={mode} rows={rows}");
        }
    }
}

fn smart_object_document(with_mesh: bool) -> (RenderDocument, HashMap<String, SourceContent>) {
    let mesh = with_mesh.then(|| {
        let mut xs = Vec::new();
        let mut ys = Vec::new();
        for row in 0..4 {
            for column in 0..4 {
                xs.push(column as f64 * 8.0 / 3.0 + if row == 1 { 0.35 } else { 0.0 });
                ys.push(row as f64 * 8.0 / 3.0);
            }
        }
        MeshGrid {
            cols: 4,
            rows: 4,
            xs,
            ys,
            slices_x: vec![0.0, 8.0],
            slices_y: vec![0.0, 8.0],
        }
    });
    let placed = LayerNode {
        name: "replacement".to_owned(),
        left: 2,
        top: 1,
        right: 14,
        bottom: 15,
        blend_mode: "normal".to_owned(),
        opacity: 1.0,
        fill_opacity: 1.0,
        hidden: false,
        clipping: false,
        mask: None,
        placed: Some(PlacedLayerInfo {
            id: "slot".to_owned(),
            width: 8.0,
            height: 8.0,
            geom: PlacedGeom {
                src_w: 8.0,
                src_h: 8.0,
                quad: vec![2.0, 1.0, 14.0, 2.0, 13.0, 15.0, 3.0, 14.0],
                mesh,
            },
        }),
        image_data: None,
        children: Vec::new(),
    };
    let document = RenderDocument {
        width: 16,
        height: 16,
        children: vec![LayerNode {
            name: "export".to_owned(),
            left: 0,
            top: 0,
            right: 16,
            bottom: 16,
            blend_mode: "pass through".to_owned(),
            opacity: 1.0,
            fill_opacity: 1.0,
            hidden: false,
            clipping: false,
            mask: None,
            placed: None,
            image_data: None,
            children: vec![placed],
        }],
        linked_files: Vec::new(),
    };
    let mut data = Vec::new();
    for y in 0..8_u8 {
        for x in 0..8_u8 {
            data.extend_from_slice(&[x * 24, y * 24, 220, 255]);
        }
    }
    let replacements = HashMap::from([(
        "slot".to_owned(),
        SourceContent {
            data,
            width: 8,
            height: 8,
        },
    )]);
    (document, replacements)
}

#[test]
fn smart_object_replacement_and_warp_match_across_slab_boundaries() {
    for with_mesh in [false, true] {
        let (document, replacements) = smart_object_document(with_mesh);
        let (_, reference) = collect_document_with_replacements(
            document.clone(),
            SlabConfig { rows: 64 },
            replacements.clone(),
        );
        for rows in [1, 2, 3, 5] {
            let (_, actual) = collect_document_with_replacements(
                document.clone(),
                SlabConfig { rows },
                replacements.clone(),
            );
            assert_eq!(actual, reference, "mesh={with_mesh} rows={rows}");
        }
    }
}

#[test]
fn representative_tall_canvas_renders_with_a_fixed_slab_reservation() {
    let child = layer("tall pixels", 4, 0, 32, 25_600);
    let document = RenderDocument {
        width: 2_400,
        height: 25_600,
        children: vec![LayerNode {
            name: "tall export".to_owned(),
            left: 0,
            top: 0,
            right: 2_400,
            bottom: 25_600,
            blend_mode: "pass through".to_owned(),
            opacity: 1.0,
            fill_opacity: 1.0,
            hidden: false,
            clipping: false,
            mask: None,
            placed: None,
            image_data: None,
            children: vec![child],
        }],
        linked_files: Vec::new(),
    };
    let (prepared, pixels) = collect_document(document, SlabConfig { rows: 128 });
    assert_eq!(
        (prepared.output_width, prepared.output_height),
        (32, 25_600)
    );
    assert_eq!(pixels.len(), 32 * 25_600 * 4);
    assert_eq!(prepared.observations.rows, 128);
    assert!(prepared.observations.reserved_bytes < 32 * 1024 * 1024);
}

/// Geometry of the representative corpus template the 103.2 MiB live-byte
/// ceiling was derived from: 2400 x 25600 in eight equal groups.
fn adr_corpus_inputs(shared_resident_bytes: u64) -> LiveCeilingInputs {
    LiveCeilingInputs {
        document_width: 2_400,
        slab_rows: DEFAULT_SLAB_ROWS,
        halo_rows: RESAMPLE_HALO_ROWS,
        group_height: 25_600 / 8,
        // Two, written out rather than read from the shipped pipeline depth:
        // this fixture reproduces a historical derivation, and the depth is now
        // decided per render. Coupling them would let a concurrency change
        // silently redefine the derived number.
        live_windows: 2,
        shared_resident_bytes,
        // The historical corpus template was flat, so nothing nested is priced.
        nested_group_levels: 0,
    }
}

#[test]
fn the_live_ceiling_derivation_reproduces_the_number_decision_six_was_built_on() {
    // 6,192,000 slab reservation + 2 x 30,720,000 windows, divided by
    // 1 - 1/4 - 1/8: the expression behind the 103.2 MiB figure.
    let ceiling = saturating_live_bytes(adr_corpus_inputs(0)).expect("ceiling");
    assert_eq!(ceiling, 108_211_200);
    assert_eq!(
        slab_reservation_bytes(2_400, DEFAULT_SLAB_ROWS, RESAMPLE_HALO_ROWS).unwrap(),
        6_192_000,
    );
    let live = crate::psd::ProductResourcePolicy::default().max_parser_live_bytes as u64;
    assert_eq!(live / ceiling, 4, "the quotient decision 6 quotes as 4.96");
}

#[test]
fn folding_a_resident_template_into_the_same_derivation_collapses_the_quotient_to_one() {
    // Decision 6 also requires the cached template to join the sum. One
    // full-canvas decoded RGBA of the same template is 2400 x 25600 x 4,
    // which is a lower bound on what the render holds resident.
    let ceiling = saturating_live_bytes(adr_corpus_inputs(2_400 * 25_600 * 4))
        .expect("ceiling with a resident template");
    assert_eq!(ceiling, 501_427_200);
    let live = crate::psd::ProductResourcePolicy::default().max_parser_live_bytes as u64;
    assert_eq!(
        live / ceiling,
        1,
        "the constant and its own premise cannot both hold; this is why the \
         slot count waits on measurements instead of on this arithmetic",
    );
}

#[test]
fn the_live_ceiling_derivation_refuses_to_report_a_small_number_on_overflow() {
    assert_eq!(
        saturating_live_bytes(LiveCeilingInputs {
            document_width: u32::MAX,
            slab_rows: u32::MAX,
            halo_rows: u32::MAX,
            group_height: u32::MAX,
            live_windows: u64::MAX,
            shared_resident_bytes: u64::MAX,
            nested_group_levels: u64::MAX,
        }),
        None,
    );
}

#[test]
fn one_nested_group_level_is_priced_exactly_like_one_slab_reservation() {
    // A nested group composites into a full-width backdrop of slab height and
    // then copies it into a byte buffer while blending down, so it holds the
    // same 20 bytes per pixel the slab reservation already holds. Pricing it
    // any other way would make the ceiling depend on a number this module does
    // not own.
    let flat = adr_corpus_inputs(0);
    let reservation =
        slab_reservation_bytes(flat.document_width, flat.slab_rows, flat.halo_rows).unwrap();
    let one_level = saturating_live_bytes(LiveCeilingInputs {
        nested_group_levels: 1,
        ..flat
    })
    .expect("one nested level");
    let none = saturating_live_bytes(flat).expect("flat");
    assert_eq!(one_level - none, reservation * 8 / 5);
}

/// Wraps `children` in `levels` nested groups of the same bounds, then in the
/// exported group itself, so the returned document's only top-level group holds
/// `levels` groups below it.
fn nested_document(levels: usize) -> RenderDocument {
    let mut node = layer("pixels", 0, 0, 8, 8);
    for depth in 0..levels {
        node = LayerNode {
            name: format!("inner-{depth}"),
            left: 0,
            top: 0,
            right: 12,
            bottom: 12,
            blend_mode: "pass through".to_owned(),
            opacity: 1.0,
            fill_opacity: 1.0,
            hidden: false,
            clipping: false,
            mask: None,
            placed: None,
            image_data: None,
            children: vec![node],
        };
    }
    node = LayerNode {
        name: "export".to_owned(),
        left: 0,
        top: 0,
        right: 12,
        bottom: 12,
        blend_mode: "pass through".to_owned(),
        opacity: 1.0,
        fill_opacity: 1.0,
        hidden: false,
        clipping: false,
        mask: None,
        placed: None,
        image_data: None,
        children: vec![node],
    };
    RenderDocument {
        width: 12,
        height: 12,
        children: vec![node],
        linked_files: Vec::new(),
    }
}

#[test]
fn the_exported_group_counts_only_the_levels_below_it() {
    let document = nested_document(0);
    let group = plan_top_group_exports(&document).groups.remove(0);
    let exported = &document.children[group.layer_index];
    assert_eq!(
        nested_group_levels(exported),
        0,
        "a flat group nests nothing"
    );
    let document = nested_document(3);
    let group = plan_top_group_exports(&document).groups.remove(0);
    let exported = &document.children[group.layer_index];
    assert_eq!(nested_group_levels(exported), 3);
}

#[test]
fn a_wide_flat_tree_prices_no_nested_level() {
    // Eight sibling groups of leaves: nothing nests, so the derived ceiling is
    // the flat one even though the document holds eight groups.
    let mut children = Vec::new();
    for index in 0..8 {
        children.push(LayerNode {
            name: format!("group-{index}"),
            left: 0,
            top: 0,
            right: 12,
            bottom: 12,
            blend_mode: "pass through".to_owned(),
            opacity: 1.0,
            fill_opacity: 1.0,
            hidden: false,
            clipping: false,
            mask: None,
            placed: None,
            image_data: None,
            children: vec![layer("pixels", 0, 0, 8, 8)],
        });
    }
    let document = RenderDocument {
        width: 12,
        height: 12,
        children,
        linked_files: Vec::new(),
    };
    let wide = group_saturating_live_bytes(
        &document,
        &plan_top_group_exports(&document).groups[0],
        SlabConfig::default(),
        0,
    )
    .expect("wide ceiling");
    let single = nested_document(0);
    let flat = group_saturating_live_bytes(
        &single,
        &plan_top_group_exports(&single).groups[0],
        SlabConfig::default(),
        0,
    )
    .expect("flat ceiling");
    assert_eq!(wide, flat);
}

#[test]
fn nested_group_depth_prices_the_chain_and_not_the_group_count() {
    // Eight sibling groups that each hold a leaf are a flat document: no level
    // of nesting can be live at the same time as another. One group holding a
    // group holding a leaf stacks two backdrops below the exported one, and only
    // the deepest chain is live, so a wide tree stays cheap.
    let flat = adr_corpus_inputs(0);
    let deep = saturating_live_bytes(LiveCeilingInputs {
        nested_group_levels: 8,
        ..flat
    })
    .expect("eight nested levels");
    let reservation =
        slab_reservation_bytes(flat.document_width, flat.slab_rows, flat.halo_rows).unwrap();
    let none = saturating_live_bytes(flat).expect("flat");
    assert_eq!(deep - none, reservation * 8 * 8 / 5);
}

/// A placed layer whose warped instance cannot fit `live / 4`.
fn placed_budget_document() -> (RenderDocument, HashMap<String, SourceContent>) {
    smart_object_document(false)
}

#[test]
fn a_placed_preparation_the_budget_cannot_hold_reports_the_drop_it_takes() {
    let (document, replacements) = placed_budget_document();
    let plan = plan_top_group_exports(&document);
    let group = &plan.groups[0];
    let config = SlabConfig { rows: 2 };
    let generous = prepare_group_export(
        &document,
        group,
        &replacements,
        ExportBounds::Trim,
        1.0,
        config,
        crate::psd::ProductResourcePolicy::default(),
        None,
        None,
        0,
    )
    .expect("generous prepare");
    assert_eq!(generous.observations.placed_prep_drops, 0);
    assert!(
        generous.observations.placed_prep_resident_bytes > 0,
        "the fixture must actually prepare a placed layer",
    );
    assert!(
        !generous
            .observations
            .degradations
            .iter()
            .any(|line| line.contains("placed preparation")),
        "an affordable placed cache must report no drop: {:?}",
        generous.observations.degradations,
    );

    // Squeeze the placed budget (live / 4) below one prepared instance
    // while leaving room for the slab reservation itself.
    let instance_bytes = generous.observations.placed_prep_resident_bytes;
    let starved_live = (instance_bytes * PLACED_PREP_DIVISOR - PLACED_PREP_DIVISOR) as usize;
    let starved = prepare_group_export(
        &document,
        group,
        &replacements,
        ExportBounds::Trim,
        1.0,
        config,
        crate::psd::ProductResourcePolicy {
            max_parser_live_bytes: starved_live,
            ..crate::psd::ProductResourcePolicy::default()
        },
        None,
        None,
        0,
    )
    .expect("starved prepare");
    assert_eq!(starved.observations.placed_prep_resident_bytes, 0);
    assert_eq!(starved.observations.placed_prep_drops, 1);
    let report = starved
        .observations
        .degradations
        .iter()
        .find(|line| line.contains("placed preparation"))
        .expect("a dropped placed cache must report the degradation");
    assert!(
        report.contains("re-warped per slab"),
        "the report must say what capability was lost: {report}",
    );
    assert!(
        report.contains(&(starved_live as u64 / PLACED_PREP_DIVISOR).to_string()),
        "the report must carry the budget it was measured against: {report}",
    );
}

#[test]
fn a_reuse_window_that_is_not_retained_reports_which_budget_refused_it() {
    let document = basic_document();
    let plan = plan_top_group_exports(&document);
    let group = &plan.groups[0];
    let replacements = HashMap::new();
    let config = SlabConfig { rows: 2 };
    let retained = prepare_group_export(
        &document,
        group,
        &replacements,
        ExportBounds::Trim,
        1.0,
        config,
        crate::psd::ProductResourcePolicy::default(),
        None,
        None,
        0,
    )
    .expect("prepare");
    assert!(retained.observations.reuse_window_retained);
    assert!(retained.observations.reuse_window_bytes > 0);
    assert!(retained.observations.degradations.is_empty());

    let starved = prepare_group_export(
        &document,
        group,
        &replacements,
        ExportBounds::Trim,
        1.0,
        config,
        crate::psd::ProductResourcePolicy {
            max_canvas_pixels: 1,
            ..crate::psd::ProductResourcePolicy::default()
        },
        None,
        None,
        0,
    )
    .expect("starved prepare");
    assert!(!starved.observations.reuse_window_retained);
    assert_eq!(starved.observations.reuse_window_bytes, 0);
    let report = starved
        .observations
        .degradations
        .iter()
        .find(|line| line.contains("reuse window not retained"))
        .expect("a refused window must report the degradation");
    assert!(
        report.contains("over the") && report.contains("reuse budget"),
        "the report must name the budget that refused it: {report}",
    );
    assert!(
        report.contains("pass 2 recomposites"),
        "the report must say what it costs: {report}",
    );
}

#[test]
fn admission_reports_the_working_set_it_priced() {
    let document = basic_document();
    let plan = plan_top_group_exports(&document);
    let group = &plan.groups[0];
    let floor = 4_096_u64;
    let prepared = prepare_group_export(
        &document,
        group,
        &HashMap::new(),
        ExportBounds::Trim,
        1.0,
        SlabConfig { rows: 2 },
        crate::psd::ProductResourcePolicy::default(),
        None,
        None,
        floor,
    )
    .expect("prepare");
    let observations = &prepared.observations;
    assert_eq!(
        observations.working_set_bytes,
        observations.reserved_bytes
            + observations.placed_prep_resident_bytes
            + observations.linked_memo_resident_bytes
            + floor
            + observations.reuse_window_bytes,
        "the reported working set must be the sum admission actually compared",
    );
}

fn png_bytes(side: u32) -> Vec<u8> {
    use image::ImageEncoder;
    let pixels = vec![200_u8; side as usize * side as usize * 4];
    let mut encoded = Vec::new();
    image::codecs::png::PngEncoder::new(&mut encoded)
        .write_image(&pixels, side, side, image::ExtendedColorType::Rgba8)
        .expect("png");
    encoded
}

/// A refused memo entry is the degradation measured at two thirds of one
/// render's wall clock, and it was the most invisible of the four:
/// no log, no counter, no manifest field.
#[test]
fn a_linked_source_over_the_memo_budget_is_reported_as_a_refusal() {
    let (mut document, _) = smart_object_document(false);
    document.linked_files = vec![crate::psd::LinkedFileData {
        id: "slot".to_owned(),
        name: "slot.png".to_owned(),
        bytes: png_bytes(8),
    }];
    let plan = plan_top_group_exports(&document);
    let group = &plan.groups[0];
    let replacements = HashMap::new();
    let config = SlabConfig { rows: 2 };
    let prepare = |memo_budget: u64| {
        let memo = LinkedSourceCache::new(memo_budget);
        let prepared = prepare_group_export(
            &document,
            group,
            &replacements,
            ExportBounds::Trim,
            1.0,
            config,
            crate::psd::ProductResourcePolicy::default(),
            None,
            Some(&memo),
            0,
        )
        .expect("prepare");
        (prepared.observations.clone(), memo.refusals())
    };

    let (generous, generous_refusals) = prepare(u64::from(u32::MAX));
    assert_eq!(generous_refusals, 0);
    assert_eq!(generous.linked_memo_refusals, 0);
    assert!(generous.linked_memo_resident_bytes > 0, "the memo must hit");

    let (starved, starved_refusals) = prepare(1);
    assert_eq!(starved_refusals, 1);
    assert_eq!(starved.linked_memo_refusals, 1);
    assert_eq!(starved.linked_memo_resident_bytes, 0);
    let report = starved
        .degradations
        .iter()
        .find(|line| line.contains("linked source memo"))
        .expect("a refused memo entry must report the degradation");
    assert!(
        report.contains("re-resolved for every group"),
        "the report must say what capability was lost: {report}",
    );
}

#[test]
fn the_degradation_ladder_prices_the_reuse_window_after_every_committed_term() {
    // The reuse window is priced last: it is admitted against
    // `resident_bytes`, which is only known once the slab reservation, the
    // placed cache and the linked memo have all been priced. Pinning the
    // real order here so a reordering cannot land silently.
    let source = include_str!("mod.rs");
    let placed = source.find("PlacedPrepCache::build").expect("placed prep");
    let memo = source.find("cache.refusals()").expect("linked memo");
    let sum = source.find("if resident_bytes >").expect("sum rejection");
    let window = source.find("reuse window not retained").expect("window");
    assert!(
        placed < memo && memo < sum && sum < window,
        "degradation ladder order changed: placed={placed} memo={memo} sum={sum} window={window}",
    );
}

#[test]
fn slab_reservation_boundary_and_overflow_are_structured() {
    let exact = slab_reservation_bytes(2_400, 128, 1).expect("exact reservation");
    assert_eq!(exact, 2_400 * 129 * 20);
    let overflow =
        slab_reservation_bytes(u32::MAX, u32::MAX, u32::MAX).expect_err("u64 reservation overflow");
    assert_eq!(overflow.code, MediaErrorCode::DimensionLimit);
    assert_eq!(overflow.phase, "slab-admission");
}

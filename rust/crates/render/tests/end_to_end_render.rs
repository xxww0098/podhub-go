//! The whole public API against the committed synthetic corpus entry.
//!
//! `fixtures/psd/synthetic/tiny-smart-mask-warp-groups.psd` exercises shared
//! smart-object replacement, an embedded PSB source, layer masks,
//! multiply/screen blending, custom warp meshes, isolated top-group slicing and
//! translucent source edges in 20 KB — every capability the compositor has, in
//! one document (`fixtures/psd/README.md`).

use render::{ParsedTemplate, ProductResourcePolicy, RenderIntent, RenderOutcome, render_product};

const TEMPLATE: &[u8] =
    include_bytes!("../../../../fixtures/psd/synthetic/tiny-smart-mask-warp-groups.psd");
const DESIGN: &[u8] =
    include_bytes!("../../../../fixtures/psd/synthetic/replacement-transparent-edges.png");

/// The two slices `media.render@9` produced from the same inputs, recorded in
/// `fixtures/psd/goldens/tiny-smart-mask-warp-groups-psd/legacy.json`.
const GOLDEN_SLICES: [&[u8]; 2] = [
    include_bytes!(
        "../../../../fixtures/psd/goldens/tiny-smart-mask-warp-groups-psd/replacement-transparent-edges/replacement-transparent-edges-1.jpg"
    ),
    include_bytes!(
        "../../../../fixtures/psd/goldens/tiny-smart-mask-warp-groups-psd/replacement-transparent-edges/replacement-transparent-edges-2.jpg"
    ),
];

/// `.../legacy.json` `source.sha256`.
const TEMPLATE_FINGERPRINT: &str =
    "sha256:cf9170568835190367fa91751306d9ff970c6515a795bbe2bd314af6bb8f667a";

/// This renderer's own slice hashes — deliberately not the legacy ones beside
/// them in `goldens/`, which came from Sharp/libvips. `fixtures/psd/README.md`
/// fixes cross-encoder parity to decoded RGB (asserted below) and holds this
/// encoder to reproducibility instead. Identical under `--profile ci` and
/// `--release`; the wasm build has to reproduce them too.
const SLICE_HASHES: [&str; 2] = [
    "sha256:a7e5d5311407031fbb94332483c195b5d3bd4bd190f92e89e317cdce3ae3b50d",
    "sha256:211b562c146f6c8ec22e8ff362b903c42ff7a22601c22a29fe68f145c002d5dc",
];

/// `fixtures/psd/README.md`: the reviewed pure-Rust encoder is a deliberate
/// change from Sharp/libvips, so parity compares decoded RGB within these
/// bounds rather than comparing encoded bytes.
const MAX_MEAN_CHANNEL_DELTA: f64 = 6.0;
const MAX_CHANNEL_DELTA: u8 = 48;

fn render() -> RenderOutcome {
    let policy = ProductResourcePolicy::default();
    let template = ParsedTemplate::parse(TEMPLATE, &policy).expect("parse the synthetic template");
    assert_eq!(template.fingerprint(), TEMPLATE_FINGERPRINT);
    render_product(
        &template,
        DESIGN,
        "replacement-transparent-edges.png",
        &RenderIntent::default(),
        &policy,
    )
    .expect("render the synthetic template")
}

#[test]
fn the_synthetic_template_renders_two_addressable_slices() {
    let outcome = render();
    assert_eq!(outcome.template_fingerprint, TEMPLATE_FINGERPRINT);
    assert_eq!(outcome.slices.len(), 2, "two exportable top groups");

    // Export order is the parser's layer order, which is the reverse of the
    // order the legacy engine reported in `legacy.json`. Both groups are the
    // same mockup face, so the difference is invisible to the positional pixel
    // comparison below — it is asserted here so it stays a known property.
    let names = outcome
        .slices
        .iter()
        .map(|slice| (slice.group_name.as_str(), slice.file_name.as_str()))
        .collect::<Vec<_>>();
    assert_eq!(
        names,
        [
            ("back", "replacement-transparent-edges-1.jpg"),
            ("front", "replacement-transparent-edges-2.jpg"),
        ]
    );

    for (index, slice) in outcome.slices.iter().enumerate() {
        assert_eq!(slice.index, index as u32);
        assert_eq!(
            (slice.width, slice.height),
            (56, 42),
            "trimmed group bounds"
        );
        assert!(
            slice.content_hash.starts_with("sha256:"),
            "{}",
            slice.content_hash
        );
        assert_eq!(
            &slice.bytes[..2],
            &[0xFF, 0xD8],
            "slice {index} is not a JPEG"
        );
    }
}

fn decode_product_jpeg_rgb(jpeg: &[u8]) -> (u32, u32, Vec<u8>) {
    let mut decoder = jpeg_decoder::Decoder::new(jpeg);
    let pixels = decoder.decode().expect("decode sequential Huffman JPEG");
    let info = decoder.info().expect("jpeg info after decode");
    assert_eq!(
        info.pixel_format,
        jpeg_decoder::PixelFormat::RGB24,
        "product JPEGs are 8-bit YCbCr"
    );
    (u32::from(info.width), u32::from(info.height), pixels)
}

/// The compositor still lands on the pixels the legacy renderer produced.
#[test]
fn slices_match_the_committed_legacy_goldens() {
    for (slice, golden) in render().slices.iter().zip(GOLDEN_SLICES) {
        let (width, height, mine) = decode_product_jpeg_rgb(&slice.bytes);
        let legacy = image::load_from_memory(golden)
            .expect("decode the legacy golden")
            .to_rgb8();
        assert_eq!((width, height), legacy.dimensions());

        let (sum, max) = mine
            .iter()
            .zip(legacy.as_raw())
            .map(|(mine, legacy)| mine.abs_diff(*legacy))
            .fold((0_u64, 0_u8), |(sum, max), delta| {
                (sum + u64::from(delta), max.max(delta))
            });
        let mean = sum as f64 / mine.len() as f64;
        assert!(
            mean <= MAX_MEAN_CHANNEL_DELTA && max <= MAX_CHANNEL_DELTA,
            "{}: mean channel delta {mean:.3}, max {max}",
            slice.group_name
        );
    }
}

/// Repeated renders must emit identical JPEG bytes, or an OPFS slice cache
/// keyed on the content hash would miss on every pass and the browser and
/// Cloud executors could not be compared byte for byte.
#[test]
fn slice_bytes_are_reproducible() {
    let first = render();
    let second = render();
    let hashes = first
        .slices
        .iter()
        .map(|slice| slice.content_hash.as_str())
        .collect::<Vec<_>>();
    assert_eq!(hashes, SLICE_HASHES);
    assert_eq!(first.slices, second.slices);
}

#[test]
fn the_manifest_carries_the_slices_and_the_measured_cost() {
    let outcome = render();
    let manifest: serde_json::Value =
        serde_json::from_slice(&outcome.manifest_json).expect("the manifest is JSON");
    assert_eq!(manifest["version"], 1);
    assert_eq!(manifest["templateFingerprint"], TEMPLATE_FINGERPRINT);
    assert_eq!(
        manifest["slices"].as_array().map(Vec::len),
        Some(outcome.slices.len())
    );
    assert_eq!(manifest["slices"][0]["contentHash"], SLICE_HASHES[0]);

    // The browser memory measurement reads these.
    let observations = &outcome.resource_observations;
    assert!(observations.document_resident_bytes > 0);
    assert!(observations.saturating_live_bytes > observations.document_resident_bytes);
    assert!(!observations.live_slot_exceeded, "{observations:?}");
    assert!(observations.degradations.is_empty(), "{observations:?}");
}

/// The public API is parse-once, render-many: one parsed template serves
/// every product in a batch instead of being re-parsed per row.
#[test]
fn one_parsed_template_renders_a_batch_identically() {
    let policy = ProductResourcePolicy::default();
    let template = ParsedTemplate::parse(TEMPLATE, &policy).expect("parse once");
    assert_eq!(template.fingerprint(), TEMPLATE_FINGERPRINT);
    let first = render_product(
        &template,
        DESIGN,
        "replacement-transparent-edges.png",
        &RenderIntent::default(),
        &policy,
    )
    .expect("first product");
    for _ in 0..7 {
        let next = render_product(
            &template,
            DESIGN,
            "replacement-transparent-edges.png",
            &RenderIntent::default(),
            &policy,
        )
        .expect("batch product");
        assert_eq!(first.slices, next.slices);
    }
}

/// Sampling profile of the parse-once / render-many path. Not a CI gate:
///
/// ```text
/// samply record cargo test -p render --test end_to_end_render --release -- --ignored --nocapture flamegraph_one_parse_serves_a_batch
/// ```
///
/// The synthetic fixture is 20 KB / 56×42 — enough to exercise the compositor
/// stages, not a production 254 MiB template. Point `TEMPLATE` at a real PSD
/// to profile the baseline machine.
#[test]
#[ignore = "samply/cargo-flamegraph harness; not a CI gate"]
fn flamegraph_one_parse_serves_a_batch() {
    let policy = ProductResourcePolicy::default();
    let parse_started = std::time::Instant::now();
    let template = ParsedTemplate::parse(TEMPLATE, &policy).expect("parse once");
    let parse_ms = parse_started.elapsed().as_secs_f64() * 1_000.0;
    let mut render_ms = 0.0;
    for _ in 0..100 {
        let started = std::time::Instant::now();
        render_product(
            &template,
            DESIGN,
            "replacement-transparent-edges.png",
            &RenderIntent::default(),
            &policy,
        )
        .expect("batch product");
        render_ms += started.elapsed().as_secs_f64() * 1_000.0;
    }
    eprintln!(
        "flamegraph_one_parse_serves_a_batch parse_ms={parse_ms:.3} render_ms_total={render_ms:.3} render_ms_mean={:.3} n=100",
        render_ms / 100.0
    );
}

# psdx

[![license](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

Read and write Adobe Photoshop (`.psd` / `.psb`) files in **pure Rust**, with no
native Photoshop or system dependencies.

This crate is a fork and continuation of the crates.io `ag-psd` 0.1.0 Rust port,
itself derived from the excellent [`ag-psd`](https://github.com/Agamnentzar/ag-psd)
TypeScript library by Agamnentzar. The public data model deliberately mirrors the
upstream TypeScript library, so the structures (`Psd`, `Layer`, `ReadOptions`,
`WriteOptions`, …) will feel familiar if you've used the JavaScript version.

Package name is **`psdx`** (`use psdx::…`). See [Credits](#credits--license) for
how this relates to npm `ag-psd` and crates.io `ag-psd`.

This is an internal, unpublished workspace crate. The product compositor
(`rust/crates/render`) consumes it from `rust/crates/psd-x`.

## Features

- **Read** PSD/PSB documents into a rich, typed object model.
- **Write** PSD/PSB documents from that same model (round-trippable).
- **Layers & groups** — nested layer trees, names, opacity, blend modes, bounds,
  visibility, clipping, layer masks.
- **Pixel data** — composite image and per-layer RGBA pixels, with PackBits/RLE
  and ZIP compression supported on read and write.
- **Text layers** — editable type layers, including the Engine Data text engine
  blob (font, size, alignment, paragraph/character styles) and the type-tool
  transform matrix.
- **Layer effects** — drop shadow, stroke, glow, overlays, bevel, etc.
- **Vector / shape** data, adjustment layers, smart-object metadata, image
  resources, annotations, artboards, global layer mask info.
- **Placed-layer rendering** — source-domain geometry projection, bounded
  transform preflight, affine and mesh warp rasterization, and resampling live
  in the crate; application callers provide pixels and consume positioned RGBA.
- **Companion Adobe formats**, ported alongside the core library:
  - `.abr` — Photoshop brushes (read)
  - `.csh` — custom shapes (read; write is experimental)
  - `.ase` — Adobe Swatch Exchange palettes (read; write is experimental)
  - Engine Data parser/serializer (text engine)

## Installation

```toml
[dependencies]
psdx = { path = "../../../crates/psd-x", default-features = false }
```

Requires Rust **1.97+** (edition 2024, Cargo resolver 3). Runtime dependencies
are [`flate2`](https://crates.io/crates/flate2) (ZIP channel data) and
[`encoding_rs`](https://crates.io/crates/encoding_rs) (GBK for image resource
1006). Optional features:

| Feature | Default | Purpose |
| --- | --- | --- |
| `serde` | yes | JSON-shaped document model / goldens |
| `thumbnail` | no | JPEG decode/encode for image resource 1036 (`zune-jpeg` + `jpeg-encoder`) |
| `placed` | no | Placed-layer geometry + warp rasterization (no codecs, no compositor) |
| `composite` | no | Document/layer compositing without image codecs |
| `render` | no | Photoshop-style top-level group rendering and PNG/JPEG/GIF export |
| `experimental-write` | no | Experimental `write_csh` / `write_ase` (no upstream ground truth) |
| `test-support` | no | Section-level round-trip harness (`additional_info::test_support`) for integration tests |

Without `thumbnail`, resource 1036 is always kept as raw `thumbnailRaw` bytes so
round-trips never silently drop thumbnails.

Upstream TypeScript `ag-psd` only **reads** CSH/ASE; the Rust writers are kept
for round-trip experiments and require `features = ["experimental-write"]`.

## Quick start

```rust
use psdx::{read_psd, write_psd};
use psdx::psd::{ReadOptions, WriteOptions};

fn main() -> std::io::Result<()> {
    // --- Read ---
    let bytes = std::fs::read("input.psd")?;
    let psd = read_psd(&bytes, &ReadOptions::default())
        .expect("failed to parse PSD");

    println!("{}x{} document", psd.width, psd.height);
    if let Some(children) = &psd.children {
        for layer in children {
            println!("layer: {:?}", layer.additional_info.name);
        }
    }

    // --- Write ---
    let out = write_psd(&psd, &WriteOptions::default())
        .expect("failed to write PSD");
    std::fs::write("output.psd", out)?;
    Ok(())
}
```

## Public API at a glance

The crate root re-exports the main entry points:

| Symbol | Purpose |
| --- | --- |
| `read_psd(&[u8], &ReadOptions) -> Result<Psd, ReadError>` | Parse a PSD/PSB from memory |
| `write_psd(&Psd, &WriteOptions) -> Result<Vec<u8>, WriteError>` | Serialize a PSD/PSB to bytes |
| `write_psd_to_writer(&mut PsdWriter, &Psd, &WriteOptions) -> Result<(), WriteError>` | Serialize into an existing writer |
| `read_abr`, `read_csh`, `read_ase` | Companion Adobe formats (read) |
| `write_csh`, `write_ase` | Experimental writers (`experimental-write` feature) |
| `parse_engine_data`, `serialize_engine_data`, `decode_engine_data2` | Text Engine Data |

The document model itself lives in the [`psdx::psd`] module: `Psd`, `Layer`,
`LayerAdditionalInfo`, `PixelData`, `BlendMode`, `ColorMode`, `ReadOptions`,
`WriteOptions`, and the many supporting types.

## Export As

Enable `render` to composite selected top-level groups and receive encoded image bytes without
filesystem I/O:

```toml
[dependencies]
psdx = { version = "0.1", features = ["render"] }
```

```rust,no_run
use psdx::psd::ReadOptions;
use psdx::render::{
    export_groups, ExportConcurrency, ExportFormat, ExportOptions, ResampleMethod,
};

let psd = psdx::read_psd(&std::fs::read("mockup.psd")?, &ReadOptions::default())?;
let result = export_groups(&psd, &ExportOptions {
    format: ExportFormat::Jpeg,
    jpeg_quality: 7, // Photoshop's 0..=7 quality scale
    resample: ResampleMethod::Automatic,
    concurrency: ExportConcurrency::Auto,
    ..ExportOptions::default()
})?;
for asset in result.assets {
    std::fs::write(asset.file_name, asset.bytes)?;
}
# Ok::<(), Box<dyn std::error::Error>>(())
```

The API supports group selection, trim/document bounds, multiple scale/suffix variants, exact
image and canvas sizes with anchoring, all seven Photoshop resampling choices, PNG transparency
and smaller-file compression, JPEG quality `0..=7`, and PNG/JPEG/GIF encoding. Assets follow the
Photoshop layer panel from top to bottom; canvas position does not affect their ordinals. See the
runnable `export_as` example for a small filesystem adapter.

Top-level groups are independent work units. `ExportConcurrency::Auto` (the default) uses scoped
standard-library threads and caps the worker count by both available CPU parallelism and a 512 MiB
estimated peak-memory budget. Use `Off` for deterministic single-thread scheduling, `Fixed(n)` for
an explicit request, and set `parallel_memory_limit_bytes` to tune or disable the memory cap. Asset
ordering and encoded bytes are identical between sequential and parallel modes.

## Status & limitations

The bulk of the upstream library is ported and exercised against the original
test fixtures:

- **Reads** essentially all of the upstream read fixtures.
- **Round-trips** (read → write → read) the large majority of fixtures with a
  structurally stable result.

The writer intentionally inherits the same constraints as upstream TypeScript
`ag-psd`:

- **Writing is 8-bit RGB only.** 16/32-bit, grayscale, indexed, bitmap and
  duotone documents can be *read*, but are not re-emitted in their original
  depth/mode. This matches upstream behavior and is the reason a handful of
  fixtures do not byte-round-trip.
- **CMYK** documents are rejected at the header on read.

Known partial / stubbed areas inherited from the original `psd-x` project:

- `pths` path list payloads still empty.
- Full byte identity of all `read-write` fixtures; thumbnail **raw**
  round-trips are covered under M9.
- `write_csh` / `write_ase` are **experimental** (feature `experimental-write`);
  ABR/CSH/ASE **reads** remain covered by the crate tests.

## Testing

Integration tests are four feature-gated harness binaries, not one crate per
suite file:

```sh
cargo test -p psdx --test default
cargo test -p psdx --features test-support --test test_support
cargo test -p psdx --features composite,test-support --test composite
cargo test -p psdx --features render,test-support --test render

# Feature-matrix compile checks (library + examples).
cargo test -p psdx --features serde,thumbnail --lib
cargo test -p psdx --features placed --lib
cargo test -p psdx --features experimental-write --lib

# Core crate portability check (requires the wasm32 target).
cargo check -p psdx --features composite --target wasm32-unknown-unknown
```

Corpus suites live under `tests/test_support/` and skip visibly when fixtures
are absent unless `PSDX_REQUIRE_FIXTURES=1` is set.

## Credits & license

Three related projects — **install `psdx` for this crate**:

| Project | Role |
| --- | --- |
| npm / GitHub [`ag-psd`](https://github.com/Agamnentzar/ag-psd) | **Upstream specification** — TypeScript library by Agamnentzar; semantic baseline **v31.0.2** @ commit `3870496` |
| crates.io [`ag-psd` 0.1.0](https://crates.io/crates/ag-psd) | **Fork starting point** — from-scratch Rust port by Vasyanator; overwhelmingly **AI-generated** (Claude / Anthropic “vibe-coded”), **not** hand-audited line by line; original GitHub repo unavailable; source taken from the crates.io tarball |
| **`psdx`** (this crate) | **Audit + completion continuation** of that Rust port toward semantic parity with TypeScript ag-psd; current tests live under `rust/crates/psd-x/tests` |

Original PSD format reverse-engineering and structure courtesy of the upstream
TypeScript project and the Adobe Photoshop File Format specification.

Licensed under the **MIT License**. Copyright chain: © 2016 Agamnentzar
(ag-psd TypeScript); © 2026 Vasyanator (ag-psd Rust port 0.1.0); © 2026
psd-x maintainers. Image and brush files are **not** covered by this license —
see [`LICENSE`](LICENSE).

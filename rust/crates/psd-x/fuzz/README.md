# psdx fuzz targets

Standalone crate (excluded from the workspace). Requires nightly + `cargo-fuzz`.

```bash
cargo install cargo-fuzz
cd psdx
cargo +nightly fuzz run read_psd
cargo +nightly fuzz run read_abr
cargo +nightly fuzz run read_csh
cargo +nightly fuzz run read_ase
cargo +nightly fuzz run parse_engine_data
cargo +nightly fuzz run decode_engine_data2
```

Place seed corpora under `fuzz/corpus/<target>/`.

#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)"
DIST="$ROOT/wasm/dist/browser/render"
TOOLCHAIN=nightly-2026-09-14
BINDGEN=0.2.127
if [[ "$(wasm-bindgen --version 2>/dev/null || true)" != "wasm-bindgen $BINDGEN" ]]; then
  echo "Install matching glue generator: cargo install wasm-bindgen-cli --version $BINDGEN --locked" >&2
  exit 1
fi
# Run cargo from inside rust/ so .cargo/config.toml (the +simd128 rustflags)
# and rust-toolchain.toml are both discovered; --manifest-path would skip them.
cd "$ROOT/rust"
# Keep the non-threaded C ABI for compute golden tests. It is not a fallback.
cargo build --locked -p render-wasm --release --target wasm32-unknown-unknown
mkdir -p "$DIST/threaded"
cp "target/wasm32-unknown-unknown/release/render_wasm.wasm" "$DIST/render_wasm.wasm"
# The threaded half needs std rebuilt with atomics, which only a nightly can do,
# so this one artifact names its channel explicitly instead of the stable pin.
# Its RUSTFLAGS restate +simd128 because a caller-provided RUSTFLAGS replaces
# the .cargo/config.toml per-target flags instead of merging with them.
RUSTFLAGS='-C target-feature=+atomics,+bulk-memory,+mutable-globals,+simd128 -C link-arg=--shared-memory -C link-arg=--import-memory -C link-arg=--max-memory=2147483648 -C link-arg=--export=__wasm_init_tls -C link-arg=--export=__tls_size -C link-arg=--export=__tls_align -C link-arg=--export=__tls_base' \
  cargo +"$TOOLCHAIN" build --locked -p render-wasm --release \
  --features threads --target wasm32-unknown-unknown -Z build-std=std,panic_abort \
  --target-dir target/render-threads
wasm-bindgen "target/render-threads/wasm32-unknown-unknown/release/render_wasm.wasm" \
  --target web --out-dir "$DIST/threaded" --out-name index

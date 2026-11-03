#!/usr/bin/env bash
# scripts/build-wasm.sh [core|render|all]   (default: all)
# Builds the committed WASM from the single rust/ workspace into wasm/dist.
#   core    listing-core-wasm twice: the server module, and the browser module
#           (--features browser, separate target dir)
#   render  the threaded browser renderer: a nightly build-std build with
#           atomics, then wasm-bindgen glue
# Run scripts/check-wasm-dist.sh --update afterwards (make wasm does both) and
# commit the artifacts with the manifest. Release wasm is not byte-reproducible,
# so Go tests compare oracle result bytes, never file hashes.
set -euo pipefail

# The one place the toolchains are named. check-wasm-dist.sh reads this line.
# The stable version must match rust/rust-toolchain.toml.
toolchain_id="1.99.0/nightly-2026-09-14/wasm-bindgen-0.2.127"
IFS=/ read -r _ nightly bindgen <<<"$toolchain_id"
bindgen=${bindgen#wasm-bindgen-}

root=$(cd "$(dirname "$0")/.." && pwd)
dist="$root/wasm/dist"
target="wasm32-unknown-unknown"

group="${1:-all}"
case "$group" in
  core|render|all) ;;
  *) echo "usage: scripts/build-wasm.sh [core|render|all]" >&2; exit 2 ;;
esac

# Run cargo from inside rust/: rustup (rust-toolchain.toml) and cargo
# (.cargo/config.toml, which carries the +simd128 rustflags) resolve their
# config from the working directory, never from --manifest-path. Invoking from
# the repo root silently drops SIMD and changes the artifacts.
cd "$root/rust"

build_core() {
  cargo test --locked -p listing-core -p listing-core-wasm
  cargo build --locked --release --target "$target" -p listing-core-wasm
  cargo build --locked --release --target "$target" -p listing-core-wasm \
    --features browser --target-dir target-browser
  cp "target/$target/release/listing_core_wasm.wasm" "$dist/server/listing-core.wasm"
  cp "target-browser/$target/release/listing_core_wasm.wasm" "$dist/browser/listing-state.wasm"
}

build_render() {
  if [[ "$(wasm-bindgen --version 2>/dev/null || true)" != "wasm-bindgen $bindgen" ]]; then
    echo "Install matching glue generator: cargo install wasm-bindgen-cli --version $bindgen --locked" >&2
    exit 1
  fi
  # std is rebuilt with atomics, which only a nightly can do. RUSTFLAGS restates
  # +simd128 because a caller-provided RUSTFLAGS replaces the .cargo/config.toml
  # per-target flags instead of merging with them.
  RUSTFLAGS='-C target-feature=+atomics,+bulk-memory,+mutable-globals,+simd128 -C link-arg=--shared-memory -C link-arg=--import-memory -C link-arg=--max-memory=2147483648 -C link-arg=--export=__wasm_init_tls -C link-arg=--export=__tls_size -C link-arg=--export=__tls_align -C link-arg=--export=__tls_base' \
    cargo +"$nightly" build --locked -p render-wasm --release \
    --features threads --target "$target" -Z build-std=std,panic_abort \
    --target-dir target/render-threads
  wasm-bindgen "target/render-threads/$target/release/render_wasm.wasm" \
    --target web --out-dir "$dist/browser/render/threaded" --out-name index
}

case "$group" in
  core) build_core ;;
  render) build_render ;;
  all) build_core; build_render ;;
esac

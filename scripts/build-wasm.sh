#!/usr/bin/env bash
# scripts/build-wasm.sh {tags|core|all} [--copy] [--env FILE]
# Builds the wasm modules locally from the single rust/ workspace.
#   tags  listing-tags and the host probe (server + test artifacts)
#   core  listing-core-wasm, once for the server and once with --features
#         browser for the browser artifact (separate target dir)
# Both groups use the one toolchain pinned by rust/rust-toolchain.toml.
# --copy     copy the fresh modules into wasm/dist. Then run
#            scripts/check-wasm-dist.sh --update and commit both.
# --env FILE append NAME=path lines for the fresh modules to FILE
#            (LISTING_TAGS_WASM, WASM_HOST_PROBE, LISTING_CORE_WASM,
#            LISTING_STATE_WASM), for local oracle runs.
# Release wasm is not byte-reproducible, so a fresh build is compared by
# oracle result bytes in the Go tests, never by file hash.
set -euo pipefail

root=$(cd "$(dirname "$0")/.." && pwd)
# Run cargo from inside rust/: both rustup (rust-toolchain.toml) and cargo
# (.cargo/config.toml, which carries the +simd128 rustflags) resolve their
# config from the working directory, never from --manifest-path. Invoking
# from the repo root silently drops SIMD and changes the artifacts (E-076).
cd "$root/rust"

target="wasm32-unknown-unknown"
dist="$root/wasm/dist"

built_tags="target/${target}/release/listing_tags.wasm"
built_probe="target/${target}/release/wasm_host_probe.wasm"
built_core="target/${target}/release/listing_core_wasm.wasm"
built_state="target-browser/${target}/release/listing_core_wasm.wasm"

usage() {
  echo "usage: scripts/build-wasm.sh {tags|core|all} [--copy] [--env FILE]" >&2
  exit 2
}

[ $# -ge 1 ] || usage
group="$1"
shift
case "$group" in
  tags|core|all) ;;
  *) usage ;;
esac

copy=0
env_file=""
while [ $# -gt 0 ]; do
  case "$1" in
    --copy) copy=1 ;;
    --env)
      [ $# -ge 2 ] || usage
      env_file="$2"
      shift
      ;;
    *) usage ;;
  esac
  shift
done

# rust/rust-toolchain.toml pins the channel, so plain cargo is already the
# pinned toolchain whenever rustup is driving it. Without rustup the cargo on
# PATH must be that same version.
emit() {
  if [ -n "$env_file" ]; then
    printf '%s=%s\n' "$1" "$2" >>"$env_file"
  fi
}

build_tags() {
  cargo test --locked -p listing-tags
  cargo build --locked --release --target "$target" -p listing-tags
  cargo build --locked --release --target "$target" -p wasm-host-probe
  if [ "$copy" -eq 1 ]; then
    cp "$built_tags" "$dist/server/listing-tags.wasm"
    cp "$built_probe" "$dist/test/host-probe.wasm"
  fi
  emit LISTING_TAGS_WASM "$root/rust/$built_tags"
  emit WASM_HOST_PROBE "$root/rust/$built_probe"
}

build_core() {
  cargo test --locked -p listing-core
  cargo build --locked --release --target "$target" -p listing-core-wasm
  cargo build --locked --release --target "$target" -p listing-core-wasm --features browser --target-dir target-browser
  if [ "$copy" -eq 1 ]; then
    cp "$built_core" "$dist/server/listing-core.wasm"
    cp "$built_state" "$dist/browser/listing-state.wasm"
  fi
  emit LISTING_CORE_WASM "$root/rust/$built_core"
  emit LISTING_STATE_WASM "$root/rust/$built_state"
}

case "$group" in
  tags) build_tags ;;
  core) build_core ;;
  all)
    build_tags
    build_core
    ;;
esac

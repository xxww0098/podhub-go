#!/usr/bin/env bash
# Exercise stale/missing inputs without a Rust toolchain or real compilation.
set -euo pipefail
root=$(cd "$(dirname "$0")/.." && pwd)
fixture=$(mktemp -d)
trap 'rm -rf "$fixture"' EXIT
mkdir -p "$fixture/scripts"
cp "$root/scripts/check-wasm-dist.sh" "$root/scripts/build-wasm.sh" "$fixture/scripts/"
cd "$fixture"

# build-wasm.sh is itself a hashed input, so it is mutated like the rest.
files=(
  rust/Cargo.toml rust/Cargo.lock rust/rust-toolchain.toml
  rust/.cargo/config.toml
  rust/crates/listing-core/src/lib.rs
  rust/crates/listing-core-wasm/src/lib.rs
  scripts/build-wasm.sh
  wasm/dist/server/listing-core.wasm
  wasm/dist/browser/listing-state.wasm
  wasm/dist/browser/render/threaded/index.js
  wasm/dist/browser/render/threaded/index_bg.wasm
  wasm/dist/browser/render/threaded/index.d.ts
  wasm/dist/browser/render/threaded/index_bg.wasm.d.ts
  wasm/dist/browser/render/threaded/snippets/rayon/src/workerHelpers.js
)
for file in "${files[@]}"; do
  mkdir -p "$(dirname "$file")"
  [ -e "$file" ] || printf 'fixture\n' >"$file"
done

check() { bash scripts/check-wasm-dist.sh "$@" >check.log 2>&1; }
reject() {
  if check "$@"; then
    echo "expected rejection: ${file:-manifest} $*" >&2
    exit 1
  fi
}

check --update
check
for file in "${files[@]}"; do
  cp "$file" original
  printf 'changed\n' >>"$file"
  reject
  cp original "$file"
done

# macOS and editor junk is not part of the source fingerprint.
for junk in rust/.DS_Store rust/crates/listing-core/src/.DS_Store rust/foo.swp rust/foo~; do
  printf 'junk\n' >"$junk"
  if ! check; then
    echo "junk file must not affect the source hash: $junk" >&2
    cat check.log >&2
    exit 1
  fi
  rm "$junk"
done

# Build output is not part of the source fingerprint.
mkdir -p rust/target/render-threads rust/target-browser
printf 'ignored\n' >rust/target/cache
printf 'ignored\n' >rust/target-browser/cache
printf 'ignored\n' >rust/target/render-threads/cache
check

# A failed refresh must preserve the previous manifest.
cp wasm/dist/SOURCES.sha256 original-manifest
file=wasm/dist/browser/render/threaded/index_bg.wasm
mv "$file" saved
reject
reject --update
cmp original-manifest wasm/dist/SOURCES.sha256
mv saved "$file"

# A glue file the manifest does not know about is a stale bundle.
file=wasm/dist/browser/render/threaded/extra-worker.js
printf 'extra\n' >"$file"
reject
rm "$file"
check

# A module left over from a removed artifact is not pinned, so it fails
# both the check and a manifest refresh.
for file in wasm/dist/server/listing-tags.wasm wasm/dist/test/host-probe.wasm wasm/dist/browser/render/render_wasm.wasm; do
  mkdir -p "$(dirname "$file")"
  printf 'stale\n' >"$file"
  reject
  reject --update
  cmp original-manifest wasm/dist/SOURCES.sha256
  rm "$file"
done
rmdir wasm/dist/test
check

rm wasm/dist/SOURCES.sha256
file=wasm/dist/SOURCES.sha256
reject
echo "wasm manifest checker tests passed"

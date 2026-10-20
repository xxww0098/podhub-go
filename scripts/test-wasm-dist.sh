#!/usr/bin/env bash
# Exercise stale/missing inputs without a Rust toolchain or real compilation.
set -euo pipefail
root=$(cd "$(dirname "$0")/.." && pwd)
fixture=$(mktemp -d)
trap 'rm -rf "$fixture"' EXIT
mkdir -p "$fixture/scripts"
cp "$root/scripts/check-wasm-dist.sh" "$fixture/scripts/"
cd "$fixture"

files=(
  rust/Cargo.toml rust/Cargo.lock rust/rust-toolchain.toml
  rust/.cargo/config.toml
  rust/crates/listing-tags/src/lib.rs
  rust/crates/wasm-host-probe/src/lib.rs
  rust/crates/listing-core/src/lib.rs
  scripts/build-wasm.sh
  web/scripts/build-render.sh
  wasm/dist/server/listing-tags.wasm wasm/dist/server/listing-core.wasm
  wasm/dist/test/host-probe.wasm
  wasm/dist/browser/listing-state.wasm
  wasm/dist/browser/render/render_wasm.wasm
  wasm/dist/browser/render/threaded/index.js
  wasm/dist/browser/render/threaded/index_bg.wasm
  wasm/dist/browser/render/threaded/index.d.ts
  wasm/dist/browser/render/threaded/index_bg.wasm.d.ts
  wasm/dist/browser/render/threaded/snippets/rayon/src/workerHelpers.js
)
for file in "${files[@]}"; do
  mkdir -p "$(dirname "$file")"
  printf 'fixture\n' >"$file"
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

# macOS and editor junk is not part of the source fingerprint. These live only
# under rust/: web_dirs lists the one web build script, not the directory holding
# it, so junk under web/scripts would never be scanned by the checker.
junk_files=(
  rust/.DS_Store
  rust/crates/listing-core/src/.DS_Store
  rust/foo.swp
  rust/foo~
)
for junk in "${junk_files[@]}"; do
  printf 'junk\n' >"$junk"
  if ! check; then
    echo "junk file must not affect the source hash: $junk" >&2
    cat check.log >&2
    exit 1
  fi
  rm "$junk"
done

# Ignoring junk must not blunt the fingerprint for real sources.
file=rust/crates/listing-core/src/lib.rs
cp "$file" original
printf 'changed\n' >>"$file"
reject
cp original "$file"
check

# Build output is not part of the source fingerprint.
mkdir -p rust/target rust/target-browser rust/target/render-threads
printf 'ignored\n' >rust/target/cache
printf 'ignored\n' >rust/target-browser/cache
printf 'ignored\n' >rust/target/render-threads/cache
check

# A failed refresh must preserve the previous manifest.
cp wasm/dist/SOURCES.sha256 original-manifest
file=wasm/dist/browser/render/threaded/index_bg.wasm
mv "$file" saved-wasm
reject
reject --update
cmp original-manifest wasm/dist/SOURCES.sha256
mv saved-wasm "$file"

file=web/scripts/build-render.sh
mv "$file" saved-source
reject
reject --update
cmp original-manifest wasm/dist/SOURCES.sha256
mv saved-source "$file"

file=wasm/dist/browser/render/threaded/extra-worker.js
printf 'extra\n' >"$file"
reject
rm "$file"
file=wasm/dist/server/psd-render.wasm
printf 'unsupported\n' >"$file"
reject --update
cmp original-manifest wasm/dist/SOURCES.sha256
rm "$file"
check
rm wasm/dist/SOURCES.sha256
reject
echo "wasm manifest checker tests passed"

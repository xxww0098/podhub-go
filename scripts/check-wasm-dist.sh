#!/usr/bin/env bash
# scripts/check-wasm-dist.sh [--update]
# Checks committed server/browser WASM and browser glue without running Rust.
# wasm/dist/SOURCES.sha256 records the build inputs and artifacts:
#   server/test: the single rust/ workspace (rust/rust-toolchain.toml pins
#                stable 1.99.0) -> server/{listing-core,listing-tags}.wasm
#                and test/host-probe.wasm
#   browser:     rust/ built with nightly-2026-09-14 + wasm-bindgen 0.2.127
#                -> browser/listing-state.wasm, browser/render/
#                (including the threaded glue)
# For each group it records the toolchain, a content hash of the Rust sources
# and lockfiles, and the sha256 of each committed module. Manifest keys are
# paths relative to wasm/dist/.
# Mismatch exits 1 and tells you to rebuild. --update rewrites the manifest.
# Release wasm embeds nondeterministic LLVM symbol ids, so CI does not cmp
# the binary against a fresh build. The manifest pins the committed bytes.
set -euo pipefail

root=$(cd "$(dirname "$0")/.." && pwd)
cd "$root"

toolchain="1.99.0"
web_toolchain="1.99.0/nightly-2026-09-14/wasm-bindgen-0.2.127"
manifest="wasm/dist/SOURCES.sha256"
dist="wasm/dist"
# One Rust root: any source change can move any artifact, so both groups hash
# the whole workspace plus the scripts that turn it into modules.
rust_dirs=(rust scripts/build-wasm.sh)
web_dirs=(rust web/scripts/build-render.sh)
artifacts=(server/listing-tags.wasm server/listing-core.wasm test/host-probe.wasm)
web_artifacts=(browser/listing-state.wasm browser/render/render_wasm.wasm)
web_glue="$dist/browser/render/threaded"
# PSD rendering has a browser build only, with no server ABI/build group.
psd_artifact="server/psd-render.wasm"

update=0
for arg in "$@"; do
  case "$arg" in
    --update) update=1 ;;
    *) echo "unknown argument: $arg" >&2; exit 2 ;;
  esac
done

rebuild_hint() {
  cat >&2 <<EOF
wasm dist is stale. Rebuild all server/browser artifacts locally and commit them with the manifest:
  make wasm
EOF
}

# source_hash TOOLCHAIN DIR... hashes every file under DIR except build output
# and macOS/editor junk (.DS_Store, *.swp, *~), which are not build inputs.
source_hash() {
  local toolchain_arg="$1" tmp digest
  shift
  tmp=$(mktemp)
  if ! {
    printf 'toolchain %s\n' "$toolchain_arg"
    find "$@" \
      \( -type d \( -name target -o -name target-browser -o -name node_modules -o -name .git \) -prune \) \
      -o -type f ! -name '.DS_Store' ! -name '*.swp' ! -name '*~' -print0 \
      | LC_ALL=C sort -z \
      | while IFS= read -r -d '' f; do
          sha256sum "$f" || exit 1
        done
  } >"$tmp"; then
    rm -f "$tmp"
    return 1
  fi
  digest=$(sha256sum "$tmp") || { rm -f "$tmp"; return 1; }
  rm -f "$tmp"
  printf '%s\n' "${digest%% *}"
}

file_hash() {
  sha256sum "$1" | awk '{print $1}'
}

write_manifest() {
  cat <<EOF
# Committed WASM and browser glue. Rebuild locally with make wasm; CI only checks.
toolchain ${toolchain}
source_sha256 ${source_digest}
web_toolchain ${web_toolchain}
web_source_sha256 ${web_source_digest}
web_glue_sha256 ${web_glue_digest}
EOF
  local name
  for name in "${artifacts[@]}" "${web_artifacts[@]}"; do
    printf '%s %s\n' "$name" "$(file_hash "$dist/$name")"
  done
}

read_field() {
  awk -v k="$1" '$1 == k { print $2 }' "$manifest"
}

# Fail before refreshing a manifest if a required artifact is missing.
for name in "${artifacts[@]}" "${web_artifacts[@]}" \
  "browser/render/threaded/index.js" "browser/render/threaded/index_bg.wasm" \
  "browser/render/threaded/index.d.ts" "browser/render/threaded/index_bg.wasm.d.ts"; do
  if [ ! -s "$dist/$name" ]; then
    echo "missing or empty WASM artifact: $dist/$name" >&2
    rebuild_hint
    exit 1
  fi
done

if [ -f "$dist/$psd_artifact" ]; then
  echo "$dist/$psd_artifact has no server build group" >&2
  exit 1
fi

# Assign separately so an unreadable or missing build input aborts a refresh.
source_digest=$(source_hash "$toolchain" "${rust_dirs[@]}")
web_source_digest=$(source_hash "$web_toolchain" "${web_dirs[@]}")
web_glue_digest=$(source_hash "$web_toolchain" "$web_glue")

if [ "$update" -eq 1 ]; then
  manifest_tmp=$(mktemp)
  trap 'rm -f "$manifest_tmp"' EXIT
  write_manifest >"$manifest_tmp"
  mv "$manifest_tmp" "$manifest"
  echo "wrote ${manifest}"
  exit 0
fi

if [ ! -f "$manifest" ]; then
  echo "missing ${manifest}" >&2
  rebuild_hint
  exit 1
fi

bad=0
expect() {
  local what="$1" got="$2" want="$3"
  if [ "$got" != "$want" ]; then
    echo "${what} ${got} != manifest ${want}" >&2
    bad=1
  fi
}

expect "toolchain" "$toolchain" "$(read_field toolchain)"
expect "source hash" "$source_digest" "$(read_field source_sha256)"
expect "web_toolchain" "$web_toolchain" "$(read_field web_toolchain)"
expect "web source hash" "$web_source_digest" "$(read_field web_source_sha256)"
expect "web glue hash" "$web_glue_digest" "$(read_field web_glue_sha256)"
for name in "${artifacts[@]}" "${web_artifacts[@]}"; do
  expect "$dist/$name sha256" "$(file_hash "$dist/$name")" "$(read_field "$name")"
done

if [ "$bad" -ne 0 ]; then
  rebuild_hint
  exit 1
fi
echo "wasm dist hash ok"

#!/usr/bin/env bash
# scripts/check-wasm-dist.sh [--update]
# Checks the committed WASM and browser glue without running Rust.
# wasm/dist/SOURCES.sha256 records:
#   toolchain      toolchain_id from scripts/build-wasm.sh
#   source_sha256  every file under rust/ plus scripts/build-wasm.sh
#   glue_sha256    the wasm-bindgen output dir browser/render/threaded
#   <path> <sha>   the two listing-core modules, relative to wasm/dist
# A mismatch exits 1 and says to rebuild. --update rewrites the manifest.
# Release wasm embeds nondeterministic LLVM symbol ids, so CI does not compare
# against a fresh build; the manifest pins the committed bytes.
set -euo pipefail

root=$(cd "$(dirname "$0")/.." && pwd)
cd "$root"

manifest="wasm/dist/SOURCES.sha256"
dist="wasm/dist"
glue="$dist/browser/render/threaded"
inputs=(rust scripts/build-wasm.sh)
modules=(server/listing-core.wasm browser/listing-state.wasm)
glue_files=(index.js index_bg.wasm index.d.ts index_bg.wasm.d.ts)

update=0
for arg in "$@"; do
  case "$arg" in
    --update) update=1 ;;
    *) echo "unknown argument: $arg" >&2; exit 2 ;;
  esac
done

rebuild_hint() {
  echo "wasm dist is stale. Rebuild locally and commit the artifacts with the manifest: make wasm" >&2
}

# tree_hash DIR_OR_FILE... hashes every file except build output and
# macOS/editor junk (.DS_Store, *.swp, *~), which are not build inputs.
tree_hash() {
  local tmp digest
  tmp=$(mktemp)
  if ! find "$@" \
      \( -type d \( -name target -o -name target-browser -o -name node_modules -o -name .git \) -prune \) \
      -o -type f ! -name '.DS_Store' ! -name '*.swp' ! -name '*~' -print0 \
      | LC_ALL=C sort -z \
      | while IFS= read -r -d '' f; do sha256sum "$f" || exit 1; done >"$tmp"; then
    rm -f "$tmp"
    return 1
  fi
  digest=$(sha256sum "$tmp") || { rm -f "$tmp"; return 1; }
  rm -f "$tmp"
  printf '%s\n' "${digest%% *}"
}

file_hash() { sha256sum "$1" | awk '{print $1}'; }
read_field() { awk -v k="$1" '$1 == k { print $2 }' "$manifest"; }

toolchain=$(sed -n 's/^toolchain_id="\(.*\)"$/\1/p' scripts/build-wasm.sh)
[ -n "$toolchain" ] || { echo "scripts/build-wasm.sh has no toolchain_id" >&2; exit 1; }

# Fail before refreshing a manifest if a required artifact is missing.
for name in "${modules[@]}"; do
  [ -s "$dist/$name" ] || { echo "missing or empty WASM artifact: $dist/$name" >&2; rebuild_hint; exit 1; }
done
for name in "${glue_files[@]}"; do
  [ -s "$glue/$name" ] || { echo "missing or empty WASM glue: $glue/$name" >&2; rebuild_hint; exit 1; }
done

# Every .wasm under dist is a pinned module or part of the glue bundle. A
# leftover from a removed artifact must not pass.
stray=$(find "$dist" -name '*.wasm' ! -path "$glue/*" \
  $(printf '! -path %s ' "${modules[@]/#/$dist/}") | LC_ALL=C sort)
if [ -n "$stray" ]; then
  printf 'unpinned WASM in %s:\n%s\n' "$dist" "$stray" >&2
  rebuild_hint
  exit 1
fi

# Assign separately so an unreadable or missing build input aborts a refresh.
source_digest=$(tree_hash "${inputs[@]}")
glue_digest=$(tree_hash "$glue")

if [ "$update" -eq 1 ]; then
  tmp=$(mktemp)
  trap 'rm -f "$tmp"' EXIT
  {
    echo "# Committed WASM and browser glue. Rebuild locally with make wasm; CI only checks."
    echo "toolchain ${toolchain}"
    echo "source_sha256 ${source_digest}"
    echo "glue_sha256 ${glue_digest}"
    for name in "${modules[@]}"; do printf '%s %s\n' "$name" "$(file_hash "$dist/$name")"; done
  } >"$tmp"
  mv "$tmp" "$manifest"
  echo "wrote ${manifest}"
  exit 0
fi

[ -f "$manifest" ] || { echo "missing ${manifest}" >&2; rebuild_hint; exit 1; }

bad=0
expect() {
  if [ "$2" != "$3" ]; then
    echo "$1 $2 != manifest $3" >&2
    bad=1
  fi
}
expect "toolchain" "$toolchain" "$(read_field toolchain)"
expect "source hash" "$source_digest" "$(read_field source_sha256)"
expect "glue hash" "$glue_digest" "$(read_field glue_sha256)"
for name in "${modules[@]}"; do
  expect "$dist/$name sha256" "$(file_hash "$dist/$name")" "$(read_field "$name")"
done
if [ "$bad" -ne 0 ]; then
  rebuild_hint
  exit 1
fi
echo "wasm dist hash ok"

#!/usr/bin/env bash
# Native tests must execute the production coordinator state, not zero tests
# behind the browser-only threads feature. The lockfile is never refreshed here.
set -euo pipefail
root=$(cd "$(dirname "$0")/.." && pwd)
cd "$root/rust"
listed=$(mktemp)
trap 'rm -f "$listed"' EXIT
cargo test --locked -p render-wasm --lib -- --list | tee "$listed"
for name in \
  scheduler::admission::tests::exhaustive_lease_event_sequences_preserve_ownership_and_drain_boundaries \
  scheduler::compute::tests::cancelled_compute_releases_lane_only_on_completion \
  scheduler::error::tests::byte_counts_reject_nonfinite_negative_fractional_and_lossy_values; do
  grep -Fx "$name: test" "$listed" >/dev/null || { echo "Missing native state test: $name" >&2; exit 1; }
done
cargo test --locked -p render-wasm --lib

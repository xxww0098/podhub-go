#!/usr/bin/env bash
set -euo pipefail
root=$(git rev-parse --show-toplevel)
cd "$root"
mkdir -p "$EVIDENCE"
log() {
  local name="$1"; shift
  echo "RUN $name"
  if "$@" >"$EVIDENCE/$name" 2>&1; then
    grep -E 'test result:| pass$| fail$|wasm dist hash ok|threaded-render |shared-init-cancellation ' "$EVIDENCE/$name" || true
    echo "PASS $name"
  else
    tail -n 90 "$EVIDENCE/$name"
    return 1
  fi
}
phase=${1:?}
case "$phase" in
  rust-tests)
    cd rust
    log default-before-list.log cargo test --locked -p render-wasm -- --list
    if grep -q '^scheduler::' "$EVIDENCE/default-before-list.log"; then echo 'unexpected baseline scheduler coverage'; exit 1; fi
    cd ..
    python3 .verification/wasm-state-edit.py rust-seam
    cd rust
    log seam-baseline.log cargo test --locked -p render-wasm
    cd ..
    python3 .verification/wasm-state-edit.py rust-tests
    cd rust
    set +e
    cargo test --locked -p render-wasm idle_finish_is_not_a_completion -- --nocapture >"$EVIDENCE/idle-finish-red.log" 2>&1
    result=$?
    set -e
    test "$result" -eq 101
    grep -q 'idle lease has no computation to finish' "$EVIDENCE/idle-finish-red.log"
    echo 'RED reproduced: an idle lease falsely reports a completed computation'
    cd ..
    python3 .verification/wasm-state-edit.py rust-fix
    for file in rust/crates/render-wasm/src/lib.rs rust/crates/render-wasm/src/scheduler/{mod,browser,error,admission,lifecycle_tests}.rs; do
      rustfmt +1.99.0 --edition 2024 < "$file" > "$RUNNER_TEMP/formatted-state.rs"
      cp "$RUNNER_TEMP/formatted-state.rs" "$file"
    done
    cd rust
    log scheduler-list.log cargo test --locked -p render-wasm -- --list
    grep -q '^scheduler::admission::tests::' "$EVIDENCE/scheduler-list.log"
    grep -q '^scheduler::compute::tests::' "$EVIDENCE/scheduler-list.log"
    grep -q '^scheduler::admission::lifecycle_tests::' "$EVIDENCE/scheduler-list.log"
    log native-after.log cargo test --locked -p render -p psdx -p render-wasm
    for n in $(seq 1 20); do
      log "state-repeat-$n.log" cargo test --locked -p render-wasm scheduler:: -- --test-threads=1
    done
    cd ..
    git diff --exit-code rust/Cargo.lock
    ;;
  web-tests)
    cd web
    log install.log bun install --frozen-lockfile
    log host-before.log bun test --preload ./tests/network-guard.preload.ts ./src/render/client.test.ts
    cd ..
    python3 .verification/wasm-state-edit.py web-tests
    cd web
    set +e
    bun test --preload ./tests/network-guard.preload.ts ./src/render/runtime-cancellation.test.ts >"$EVIDENCE/cancel-red.log" 2>&1
    result=$?
    set -e
    test "$result" -ne 0
    grep -q 'cancelled callers must settle before init reply' "$EVIDENCE/cancel-red.log"
    echo 'RED reproduced: cancelled owners remain waiting for shared init'
    cd ..
    python3 .verification/wasm-state-edit.py web-fix
    cd web
    log cancel-after.log bun test --preload ./tests/network-guard.preload.ts ./src/render/runtime-cancellation.test.ts ./src/render/client.test.ts
    for n in $(seq 1 20); do
      log "cancel-repeat-$n.log" bun test --preload ./tests/network-guard.preload.ts ./src/render/runtime-cancellation.test.ts
    done
    log web-full.log bun run test
    log web-build.log bun run build
    log api-check.log bun run api:check
    ;;
  rebuild)
    log install-bindgen.log cargo +1.99.0 install wasm-bindgen-cli --debug --version 0.2.127 --locked
    log rebuild.log make wasm
    log dist-check.log bash scripts/check-wasm-dist.sh
    cd web
    log install.log bun install --frozen-lockfile
    log render-after.log bun test --preload ./tests/network-guard.preload.ts ./tests/render-wasm.test.ts ./tests/render-worker.test.ts ./src/render
    log web-build.log bun run build
    ;;
  browser)
    cp .verification/wasm-state-browser.mjs web/.wasm-state-verify.mjs
    cd web
    log browser.log node .wasm-state-verify.mjs
    rm .wasm-state-verify.mjs
    ;;
  publish)
    python3 .verification/wasm-state-report.py "$VERIFY_PART"
    base=be364cb76e87dc9ea178cd322b888ab3b641d998
    if [ "$VERIFY_PART" = rust-state ]; then
      branch=fix/wasm-lease-state-20261021
      git add rust/crates/render-wasm .github/workflows/ci.yml wasm/dist docs/parity/wasm-lease-state.md
      message='fix(wasm): make lease transitions explicit and run scheduler tests by default'
    else
      branch=fix/render-owner-cancellation-20261021
      git add web/src/render/threaded-client.ts web/src/render/runtime-cancellation.test.ts docs/parity/render-owner-cancellation.md
      message='fix(render): cancel owner waits without releasing active compute early'
    fi
    git rm --cached -r .verification >/dev/null
    git rm --cached .github/workflows/verify-wasm-state.yml >/dev/null
    git diff --cached --check "$base"
    git diff --cached --binary "$base" > "$EVIDENCE/verified.patch"
    git diff --cached --stat "$base" | tee "$EVIDENCE/changes.txt"
    git ls-files -s > "$EVIDENCE/staged-blobs.txt"
    git config user.name 'github-actions[bot]'
    git config user.email '41898282+github-actions[bot]@users.noreply.github.com'
    tree=$(git write-tree)
    sha=$(printf '%s\n\nTested by Actions run %s, job %s. No main merge or deployment.\n' "$message" "$GITHUB_RUN_ID" "$VERIFY_PART" | git commit-tree "$tree" -p "$base")
    if git ls-remote --exit-code --heads origin "refs/heads/$branch" >/dev/null 2>&1; then echo 'refusing to overwrite an existing topic branch'; exit 1; fi
    git push origin "$sha:refs/heads/$branch"
    printf '%s %s\n' "$branch" "$sha" | tee "$EVIDENCE/published.txt"
    echo PASS > "$EVIDENCE/result.txt"
    ;;
  *) exit 2 ;;
esac

#!/usr/bin/env python3
"""Apply small, asserted edits to the pinned baseline, one verification phase at a time."""
from pathlib import Path
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[1]
def edit(path, old, new):
    p = ROOT / path
    text = p.read_text()
    assert text.count(old) == 1, (path, text.count(old), old[:80])
    p.write_text(text.replace(old, new, 1))
def copy(src, dst):
    (ROOT / dst).write_text((ROOT / src).read_text())
def blob(path, expected):
    actual = subprocess.check_output(['git', 'hash-object', path], cwd=ROOT, text=True).strip()
    assert actual == expected, (path, actual, expected)

mode = sys.argv[1]
if mode == 'rust-seam':
    blob('rust/crates/render-wasm/src/scheduler/mod.rs', 'a237aabd24f2060106d04bfd0d60c90c95dfdd6d')
    blob('rust/crates/render-wasm/src/scheduler/admission.rs', '0c6bf25800617f1f585a50b9252164f9b8376031')
    p = ROOT / 'rust/crates/render-wasm/src/scheduler/mod.rs'
    original = p.read_text()
    body = original[original.index('use admission::'):]
    body = body.replace('use admission::', 'use super::admission::', 1)
    body = body.replace('use compute::Computed;', 'use super::compute::{self, Computed};', 1)
    body = body.replace('use error::', 'use super::error::', 1)
    (p.parent / 'browser.rs').write_text('//! JS validation and async bindgen adaptation. State is tested without this seam.\n' + body)
    p.write_text('''//! Metadata state and completion are native-testable; only the JS seam needs threads.
mod admission;
mod compute;
mod error;

#[cfg(feature = "threads")]
mod browser;
#[cfg(feature = "threads")]
pub use browser::RenderRuntime;
''')
    edit('rust/crates/render-wasm/src/lib.rs', '#[cfg(feature = "threads")]\nmod scheduler;', '#[cfg(any(test, feature = "threads"))]\nmod scheduler;')
    edit('rust/crates/render-wasm/src/scheduler/error.rs', 'pub(super) fn js_error(', '#[cfg(feature = "threads")]\npub(super) fn js_error(')
    p = ROOT / 'rust/crates/render-wasm/Cargo.toml'
    assert '[dev-dependencies]' not in p.read_text()
    p.write_text(p.read_text() + '''
# Reuse the existing locked dependencies for native coordinator tests. Do not
# activate the browser-only wasm-bindgen-rayon seam in the default test build.
[dev-dependencies]
futures-channel = "0.3"
rayon = "1.11"
''')
    edit('.github/workflows/ci.yml', '# CI verifies and consumes those artifacts; no Rust toolchain is needed.', '# CI consumes those artifacts. A separate native Rust gate tests the scheduler.')
    p = ROOT / '.github/workflows/ci.yml'
    p.write_text(p.read_text() + '''
  render-state:
    runs-on: ubuntu-latest
    env:
      CARGO_PROFILE_DEV_DEBUG: 0
    steps:
      - uses: actions/checkout@v4
      - name: native scheduler tests (default features)
        working-directory: rust
        run: |
          set -euo pipefail
          cargo test --locked -p render-wasm -- --list | tee /tmp/render-state-tests.txt
          grep -q '^scheduler::admission::tests::' /tmp/render-state-tests.txt
          grep -q '^scheduler::admission::lifecycle_tests::' /tmp/render-state-tests.txt
          grep -q '^scheduler::compute::tests::' /tmp/render-state-tests.txt
          cargo test --locked -p render-wasm
''')
elif mode == 'rust-tests':
    copy('.verification/wasm-lifecycle-tests.rs', 'rust/crates/render-wasm/src/scheduler/lifecycle_tests.rs')
    p = ROOT / 'rust/crates/render-wasm/src/scheduler/admission.rs'
    p.write_text(p.read_text() + '\n#[cfg(test)]\nmod lifecycle_tests;\n'.replace('mod lifecycle_tests;', '#[path = "lifecycle_tests.rs"]\nmod lifecycle_tests;'))
elif mode == 'rust-fix':
    path = 'rust/crates/render-wasm/src/scheduler/admission.rs'
    edit(path, '''struct Lease {
    owner: u32,
    key: String,
    busy: bool,
    released: bool,
}''', '''/// A released running job still owns its lane until compute completes.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum LeasePhase {
    Reserved,
    Running,
    Draining,
}
struct Lease {
    owner: u32,
    key: String,
    phase: LeasePhase,
}''')
    edit(path, '''                    busy: false,
                    released: false,''', '''                    phase: LeasePhase::Reserved,''')
    edit(path, 'lease.owner == owner && !lease.released && !self.closed.contains(&owner)', 'lease.owner == owner && lease.phase != LeasePhase::Draining && !self.closed.contains(&owner)')
    edit(path, '''        if lease.released || self.closed.contains(&lease.owner) {
            return Err(RuntimeError::Cancelled);
        }
        if lease.busy {
            return Err(RuntimeError::LeaseBusy);
        }
        lease.busy = true;''', '''        if self.closed.contains(&lease.owner) || lease.phase == LeasePhase::Draining {
            return Err(RuntimeError::Cancelled);
        }
        if lease.phase == LeasePhase::Running {
            return Err(RuntimeError::LeaseBusy);
        }
        lease.phase = LeasePhase::Running;''')
    edit(path, '''        lease.busy = false;
        let valid = !lease.released && !self.closed.contains(&lease.owner);
        if !valid {
            self.leases.remove(&id);
        }
        self.dispatch();
        valid''', '''        match lease.phase {
            // Completion is meaningful only for a started computation. A
            // duplicate idle completion must not claim a second delivery.
            LeasePhase::Reserved => false,
            LeasePhase::Running => {
                lease.phase = LeasePhase::Reserved;
                self.dispatch();
                true
            }
            LeasePhase::Draining => {
                self.leases.remove(&id);
                self.dispatch();
                false
            }
        }''')
    edit(path, '''            lease.released = true;
            if !lease.busy {
                self.leases.remove(&id);
            }''', '''            if lease.phase == LeasePhase::Reserved {
                self.leases.remove(&id);
            } else {
                lease.phase = LeasePhase::Draining;
            }''')
    edit(path, '''            lease.released = true;
            lease.busy''', '''            if lease.phase == LeasePhase::Reserved {
                return false;
            }
            lease.phase = LeasePhase::Draining;
            true''')
    text = (ROOT / path).read_text()
    assert 'lease.busy' not in text and 'lease.released' not in text
elif mode == 'web-tests':
    copy('.verification/runtime-cancellation.test.ts', 'web/src/render/runtime-cancellation.test.ts')
elif mode == 'web-fix':
    path = 'web/src/render/threaded-client.ts'
    blob(path, '9f1734d3977ab734cb6fc9eacce00d91140353f8')
    edit(path, '''      owners.add(owner)
      const alive''', '''      owners.add(owner)
      const cancellation = new AbortController()
      // Cancels this caller's wait, not shared initialization or Rust compute.
      // Always observe the underlying promise, including its late rejection.
      const waitForOwner = <T>(promise: Promise<T>): Promise<T> => new Promise((resolve, reject) => {
        const signal = cancellation.signal
        const stopped = () => {
          signal.removeEventListener("abort", stopped)
          reject(signal.reason)
        }
        signal.addEventListener("abort", stopped, { once: true })
        promise.then(value => {
          signal.removeEventListener("abort", stopped)
          if (signal.aborted) reject(signal.reason)
          else resolve(value)
        }, error => {
          signal.removeEventListener("abort", stopped)
          reject(error)
        })
        if (signal.aborted) stopped()
      })
      const alive''')
    edit(path, '''        if (!owners.delete(owner)) return
        const state''', '''        if (!owners.delete(owner)) return
        cancellation.abort(failure("The render batch was disposed", "RENDER_CANCELLED"))
        const state''')
    edit(path, '''          await state.ready
          alive()''', '''          await waitForOwner(state.ready)
          alive()''')
    edit(path, '''          const retain: RenderLane["retainTemplate"] = async (sha256, bytes) => {
            if (sha256''', '''          const retain: RenderLane["retainTemplate"] = async (sha256, bytes) => {
            alive()
            if (sha256''')
    edit(path, '''          try {
            alive()
            return await run({
              heldTemplate: () => state.dead ? undefined : held,''', '''          let result: T
          try {
            alive()
            result = await waitForOwner(run({
              heldTemplate: () => state.dead || cancellation.signal.aborted ? undefined : held,''')
    edit(path, '''              prepareAiImage: bytes => invoke("prepare", { bytes }, [bytes.buffer]) as Promise<RenderBytes>,
            })
          } finally {
            if (!state.dead) await call(state, "release", { leaseId }).catch(() => {})
          }
        },''', '''              prepareAiImage: bytes => invoke("prepare", { bytes }, [bytes.buffer]) as Promise<RenderBytes>,
            }))
          } finally {
            if (!state.dead) {
              // Send cleanup exactly once. Rust keeps a busy lease draining;
              // the request watchdog remains armed even if this caller leaves.
              const released = call(state, "release", { leaseId }).catch(() => {})
              if (!cancellation.signal.aborted) await waitForOwner(released)
            }
          }
          alive()
          return result
        },''')
else:
    raise SystemExit('unknown phase: ' + mode)

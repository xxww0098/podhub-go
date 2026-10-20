from pathlib import Path
import hashlib
import sys

root = Path.cwd()
crate = root / 'rust/crates/render-wasm'
src = crate / 'src'
expected = {
    'rust/crates/render-wasm/Cargo.toml': 'c4a5030ea3b8a4e8b2494fdeddb58292826a84ff',
    'rust/crates/render-wasm/src/lib.rs': '721ebf334cd1ca87d2921ca918a5935f0f56cf3b',
    'rust/crates/render-wasm/src/scheduler/mod.rs': 'a237aabd24f2060106d04bfd0d60c90c95dfdd6d',
    'rust/crates/render-wasm/src/scheduler/admission.rs': '0c6bf25800617f1f585a50b9252164f9b8376031',
    'rust/crates/render-wasm/src/scheduler/admission_tests.rs': '13253ee4949c6e0fd0f463248d860a7d125c5280',
    'rust/crates/render-wasm/src/scheduler/compute.rs': '13e5c28c7297a424023c6509a4cbec523261b467',
    'rust/crates/render-wasm/src/scheduler/error.rs': 'c601d747893c5f9b0d1e413e224379d9b292c5b5',
    'web/src/render/threaded-client.ts': '9f1734d3977ab734cb6fc9eacce00d91140353f8',
    'web/src/render/client.test.ts': '0829a7eb07018495b2e0893e98c8b2729bb82d79',
}
for name, digest in expected.items():
    data = (root / name).read_bytes()
    actual = hashlib.sha1(b'blob ' + str(len(data)).encode() + b'\0' + data).hexdigest()
    assert actual == digest, (name, actual, digest)

def replace(path, old, new):
    value = path.read_text()
    assert value.count(old) == 1, (str(path), old)
    path.write_text(value.replace(old, new))

replace(src/'lib.rs', '#[cfg(feature = "threads")]\nmod scheduler;', '#[cfg(any(test, feature = "threads"))]\nmod scheduler;')
p = crate/'Cargo.toml'
p.write_text(p.read_text() + '\n[dev-dependencies]\n# Reuse the runtime channel dependency for native state tests.\nfutures-channel = "0.3"\n')
p = src/'scheduler/mod.rs'
value = p.read_text()
runtime = value[value.index('use admission::'):].replace('use admission::', 'use super::admission::', 1).replace('use compute::Computed;', 'use super::compute::{self, Computed};', 1).replace('use error::', 'use super::error::', 1)
(src/'scheduler/runtime.rs').write_text('//! Browser-only bindgen and asynchronous adaptation.\n' + runtime)
p.write_text('//! One state model, exercised natively without enabling the browser adapter.\nmod admission;\nmod compute;\nmod error;\n\n#[cfg(feature = "threads")]\nmod runtime;\n')
replace(src/'scheduler/error.rs', 'pub(super) fn js_error(', '#[cfg(feature = "threads")]\npub(super) fn js_error(')
p = src/'scheduler/compute.rs'
replace(p, 'use futures_channel::oneshot;', '#[cfg(feature = "threads")]\nuse futures_channel::oneshot;')
replace(p, 'use std::cell::RefCell;', '#[cfg(feature = "threads")]\nuse std::cell::RefCell;')
replace(p, 'pub(super) async fn run<', '#[cfg(feature = "threads")]\npub(super) async fn run<')
if sys.argv[1] == 'expose':
    sys.exit(0)
assert sys.argv[1] == 'apply'
p = src/'scheduler/admission.rs'
replace(p, '''struct Lease {
    owner: u32,
    key: String,
    busy: bool,
    released: bool,
}''', '''#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum LeasePhase {
    Reserved,
    Running,
    // The owner has left; compute still owns the lane until completion.
    Draining,
}
struct Lease {
    owner: u32,
    key: String,
    phase: LeasePhase,
}''')
replace(p, '                    busy: false,\n                    released: false,', '                    phase: LeasePhase::Reserved,')
replace(p, 'lease.owner == owner && !lease.released && !self.closed.contains(&owner)', 'lease.owner == owner\n                && lease.phase != LeasePhase::Draining\n                && !self.closed.contains(&owner)')
replace(p, 'if lease.released || self.closed.contains(&lease.owner) {', 'if lease.phase == LeasePhase::Draining || self.closed.contains(&lease.owner) {')
replace(p, '''        if lease.busy {
            return Err(RuntimeError::LeaseBusy);
        }
        lease.busy = true;''', '''        if lease.phase != LeasePhase::Reserved {
            return Err(RuntimeError::LeaseBusy);
        }
        lease.phase = LeasePhase::Running;''')
replace(p, '''        lease.busy = false;
        let valid = !lease.released && !self.closed.contains(&lease.owner);
        if !valid {
            self.leases.remove(&id);
        }
''', '''        // Completion belongs to a running computation, never a reservation.
        // A duplicate completion must not make an idle lease look successful.
        let valid = match lease.phase {
            LeasePhase::Reserved => return false,
            LeasePhase::Running => {
                lease.phase = LeasePhase::Reserved;
                true
            }
            LeasePhase::Draining => false,
        };
        if !valid {
            self.leases.remove(&id);
        }
''')
replace(p, '''            lease.released = true;
            if !lease.busy {
                self.leases.remove(&id);
            }''', '''            if lease.phase == LeasePhase::Reserved {
                self.leases.remove(&id);
            } else {
                lease.phase = LeasePhase::Draining;
            }''')
replace(p, '''            lease.released = true;
            lease.busy''', '''            if lease.phase == LeasePhase::Reserved {
                false
            } else {
                lease.phase = LeasePhase::Draining;
                true
            }''')
p = src/'scheduler/admission_tests.rs'
p.write_text(p.read_text() + (root/'.verification/wasm-state-tests.rs').read_text())
p = root/'web/src/render/threaded-client.ts'
replace(p, '''      owners.add(owner)
      const alive = () => {
        if (!owners.has(owner)) throw failure("The render batch was disposed", "RENDER_CANCELLED")
      }
''', '''      owners.add(owner)
      const stopped = new AbortController()
      const alive = () => {
        if (stopped.signal.aborted) throw stopped.signal.reason
      }
      // Cancelling a caller is not cancelling compute. Observe every owner
      // wait (including shared init and caller IO), without releasing Rust's
      // busy lease or disabling the underlying request's watchdog.
      const waitForOwner = <T>(work: Promise<T>): Promise<T> => new Promise((resolve, reject) => {
        const signal = stopped.signal
        const abort = () => reject(signal.reason)
        signal.addEventListener("abort", abort, { once: true })
        // Observe late failures too, even when the owner has already stopped.
        work.then(value => {
          signal.removeEventListener("abort", abort)
          if (signal.aborted) reject(signal.reason)
          else resolve(value)
        }, error => {
          signal.removeEventListener("abort", abort)
          reject(error)
        })
        if (signal.aborted) {
          signal.removeEventListener("abort", abort)
          abort()
        }
      })
''')
replace(p, '        if (!owners.delete(owner)) return\n        const state = current', '        if (!owners.delete(owner)) return\n        stopped.abort(failure("The render batch was disposed", "RENDER_CANCELLED"))\n        const state = current')
replace(p, '          await state.ready\n          alive()', '          await waitForOwner(state.ready)\n          alive()')
replace(p, '''          const retain: RenderLane["retainTemplate"] = async (sha256, bytes) => {
            if (sha256 !== key)''', '''          const retain: RenderLane["retainTemplate"] = async (sha256, bytes) => {
            alive()
            if (sha256 !== key)''')
replace(p, '            return await run({', '            return await waitForOwner(Promise.resolve(run({')
replace(p, 'heldTemplate: () => state.dead ? undefined : held,', 'heldTemplate: () => state.dead || stopped.signal.aborted ? undefined : held,')
replace(p, '''              prepareAiImage: bytes => invoke("prepare", { bytes }, [bytes.buffer]) as Promise<RenderBytes>,
            })
          } finally {
            if (!state.dead) await call(state, "release", { leaseId }).catch(() => {})''', '''              prepareAiImage: bytes => invoke("prepare", { bytes }, [bytes.buffer]) as Promise<RenderBytes>,
            })))
          } finally {
            if (!state.dead) {
              const released = call(state, "release", { leaseId }).catch(() => {})
              // Cancellation settles the caller now; the release request is
              // still observed and supervised, and Rust drains busy compute.
              if (!stopped.signal.aborted) await waitForOwner(released)
            }''')
p = root/'web/src/render/client.test.ts'
p.write_text(p.read_text() + (root/'.verification/wasm-cancellation-tests.ts').read_text())
(root/'scripts/test-wasm-state.sh').write_text((root/'.verification/test-wasm-state.sh').read_text())
(root/'.github/workflows/wasm-state.yml').write_text((root/'.verification/wasm-state.yml').read_text())

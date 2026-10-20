from pathlib import Path
import json, os, re, shutil, subprocess, sys

ROOT = Path.cwd()
MODE = sys.argv[1]
STEP = sys.argv[2]
EVIDENCE = Path(os.environ['RUNNER_TEMP']) / ('fsm-' + MODE)
EVIDENCE.mkdir(parents=True, exist_ok=True)
BASE = 'be364cb76e87dc9ea178cd322b888ab3b641d998'
S = ROOT / 'rust/crates/render-wasm/src/scheduler'

def run(label, args, cwd=ROOT, expected=0):
    path = EVIDENCE / (label + '.log')
    print('RUN', label, ' '.join(args), flush=True)
    with path.open('w') as output:
        result = subprocess.run(args, cwd=cwd, stdout=output, stderr=subprocess.STDOUT)
    text = path.read_text(errors='replace')
    print('\n'.join(text.splitlines()[-(8 if result.returncode == expected else 70):]), flush=True)
    with (EVIDENCE / 'results.jsonl').open('a') as out:
        out.write(json.dumps({'check': label, 'command': args, 'exit': result.returncode, 'expected': expected}) + '\n')
    if result.returncode != expected:
        raise SystemExit(f'{label}: exit {result.returncode}, expected {expected}')
    return text

def replace(path, old, new):
    p = ROOT / path if isinstance(path, str) else path
    text = p.read_text()
    assert text.count(old) == 1, (str(p), old[:90], text.count(old))
    p.write_text(text.replace(old, new))

def method(text, start, end, new):
    a, b = text.index(start), text.index(end)
    return text[:a] + new + text[b:]

def bootstrap():
    replace('rust/crates/render-wasm/src/lib.rs', '#[cfg(feature = "threads")]\nmod scheduler;', '#[cfg(any(test, feature = "threads"))]\nmod scheduler;')
    original = (S / 'mod.rs').read_text()
    seam = original[original.index('use admission::'):]
    seam = seam.replace('use admission::', 'use super::admission::', 1).replace('use compute::Computed;', 'use super::compute::{self, Computed};', 1).replace('use error::', 'use super::error::', 1)
    (S / 'bindings.rs').write_text('//! Browser-only asynchronous bindgen adapter.\n' + seam)
    (S / 'mod.rs').write_text('//! Scheduler state is tested natively; only the browser adapter needs threads.\nmod admission;\nmod compute;\nmod error;\n\n#[cfg(feature = "threads")]\nmod bindings;\n#[cfg(feature = "threads")]\npub use bindings::RenderRuntime;\n')
    replace(S / 'compute.rs', 'use futures_channel::oneshot;', '#[cfg(feature = "threads")]\nuse futures_channel::oneshot;')
    replace(S / 'compute.rs', 'use std::cell::RefCell;', '#[cfg(feature = "threads")]\nuse std::cell::RefCell;')
    replace(S / 'compute.rs', "pub(super) async fn run<T: Send + 'static>(", "#[cfg(feature = \"threads\")]\npub(super) async fn run<T: Send + 'static>(")
    replace(S / 'error.rs', 'pub(super) fn js_error(', '#[cfg(feature = "threads")]\npub(super) fn js_error(')
    cargo = ROOT / 'rust/crates/render-wasm/Cargo.toml'
    assert '[dev-dependencies]' not in cargo.read_text()
    cargo.write_text(cargo.read_text() + '\n[dev-dependencies]\n# Native state tests use the same channel implementation, not a scheduler stub.\nfutures-channel = "0.3"\n')

def apply_rust():
    p = S / 'admission.rs'
    text = p.read_text()
    text = text.replace('struct Lease {', '''/// A cancelled computation still owns its resources until it actually ends.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum LeasePhase {
    Reserved,
    Running,
    Draining,
}
struct Lease {''', 1)
    text = text.replace('    busy: bool,\n    released: bool,', '    phase: LeasePhase,', 1)
    text = text.replace('                    busy: false,\n                    released: false,', '                    phase: LeasePhase::Reserved,', 1)
    text = text.replace('lease.owner == owner && !lease.released && !self.closed.contains(&owner)', 'lease.owner == owner && lease.phase != LeasePhase::Draining && !self.closed.contains(&owner)', 1)
    text = method(text, '    pub(super) fn start(', '    pub(super) fn set_external_bytes(', '''    pub(super) fn start(&mut self, id: u32) -> Result<String, RuntimeError> {
        let lease = self.leases.get_mut(&id).ok_or(RuntimeError::LeaseExpired)?;
        if self.closed.contains(&lease.owner) || lease.phase == LeasePhase::Draining {
            return Err(RuntimeError::Cancelled);
        }
        if lease.phase == LeasePhase::Running {
            return Err(RuntimeError::LeaseBusy);
        }
        lease.phase = LeasePhase::Running;
        Ok(lease.key.clone())
    }
    pub(super) fn completing(&self, id: u32, key: &str) -> bool {
        self.leases.get(&id).is_some_and(|lease| {
            lease.key == key && lease.phase != LeasePhase::Reserved
        })
    }
    pub(super) fn finish(&mut self, id: u32) -> bool {
        let Some(lease) = self.leases.get_mut(&id) else {
            return false;
        };
        if lease.phase == LeasePhase::Reserved {
            return false;
        }
        let valid = lease.phase == LeasePhase::Running && !self.closed.contains(&lease.owner);
        if valid {
            lease.phase = LeasePhase::Reserved;
        } else {
            self.leases.remove(&id);
        }
        self.dispatch();
        valid
    }
    pub(super) fn release(&mut self, id: u32) {
        if let Some(lease) = self.leases.get_mut(&id) {
            if lease.phase == LeasePhase::Reserved {
                self.leases.remove(&id);
            } else {
                lease.phase = LeasePhase::Draining;
            }
        }
        self.dispatch();
    }
    pub(super) fn dispose_owner(&mut self, owner: u32) {
        self.closed.insert(owner);
        let mut retained = VecDeque::new();
        for waiter in self.waiters.drain(..) {
            if waiter.owner == owner {
                let _ = waiter.reply.send(Err(RuntimeError::Cancelled));
            } else {
                retained.push_back(waiter);
            }
        }
        self.waiters = retained;
        self.leases.retain(|_, lease| {
            if lease.owner != owner {
                return true;
            }
            if lease.phase == LeasePhase::Reserved {
                return false;
            }
            lease.phase = LeasePhase::Draining;
            true
        });
        self.dispatch();
    }
''')
    old = '''                let required = self
                    .reserved_bytes()
                    .and_then(|reserved| reserved.checked_add(peak.unwrap().lane_bytes()))'''
    new = '''                let peak = peak.unwrap();
                // A new key pays its shared template once; another lane of an
                // already active key pays only its exclusive working set.
                let additional = if self.leases.values().any(|lease| lease.key == head.key) {
                    peak.lane_bytes()
                } else {
                    peak.total
                };
                let required = self
                    .reserved_bytes()
                    .and_then(|reserved| reserved.checked_add(additional))'''
    assert old in text
    text = text.replace(old, new, 1)
    assert '.busy' not in text and '.released' not in text
    p.write_text(text)
    replace(S / 'compute.rs', '''    if let Ok(Computed {
        peak: Some(peak), ..
    }) = &result''', '''    // Ignore duplicate/foreign completion before updating peaks or dispatching.
    if !state.completing(lease, key) {
        return Err(RuntimeError::Cancelled);
    }
    if let Ok(Computed {
        peak: Some(peak), ..
    }) = &result''')
    with (S / 'compute.rs').open('a') as out:
        out.write('''
#[cfg(test)]
mod completion_tests {
    use super::*;
    #[test]
    fn duplicate_or_foreign_completion_does_not_change_accounting() {
        let mut state = State::new(1, 1000);
        let id = state.acquire(1, "A".into()).unwrap().try_recv().unwrap().unwrap().unwrap();
        state.start(id).unwrap();
        assert_eq!(complete(&mut state, id, "B", Ok(Computed { value: 1, peak: Some(Peak::new(900, 0)) })), Err(RuntimeError::Cancelled));
        assert_eq!(complete(&mut state, id, "A", Ok(Computed { value: 7, peak: Some(Peak::new(100, 0)) })), Ok(7));
        let before = state.measure();
        assert_eq!(complete(&mut state, id, "A", Ok(Computed { value: 8, peak: Some(Peak::new(999, 0)) })), Err(RuntimeError::Cancelled));
        assert_eq!(state.measure(), before);
        assert!(state.start(id).is_ok());
    }
}
''')
    ci = ROOT / '.github/workflows/ci.yml'
    ci.write_text(ci.read_text().replace('# CI verifies and consumes those artifacts; no Rust toolchain is needed.', '# CI verifies committed artifacts; the scheduler has a separate native Rust gate.') + '''
  rust-scheduler:
    runs-on: ubuntu-latest
    timeout-minutes: 15
    permissions:
      contents: read
    steps:
      - uses: actions/checkout@v4
      - name: Native scheduler tests (no threads feature)
        working-directory: rust
        run: |
          rustup toolchain install 1.99.0 --profile minimal
          cargo test --locked -p render-wasm -- --list > "$RUNNER_TEMP/scheduler-tests.txt"
          grep -q 'scheduler::admission::tests::' "$RUNNER_TEMP/scheduler-tests.txt"
          grep -q 'scheduler::admission::lifecycle_tests::' "$RUNNER_TEMP/scheduler-tests.txt"
          grep -q 'scheduler::compute::tests::' "$RUNNER_TEMP/scheduler-tests.txt"
          cargo test --locked -p render-wasm
''')
    doc = ROOT / 'docs/parity/wasm-runtime-state.md'
    doc.write_text('''# WASM runtime lease lifecycle

The native test target compiles the same admission and completion logic used
by the threaded runtime. Only bindings and Rayon dispatch are feature-gated;
no mock scheduler, second implementation, or new runtime dependency is added.
The CI rust-scheduler job checks that named scheduler suites exist before running them.

A live lease is Reserved, Running, or Draining. Running completion returns a
valid lease to Reserved so parse and render can share admission. Release or
owner cancellation removes a Reserved lease, but marks a Running lease as
Draining until compute ends. Draining results are never delivered. A finish
without a running computation is ignored. The oneshot adapter consumes each
compute completion once; this change does not add durable operation IDs.

Admission charges a distinct template's shared bytes once in addition to its
exclusive working set. Previously the incoming template always paid only the
exclusive part, undercounting a new active key. Same-template sharing and the
existing idle single-job exception to the soft memory budget are unchanged.

Tests cover 4^6 lifecycle sequences, duplicate completion, cancellation handoff,
shared reservation boundaries, and the existing FIFO/overflow/ID tests.
Run from rust/: cargo test --locked -p render-wasm
After Rust changes run make wasm at the repository root and check all artifacts.
Browser traps still destroy the whole shared runtime; this is not a GPU,
PSD algorithm, thread-count, color-depth, or compatibility-layer change.
''')

def apply_web():
    p = ROOT / 'web/src/render/threaded-client.ts'
    text = p.read_text()
    old = '''      owners.add(owner)
      const alive = () => {'''
    new = '''      owners.add(owner)
      const cancellation = new AbortController()
      // Stop this caller's wait, not the underlying work. Its finally block,
      // Rust lease and watchdog keep running until actual completion/teardown.
      const whileAlive = <T>(work: Promise<T>): Promise<T> => new Promise((resolve, reject) => {
        const signal = cancellation.signal
        const cancelled = () => reject(signal.reason)
        const cleanup = () => signal.removeEventListener("abort", cancelled)
        // Always observe late success/failure, even if already cancelled.
        void work.then(value => { cleanup(); resolve(value) }, error => { cleanup(); reject(error) })
        if (signal.aborted) cancelled()
        else signal.addEventListener("abort", cancelled, { once: true })
      })
      const alive = () => {'''
    assert old in text
    text = text.replace(old, new, 1)
    text = text.replace('''        if (!owners.delete(owner)) return
        const state = current''', '''        if (!owners.delete(owner)) return
        cancellation.abort(failure("The render batch was disposed", "RENDER_CANCELLED"))
        const state = current''', 1)
    old = '''        async withLane<T>(key: string, run: (lane: RenderLane) => Promise<T>): Promise<T> {
          alive()'''
    new = '''        withLane<T>(key: string, run: (lane: RenderLane) => Promise<T>): Promise<T> {
          return whileAlive((async () => {
          alive()'''
    assert old in text
    text = text.replace(old, new, 1)
    old = '''            if (!state.dead) await call(state, "release", { leaseId }).catch(() => {})
          }
        },'''
    new = '''            if (!state.dead) await call(state, "release", { leaseId }).catch(() => {})
          }
          })())
        },'''
    assert old in text
    text = text.replace(old, new, 1)
    # Indent the original operation without changing its acquire/finally semantics.
    first = text.index('          return whileAlive((async () => {\n') + len('          return whileAlive((async () => {\n')
    last = text.index('          })())', first)
    text = text[:first] + ''.join('  ' + line if line.strip() else line for line in text[first:last].splitlines(keepends=True)) + text[last:]
    p.write_text(text)
    (ROOT / 'docs/parity/wasm-owner-cancellation.md').write_text('''# WASM batch cancellation boundary

A batch's caller can be awaiting shared initialization, metadata admission,
its own async callback, a compute reply, or a release acknowledgement.
Disposal now rejects that outer wait through a batch-scoped AbortController.
It does not cancel a JavaScript callback's arbitrary side effects and does not
pretend a running WASM calculation has stopped.

The inner operation remains observed through success and failure. Existing
alive checks prevent late initialization from acquiring for a disposed owner.
Pending compute watchdogs, Rust busy leases and finally cleanup remain active.
The last owner still destroys the runtime; disposing one of multiple owners
must not destroy another owner's runtime. No automatic retry is introduced.

Controlled transport tests cover cancellation before initialization completes,
a pending callback, delayed release acknowledgement and late initialization
failure. They do not duplicate Rust admission; use the real threaded browser
fixture and native scheduler tests for the resource lifecycle.
''')

if STEP == 'baseline':
    if MODE == 'rust-state':
        listing = run('baseline-test-list', ['cargo', 'test', '--locked', '-p', 'render-wasm', '--', '--list'], ROOT / 'rust')
        assert 'scheduler::admission::tests::' not in listing
        bootstrap()
        run('exposed-existing-tests', ['cargo', 'test', '--locked', '-p', 'render-wasm'], ROOT / 'rust')
        shutil.copyfile(ROOT / '.verification/wasm-fsm/lease-tests.rs', S / 'lease_lifecycle_tests.rs')
        with (S / 'admission.rs').open('a') as out:
            out.write('\n#[cfg(test)]\n#[path = "lease_lifecycle_tests.rs"]\nmod lifecycle_tests;\n')
        red = run('lease-red', ['cargo', 'test', '--locked', '-p', 'render-wasm', 'completion_requires_running_and_is_not_delivered_twice', '--', '--nocapture'], ROOT / 'rust', 101)
        assert 'a reservation is not a completed computation' in red
        red = run('budget-red', ['cargo', 'test', '--locked', '-p', 'render-wasm', 'a_different_template_pays_its_shared_bytes_before_admission', '--', '--nocapture'], ROOT / 'rust', 101)
        assert 'a new template must pay its shared bytes' in red
    else:
        run('web-existing', ['bun', 'test', '--preload', './tests/network-guard.preload.ts', './src/render/client.test.ts'], ROOT / 'web')
        shutil.copyfile(ROOT / '.verification/wasm-fsm/owner-cancel-tests.ts', ROOT / 'web/src/render/owner-cancel.test.ts')
        red = run('owner-red', ['bun', 'test', '--preload', './tests/network-guard.preload.ts', './src/render/owner-cancel.test.ts'], ROOT / 'web', 1)
        assert 'owner must not wait' in red
elif STEP == 'candidate':
    if MODE == 'rust-state':
        apply_rust()
        for p in [S / name for name in ['mod.rs', 'bindings.rs', 'admission.rs', 'compute.rs', 'error.rs', 'lease_lifecycle_tests.rs']]:
            result = subprocess.run(['rustfmt', '+1.99.0', '--edition', '2024'], input=p.read_bytes(), stdout=subprocess.PIPE, check=True)
            p.write_bytes(result.stdout)
        listing = run('candidate-test-list', ['cargo', 'test', '--locked', '-p', 'render-wasm', '--', '--list'], ROOT / 'rust')
        for group in ['scheduler::admission::tests::', 'scheduler::admission::lifecycle_tests::', 'scheduler::compute::tests::', 'scheduler::compute::completion_tests::']:
            assert group in listing, group
        run('native-all', ['cargo', 'test', '--locked', '-p', 'render', '-p', 'psdx', '-p', 'render-wasm'], ROOT / 'rust')
        run('native-release-scheduler', ['cargo', 'test', '--locked', '--release', '-p', 'render-wasm', 'scheduler::'], ROOT / 'rust')
        run('lock-unchanged', ['git', 'diff', '--exit-code', '--', 'rust/Cargo.lock'])
    else:
        apply_web()
        for i in range(20):
            run(f'owner-green-{i+1}', ['bun', 'test', '--preload', './tests/network-guard.preload.ts', './src/render/owner-cancel.test.ts', './src/render/client.test.ts'], ROOT / 'web')
        run('web-full', ['bun', 'run', 'test'], ROOT / 'web')
        run('web-build', ['bun', 'run', 'build'], ROOT / 'web')
        run('api-contract', ['bun', 'run', 'api:check'], ROOT / 'web')
elif STEP == 'wasm':
    run('wasm-rebuild', ['make', 'wasm'])
    run('wasm-manifest', ['bash', 'scripts/check-wasm-dist.sh'])
    run('web-render', ['bun', 'test', '--preload', './tests/network-guard.preload.ts', './tests/render-wasm.test.ts', './tests/render-worker.test.ts', './src/render'], ROOT / 'web')
    run('web-build', ['bun', 'run', 'build'], ROOT / 'web')
elif STEP == 'publish':
    paths = (['rust/crates/render-wasm', 'wasm/dist', '.github/workflows/ci.yml', 'docs/parity/wasm-runtime-state.md'] if MODE == 'rust-state' else ['web/src/render/threaded-client.ts', 'web/src/render/owner-cancel.test.ts', 'docs/parity/wasm-owner-cancellation.md'])
    branch = 'fix/wasm-' + MODE + '-20261021'
    run('reset-index-to-base', ['git', 'reset', '--mixed', BASE])
    run('stage-verified-files', ['git', 'add', '--'] + paths)
    run('diff-check', ['git', 'diff', '--cached', '--check'])
    changes = subprocess.check_output(['git', 'diff', '--cached', '--name-only'], text=True).splitlines()
    assert changes and all(any(name == prefix or name.startswith(prefix + '/') for prefix in paths) for name in changes), changes
    (EVIDENCE / 'changes.json').write_text(json.dumps(changes, indent=2))
    (EVIDENCE / 'verified.patch').write_bytes(subprocess.check_output(['git', 'diff', '--cached', '--binary']))
    (EVIDENCE / 'blobs.txt').write_bytes(subprocess.check_output(['git', 'ls-files', '-s', '--'] + paths))
    run('author-name', ['git', 'config', 'user.name', 'github-actions[bot]'])
    run('author-email', ['git', 'config', 'user.email', '41898282+github-actions[bot]@users.noreply.github.com'])
    run('commit', ['git', 'commit', '-m', 'fix(wasm): ' + ('test and enforce explicit lease lifecycle and shared reservations' if MODE == 'rust-state' else 'cancel owner waits without releasing running compute')])
    sha = subprocess.check_output(['git', 'rev-parse', 'HEAD'], text=True).strip()
    # Create only: do not force-push an existing branch, touch main, or deploy.
    if subprocess.check_output(['git', 'ls-remote', '--heads', 'origin', branch], text=True).strip():
        raise SystemExit('topic branch already exists; refusing to replace it')
    run('publish-tested-topic', ['git', 'push', 'origin', 'HEAD:refs/heads/' + branch])
    summary = {'branch': branch, 'head': sha, 'base': BASE, 'result': 'passed-before-publish', 'run_id': os.environ['GITHUB_RUN_ID']}
    (EVIDENCE / 'publication.json').write_text(json.dumps(summary, indent=2))
    print('PUBLICATION ' + json.dumps(summary), flush=True)
else:
    raise SystemExit('unknown step')

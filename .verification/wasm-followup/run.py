from pathlib import Path
import json, os, shutil, subprocess, sys
R = Path.cwd()
S = R / 'rust/crates/render-wasm/src/scheduler'
E = Path(os.environ['RUNNER_TEMP']) / 'wasm-state-followup'
E.mkdir(parents=True, exist_ok=True)
BASE = 'a1ff3a5dadb16a89b744ee6161b95022126f14c2'

def run(name, args, cwd=R, expected=0):
    path = E / (name + '.log')
    print('RUN', name, ' '.join(args), flush=True)
    with path.open('w') as output:
        result = subprocess.run(args, cwd=cwd, stdout=output, stderr=subprocess.STDOUT)
    text = path.read_text(errors='replace')
    interesting = [line for line in text.splitlines() if 'test result:' in line or line.strip().endswith((' pass', ' fail', ' skip'))]
    print('\n'.join(interesting + text.splitlines()[-(8 if result.returncode == expected else 60):]), flush=True)
    with (E / 'results.jsonl').open('a') as output:
        output.write(json.dumps({'check': name, 'command': args, 'exit': result.returncode, 'expected': expected}) + '\n')
    if result.returncode != expected: raise SystemExit(f'{name}: unexpected exit {result.returncode}')
    return text

step = sys.argv[1]
if step == 'red':
    run('baseline-native', ['cargo', 'test', '--locked', '-p', 'render-wasm'], R / 'rust')
    shutil.copyfile(R / '.verification/wasm-followup/reservation_tests.rs', S / 'reservation_tests.rs')
    with (S / 'admission.rs').open('a') as output:
        output.write('\n#[cfg(test)]\n#[path = "reservation_tests.rs"]\nmod reservation_tests;\n')
    with (S / 'compute.rs').open('a') as output:
        output.write((R / '.verification/wasm-followup/completion_tests.rs').read_text())
    text = run('reservation-red', ['cargo', 'test', '--locked', '-p', 'render-wasm', 'reservation_tests::', '--', '--nocapture'], R / 'rust', 101)
    assert 'missing shared reservation' in text and 'shared reservation overflow must fail closed' in text
    text = run('completion-red', ['cargo', 'test', '--locked', '-p', 'render-wasm', 'completion_guard_tests::', '--', '--nocapture'], R / 'rust', 101)
    assert 'duplicate completion must not update peaks' in text and 'foreign completion must not claim the lease' in text
elif step == 'green':
    path = S / 'admission.rs'
    text = path.read_text()
    before = '''                let required = self
                    .reserved_bytes()
                    .and_then(|reserved| reserved.checked_add(peak.unwrap().lane_bytes()))'''
    after = '''                let peak = peak.unwrap();
                // Only an already active template has paid its shared slice.
                let additional = if self.leases.values().any(|lease| lease.key == head.key) {
                    peak.lane_bytes()
                } else {
                    peak.total
                };
                let required = self
                    .reserved_bytes()
                    .and_then(|reserved| reserved.checked_add(additional))'''
    assert text.count(before) == 1
    text = text.replace(before, after, 1)
    marker = '    pub(super) fn finish(&mut self, id: u32) -> bool {'
    assert text.count(marker) == 1
    text = text.replace(marker, '''    pub(super) fn completing(&self, id: u32, key: &str) -> bool {
        self.leases.get(&id).is_some_and(|lease| {
            lease.key == key && lease.phase != LeasePhase::Reserved
        })
    }
''' + marker, 1)
    path.write_text(text)
    path = S / 'compute.rs'
    text = path.read_text()
    marker = '''    if let Ok(Computed {
        peak: Some(peak), ..
    }) = &result'''
    assert text.count(marker) == 1
    text = text.replace(marker, '''    // Reject stale/foreign completion before it can change memory accounting.
    // Draining work is still measured, then finish discards its result.
    if !state.completing(lease, key) {
        return Err(RuntimeError::Cancelled);
    }
''' + marker, 1)
    path.write_text(text)
    for name in ['admission.rs', 'compute.rs', 'reservation_tests.rs']:
        path = S / name
        formatted = subprocess.run(['rustfmt', '+1.99.0', '--edition', '2024'], input=path.read_bytes(), stdout=subprocess.PIPE, check=True)
        path.write_bytes(formatted.stdout)
    run('native-all', ['cargo', 'test', '--locked', '-p', 'render', '-p', 'psdx', '-p', 'render-wasm'], R / 'rust')
    run('native-release', ['cargo', 'test', '--locked', '--release', '-p', 'render-wasm', 'scheduler::'], R / 'rust')
    run('native-ci-gate', ['bash', 'scripts/test-wasm-state.sh'])
    run('lock-unchanged', ['git', 'diff', '--exit-code', '--', 'rust/Cargo.lock'])
    (R / 'docs/parity/wasm-reservation-boundaries.md').write_text('''# WASM admission and completion boundary follow-up

Base: PR #11 at a1ff3a5dadb16a89b744ee6161b95022126f14c2.
Keep its native test gate, three-state leases, cancellation handling and browser adapter.

An incoming lane of an already active template adds only its exclusive bytes.
An incoming distinct template must also pay its shared bytes once. The admission
sum remains checked; overflow never compares equal to the soft budget.
Tests explicitly supply retained template metadata to exercise this arithmetic
invariant; they are not evidence of an observed production OOM or cache hit rate.
Unknown-template isolation, FIFO and idle single-job progress remain unchanged.

Completion now validates lease/key and Running/Draining phase before changing
peak measurements. A duplicate reply while Reserved, a removed lease, or a
foreign template cannot update accounting or finish another operation.
Draining compute still records actual cost before its result is discarded.
The actual adapter continues to consume a oneshot completion once; this is not
an exactly-once distributed protocol or operation-version scheme.

Tests cover exact budget and external bytes, overflow, same-template sharing,
duplicate completion and foreign-template completion. Existing lifecycle event
sequence tests remain in place. No new dependency, state, compatibility path,
thread count, image algorithm or production data change is included.

Reproduce: scripts/test-wasm-state.sh; cargo test --locked -p render -p psdx -p render-wasm
(from rust/ for cargo). Run make wasm after changes and verify SOURCES.sha256.
''')
elif step == 'artifacts':
    run('rebuild', ['make', 'wasm'])
    run('manifest', ['bash', 'scripts/check-wasm-dist.sh'])
    run('render-goldens', ['bun', 'test', '--preload', './tests/network-guard.preload.ts', './tests/render-wasm.test.ts', './tests/render-worker.test.ts', './src/render'], R / 'web')
    run('web-full', ['bun', 'run', 'test'], R / 'web')
    run('web-build', ['bun', 'run', 'build'], R / 'web')
    run('api-contract', ['bun', 'run', 'api:check'], R / 'web')
elif step == 'publish':
    paths = ['rust/crates/render-wasm/src/scheduler/admission.rs', 'rust/crates/render-wasm/src/scheduler/compute.rs', 'rust/crates/render-wasm/src/scheduler/reservation_tests.rs', 'wasm/dist', 'docs/parity/wasm-reservation-boundaries.md']
    branch = 'fix/wasm-state-followup-20261021'
    run('base-index', ['git', 'reset', '--mixed', BASE])
    run('stage', ['git', 'add', '--'] + paths)
    run('diff-check', ['git', 'diff', '--cached', '--check'])
    files = subprocess.check_output(['git', 'diff', '--cached', '--name-only'], text=True).splitlines()
    assert files and all(any(f == p or f.startswith(p + '/') for p in paths) for f in files), files
    (E / 'verified.patch').write_bytes(subprocess.check_output(['git', 'diff', '--cached', '--binary']))
    (E / 'staged-blobs.txt').write_bytes(subprocess.check_output(['git', 'ls-files', '-s', '--'] + paths))
    run('name', ['git', 'config', 'user.name', 'github-actions[bot]'])
    run('email', ['git', 'config', 'user.email', '41898282+github-actions[bot]@users.noreply.github.com'])
    run('commit', ['git', 'commit', '-m', 'fix(wasm): account distinct template reservations and reject stale completions'])
    sha = subprocess.check_output(['git', 'rev-parse', 'HEAD'], text=True).strip()
    assert not subprocess.check_output(['git', 'ls-remote', '--heads', 'origin', branch], text=True).strip(), 'ref exists; refusing overwrite'
    run('publish-tested-topic', ['git', 'push', 'origin', 'HEAD:refs/heads/' + branch])
    result = {'base': BASE, 'head': sha, 'branch': branch, 'run': os.environ['GITHUB_RUN_ID']}
    (E / 'publication.json').write_text(json.dumps(result, indent=2))
    print('PUBLICATION ' + json.dumps(result), flush=True)
else: raise SystemExit('unknown step')

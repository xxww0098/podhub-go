from pathlib import Path
import os, re, sys
part = sys.argv[1]
e = Path(os.environ['EVIDENCE'])
run = os.environ['GITHUB_RUN_ID']
base = 'be364cb76e87dc9ea178cd322b888ab3b641d998'
root = Path.cwd()
def rust_counts(name):
    values = re.findall(r'test result: ok\. (\d+) passed; (\d+) failed; (\d+) ignored', (e/name).read_text())
    assert values, name
    return tuple(sum(int(v[i]) for v in values) for i in range(3))
def bun_counts(name):
    text = (e/name).read_text()
    def count(kind):
        found = re.findall(r'^\s*(\d+) '+kind+r'\s*$', text, re.M)
        return int(found[-1]) if found else 0
    assert count('pass') > 0, name
    return (count('pass'), count('fail'), count('skip'))
common = f'Base: `{base}`. Verification: https://github.com/xxww0098/podhub-go/actions/runs/{run}.\n\nNo merge, deployment or production data operation. These topic branches exclude the verification workflow. Full PR CI is separate from the pre-publication checks below.\n'
if part == 'rust-state':
    before = rust_counts('seam-baseline.log')
    after = rust_counts('native-after.log')
    repeats = [rust_counts(f'state-repeat-{n}.log') for n in range(1,21)]
    web = bun_counts('render-after.log')
    content = '''# WASM lease state and default native tests

The scheduler's state and completion tests were hidden behind the `threads` feature. The bindgen API now lives in `scheduler/browser.rs`, while default native tests compile the actual admission and completion modules with the same already-locked Rayon/oneshot dependencies. No new crate, framework or production dependency was added.

Lease state is `Reserved`, `Running`, or `Draining`. Release/disposal removes an idle lease, but running work remains charged until completion. A successful live completion returns to Reserved so one lease can parse then render. Idle or removed leases cannot report successful completion. There is no persistent terminal-state history and no per-operation generation protocol added in this change.

Admission policy, FIFO order, template sharing, soft-budget progress exception and trap destruction are unchanged. Owner tombstones and historical peaks have NOT been redesigned in this batch.

## Verification

'''+common+f'''
- Baseline default test listing contained no scheduler tests. After moving only the compilation seam, render-wasm baseline: {before[0]} passed, {before[1]} failed, {before[2]} ignored.
- Added idle-completion regression failed on the old state implementation, then passed after the three-state change.
- Native render/psdx/render-wasm: {after[0]} passed, {after[1]} failed, {after[2]} ignored.
- Scheduler-only suite repeated 20 times: {sum(x[0] for x in repeats)} passing test executions. Its deterministic model enumerates all 16,384 seven-event sequences per run.
- Rebuilt WASM/render/worker tests: {web[0]} passed, {web[1]} failed.
- Full `make wasm`, manifest verification, frontend build, and the real Chrome threaded fixture passed before publishing.
- CI now explicitly checks that admission, lifecycle and completion tests are discovered, then runs default `cargo test --locked -p render-wasm`.

No wall-clock speedup or peak-memory reduction is claimed. The previously existing timing/flamegraph tests remain ignored.
'''
    name = 'wasm-lease-state.md'
else:
    before = bun_counts('host-before.log')
    after = bun_counts('cancel-after.log')
    full = bun_counts('web-full.log')
    content = '''# Owner-scoped cancellation in the render host

`withLane` previously waited on shared initialization without observing owner disposal. Disposing one of two owners did not immediately settle its wait. A caller waiting inside its callback or waiting for release acknowledgement could also outlive disposal.

A per-batch AbortController now rejects only the caller's waits. It does not cancel shared initialization or claim that Rust compute stopped. The underlying promises remain observed, so late errors cannot become unhandled rejections. Cleanup sends release once; Rust and the existing request watchdog retain responsibility for running compute. A disposed cached-template fast path cannot return a handle or transfer inputs.

Rust admission, queue, memory budget, WASM artifacts, pixel rules and the production runtime destruction policy are unchanged. This does not forcibly stop arbitrary JavaScript callback code or its external side effects.

## Verification

'''+common+f'''
- Existing host baseline: {before[0]} passed, {before[1]} failed.
- New regression file failed on the old host; the expected pre-init cancellation assertion was checked.
- New and existing host tests after the fix: {after[0]} passed, {after[1]} failed.
- Six new cancellation cases repeated 20 times (120 test executions), all passed.
- Full frontend suite: {full[0]} passed, {full[1]} failed, {full[2]} skipped. No existing threshold/assertion or network guard was weakened.
- Typecheck/build and API contract verification passed.
- Real Chrome threaded fixture and a gated real-Worker initialization cancellation scenario passed; the surviving owner completed using the same runtime.

The new tests cover multiple initialization waiters, late initialization failure, late callback success/failure, cached-handle revocation, release acknowledgement and unchanged normal callback errors.
'''
    name = 'render-owner-cancellation.md'
path = root/'docs/parity'/name
path.parent.mkdir(parents=True, exist_ok=True)
path.write_text(content)
(e/'summary.md').write_text(content)
print(content)

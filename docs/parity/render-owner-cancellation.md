# Owner-scoped cancellation in the render host

`withLane` previously waited on shared initialization without observing owner disposal. Disposing one of two owners did not immediately settle its wait. A caller waiting inside its callback or waiting for release acknowledgement could also outlive disposal.

A per-batch AbortController now rejects only the caller's waits. It does not cancel shared initialization or claim that Rust compute stopped. The underlying promises remain observed, so late errors cannot become unhandled rejections. Cleanup sends release once; Rust and the existing request watchdog retain responsibility for running compute. A disposed cached-template fast path cannot return a handle or transfer inputs.

Rust admission, queue, memory budget, WASM artifacts, pixel rules and the production runtime destruction policy are unchanged. This does not forcibly stop arbitrary JavaScript callback code or its external side effects.

## Verification

Base: `be364cb76e87dc9ea178cd322b888ab3b641d998`. Verification: https://github.com/xxww0098/podhub-go/actions/runs/39464443533.

No merge, deployment or production data operation. These topic branches exclude the verification workflow. Full PR CI is separate from the pre-publication checks below.

- Existing host baseline: 11 passed, 0 failed.
- New regression file failed on the old host; the expected pre-init cancellation assertion was checked.
- New and existing host tests after the fix: 17 passed, 0 failed.
- Six new cancellation cases repeated 20 times (120 test executions), all passed.
- Full frontend suite: 3117 passed, 0 failed, 2 skipped. No existing threshold/assertion or network guard was weakened.
- Typecheck/build and API contract verification passed.
- Real Chrome threaded fixture and a gated real-Worker initialization cancellation scenario passed; the surviving owner completed using the same runtime.

The new tests cover multiple initialization waiters, late initialization failure, late callback success/failure, cached-handle revocation, release acknowledgement and unchanged normal callback errors.

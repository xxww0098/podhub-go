# WASM batch cancellation boundary

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

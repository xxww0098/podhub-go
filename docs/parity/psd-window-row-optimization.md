# PSD WASM: borrow retained rows on identity exports

Base: `be364cb76e87dc9ea178cd322b888ab3b641d998`.
Verification: [successful run 39435644983](https://github.com/xxww0098/podhub-go/actions/runs/39435644983), completed before this topic branch was published.

## Reference and scope

Studied PhotoCraft at `46e538b3a2bacb533e89c7a30a99bbf2d91c3381`:
- [raster](https://github.com/storytold/photocraft/blob/46e538b3a2bacb533e89c7a30a99bbf2d91c3381/crates/raster/src/lib.rs): immutable Arc-shared pixel storage.
- [compose](https://github.com/storytold/photocraft/blob/46e538b3a2bacb533e89c7a30a99bbf2d91c3381/crates/compose/src/lib.rs): tiled/banded output avoids retaining another complete composite.

This independently implements an optimization of the existing PodHub slab/window renderer. No PhotoCraft code was copied and no dependency was added. No sparse-tile rewrite, GPU migration, parser replacement, color/depth expansion, thread-count change, or resource-budget relaxation is included.

## Production change

`WindowRgbaRows::source_row` borrows the resident Arc-backed slice. For output dimensions equal to the export rectangle, `read_rgba_row` copies only the cropped segment into the existing encoder output buffer. Transparent padding fills that buffer directly. This removes one temporary full-document-width allocation/copy per identity row request, not every copy in the pipeline.

Scaled exports retain the old copy adapter and bilinear arithmetic. Slab refill, admission, cancellation, JPEG quality, alpha handling and output protocol remain unchanged.

An earlier general Cow-based candidate passed correctness checks but slowed scaled sampling by approximately 9% in run 39433526178; it was rejected. This patch narrows the optimization instead.

## Measurement

Rust 1.99.0, Linux GitHub-hosted runner, release profile. Five samples per case, each reading five frames after warm-up from a retained 4096x2048 RGBA window. These are native row-read microbenchmarks, not browser end-to-end PSD timings or measured peak-memory savings. Approximately 1% variation in scaled sampling is not a claimed speedup. No timing assertion was added.

| Row microbenchmark (five frames) | Before median | After median | Elapsed reduction |
|---|---:|---:|---:|
| 4096x2048 | 12.477 ms | 7.241 ms | 41.97% |
| 2048x1024 | 306.428 ms | 303.240 ms | 1.04% |

## Verification and artifacts

- Native render, psdx and render-wasm tests: 367 passed, 0 failed, 3 ignored. The new manual row benchmark was explicitly executed before and after; existing timing/flamegraph harnesses remain ignored.
- Pointer-alias regression fails on the old implementation and passes on the optimized one.
- Independent old-algorithm oracle checks crop, padding, identity/scaled exports, repeated/reverse reads and identical JPEG bytes at qualities 1/82/100.
- Freshly rebuilt WASM render/worker tests: 72 passed, 0 failed.
- Real Chrome threaded-render fixture passes, including watchdog recovery and unsupported-depth refusal. This is not a large-template performance benchmark.
- `make wasm`, artifact/source manifest verification and `bun run build` pass.
- All source/binary Git blobs were compared with the successful artifact staged-blobs list. Publication did not hand-edit the manifest.

The workspace-wide source manifest requires rebuilding all committed modules. The existing build can embed nondeterministic LLVM symbol IDs, so unrelated module bytes can change without listing-rule source changes. Full PR Go/frontend CI remains separate from these targeted checks.

## Reproduce

```sh
cd rust
cargo test --locked -p render -p psdx -p render-wasm
cargo test --locked --release -p render window_row_benchmark -- --ignored --nocapture
cd ..
make wasm
bash scripts/check-wasm-dist.sh
cd web
bun install --frozen-lockfile
bun test --preload ./tests/network-guard.preload.ts ./tests/render-wasm.test.ts ./tests/render-worker.test.ts ./src/render
bun run build
```

The Chrome fixture procedure and original logs are in the linked verification run. No production deployment or data operation is performed.

# Browser listing-core fixtures

These application-owned snapshots are served by the isolated browser harness.
They keep browser module imports and the static server inventory inside `web`;
crate test directories are not browser assets.

`ozon-publish-input.json` pins only the row and card consumed by the publish
pipeline. Its source is the native `ozon-freeze-golden.json` fixture in
`rust/crates/listing-core-wasm/tests/fixtures/ambient`, alongside the source of
`decorative-wall-art-schema.json`. The native fixture owns expected freeze
results; the browser snapshot owns the scenario's initial state.

The Node-side `publish-pipeline-fixture-parity.test.ts` compares both inputs
structurally with the native fixtures on every Web test run. When the native
contract intentionally changes, review and update these snapshots together;
do not add browser imports or static access to crate internals. Remove a
snapshot only when its browser scenarios are removed or use another verified
input contract.

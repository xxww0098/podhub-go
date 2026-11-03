# Listing goldens

Local contract evidence for validation, execution plans, listing-core operations
and Seller `import_v3` composition. Identifiers, URLs and store references are
synthetic; these snapshots do not prove authorization, platform writes or live
product availability.

## Owned evidence

- `validation/` — Draft → Validated snapshots, including rejection cases.
- `plans/` — Execution Plan snapshots and source step kinds.
- `ozon/product-import-request.json` — `/v3/product/import` body and digest.
- `core-ops/` — listing-core operation input/output pairs shared with WASM checks.
- `variant-group-parity.json` — variant-group parity cases.

The owning tests define the exact files and assertions.

Category data comes from `GET /api/catalog/schema`, not a Desktop inventory
file. Product capability admission is tracked separately in the
[verification checklist](../../docs/precision-listing-verification.md).

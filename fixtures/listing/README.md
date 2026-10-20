# Listing goldens

Evidence Cloud listing tests still own: Draft → Validated, Execution Plan, and
Seller `import_v3` compose. Identifiers, URLs and store references are
synthetic.

## Owned evidence

- `validation/` — Draft → Validated snapshots, including rejection cases.
- `plans/` — Execution Plan snapshots and source step kinds.
- `ozon/product-import-request.json` — `/v3/product/import` body and digest.

The owning tests define the exact files and assertions.

Cloud admits a category by its live Category Schema
(`GET /api/catalog/schema`). There is no Desktop inventory file.

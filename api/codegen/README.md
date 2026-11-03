# OpenAPI generation

Each YAML config selects operations from [openapi.yaml](../openapi.yaml) for one
generated output, by tag or explicit `include-operation-ids` when a domain
spans tags. Run `make generate` from the repository root; tool versions are
pinned in the [Makefile](../../Makefile). Do not edit generated Go files.

## Flat catalog tree nodes

`CatalogTreeNode` and `CatalogTreeCacheNode` are flat: each node carries a
nullable `parent_index` (the zero-based parent position in the list) and the tree ships as one
flat node list. Keep the catalog outputs flat when changing the contract;
do not restore recursive child models from older generated snapshots.

After regeneration, review the generated diff, run `go test ./internal/catalog/... ./tests/archtest`
and check all packages with `go test -run '^$' ./...` from the repository root.
The latter still runs package `TestMain` functions: the integration suite prepares
its shared migrated PostgreSQL template when `PODHUB_PARITY_DSN` is unset and
Docker is available, even though no test functions match.

When the OpenAPI document changes, update the frontend from `web/` in this order:

```sh
bun run api:generate
bun run api:routes
bun run api:check
bun run test src/api/routes.test.ts
```

`api:generate` updates `schema.d.ts`; `api:routes` derives the path table in
`routes.ts` from that schema. `api:check` checks only the schema; the route test
separately checks the path table and its use by callers.

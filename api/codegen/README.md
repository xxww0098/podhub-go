# OpenAPI generation

Each YAML config selects the operations for one generated output, by tag or by
explicit `include-operation-ids` when a domain spans tags. Run `make generate`
from the repository root; do not edit generated Go files.

## Flat catalog tree nodes

`CatalogTreeNode` and `CatalogTreeCacheNode` are flat: each node carries a
nullable `parent_id` (the parent node `type_id`) and the tree ships as one
flat node list. No schema in the contract is self-referencing, so no config
needs `exclude-schemas` to keep recursive leftovers out of unrelated outputs.

If a future change reintroduces a recursive schema, pin the owning output and
have every other config exclude that schema again, resolving shared package
ownership as before. The catalog contract tests check flat-list responses and
generated-model isolation; run them and compile all packages after
regeneration.

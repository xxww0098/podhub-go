/**
 * `routes.ts` is the documented surface; this gate is the served one.
 *
 * Both `routes.ts` and the server follow `api/openapi.yaml`, so they agree with
 * the contract while still disagreeing with each other: a documented operation
 * the Go router never mounts compiles, type-checks, and fails only when a user
 * clicks. That is what this ratchet covers — it compares the SPA's paths with
 * the router's own table (`internal/app/testdata/routes.txt`, which
 * `TestRouteTableMatchesGolden` keeps equal to the live chi router).
 *
 * The list below may only shrink. Each entry is a documented route the server
 * does not serve yet; delete the line when the route is mounted, and never add
 * one — a new SPA call to an unmounted path is exactly the bug.
 */
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import test from "node:test"

import { ROUTES } from "./routes"

/**
 * Paths in `routes.ts` with no matching entry in the router's golden table.
 * Shrink only.
 */
const UNMOUNTED = new Set([
  // Documented by the 2026-10 contract but absent from the regenerated router
  // golden table; the revoke UI still targets it.
  "/api/admin/redeem-codes/{id}",
  "/api/ai/ocr/uploads",
  "/api/ai/ocr/uploads/confirm",
  "/api/ai/recharge/orders",
  "/api/ai/recharge/orders/{public_id}/recover",
  "/api/avatars/me",
  "/api/avatars/workspaces/{workspace_id}",
  "/api/avatars/workspaces/{workspace_id}/upload",
  "/api/integrations/config",
  "/api/listing/cards/{id}/reconcile",
  "/api/listing/cards/{id}/sku-import/preview",
  "/api/listing/cards/{id}/templates/{digest}",
  "/api/listing/rows/release-unknown",
  "/api/listing/rows/{id}/ai/fail",
  "/api/listing/rows/{id}/ai/settle",
  "/api/listing/rows/{id}/media",
  "/api/listing/rows/{id}/media/images",
  "/api/listing/rows/{id}/media/images/{index}",
  "/api/listing/rows/{id}/prepare",
  "/api/listing/rows/{id}/prepare/cancel",
  "/api/listing/rows/{id}/repair-and-submit",
  "/api/listing/templates",
  "/api/listing/templates/{id}/confirm",
  "/api/listing/templates/{id}/multipart/abort",
  "/api/listing/templates/{id}/multipart/complete",
  "/api/me/catalog-automation/grants",
  "/api/me/catalog-automation/grants/{id}/revoke",
  "/api/notifications",
  "/api/notifications/read-all",
  "/api/notifications/{uuid}/read",
  "/api/ocr-quota",
  "/api/orders",
  "/api/orders/{public_id}",
  "/api/orders/{public_id}/cancel",
  "/api/orders/{public_id}/recover",
  "/api/payment-intent",
  "/api/payment-intent/renewal",
  "/api/payment-methods",
  "/api/plans",
  "/api/prompts/categories",
  "/api/prompts/category/{description_category_id}/{type_id}",
  "/api/videos/category/{description_category_id}/{type_id}",
  "/api/view/account-overview",
  "/api/workspace/billing/overview",
  "/api/workspace/ops/product-variants/operations",
  "/api/workspace/ops/product-variants/operations/{operation_id}",
  "/api/workspace/ops/product-variants/previews",
  "/api/workspaces/stores/{uuid}/shipping/ensure",
  "/api/workspaces/stores/{uuid}/shipping/readiness",
])

const GOLDEN = fileURLToPath(new URL("../../../internal/app/testdata/routes.txt", import.meta.url))

/** Paths the Go router registers, ignoring the method and normalising parameters. */
function mountedPaths(): Set<string> {
  const paths = new Set<string>()
  for (const line of readFileSync(GOLDEN, "utf8").split("\n")) {
    const entry = line.trim()
    if (entry === "") continue
    const [, path] = entry.split(" ")
    // chi's `*` catch-all and OpenAPI's multi-segment parameter are the same
    // route; the golden table is the router's spelling, so compare in that one.
    paths.add(path.replace(/\{[^}*]+\}/g, "{}").replace(/\{\*\}/g, "{}").replace(/\/\*$/, "/{}"))
  }
  return paths
}

/** A declared template as the router spells it: `{name}` becomes `{}`. */
function comparable(template: string): string {
  return template.replace(/\{(\*?)[a-z_]+\}/g, "{}")
}

test("every SPA path is served by the router or listed as unmounted", () => {
  const mounted = mountedPaths()
  // 81 endpoints left the contract in the 2026-10 regeneration; the deduped
  // path table is ~277 now, so this only guards against a broken scan.
  assert.ok(mounted.size > 250, `golden route table has ${mounted.size} entries; the scan is broken`)

  const offenders: string[] = []
  const stale: string[] = []
  const seen = new Set<string>()
  for (const template of Object.values(ROUTES)) {
    seen.add(template)
    const served = mounted.has(comparable(template))
    if (served && UNMOUNTED.has(template)) stale.push(template)
    if (!served && !UNMOUNTED.has(template)) offenders.push(template)
  }

  assert.deepEqual(
    offenders,
    [],
    "these documented paths have no mounted route; mount them in Go before calling them from the SPA",
  )
  assert.deepEqual(
    stale,
    [],
    "these paths are mounted now; delete their UNMOUNTED line so the ratchet can only shrink",
  )
  assert.deepEqual(
    [...UNMOUNTED].filter((path) => !seen.has(path)).sort(),
    [],
    "an UNMOUNTED line names a path routes.ts no longer spells",
  )
})

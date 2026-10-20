import assert from "node:assert/strict"
import test from "node:test"
import { route } from "@/api/routes"
import { createAutomationGrant, listAutomationGrants, revokeAutomationGrant } from "./http-automation-grants"

const row = { id: "grant-id", name: "assistant", actions: ["supplier:read"], tokenPrefix: "opa_safe…", createdAtMs: 1, expiresAtMs: null, lastUsedAtMs: null, revokedAtMs: null, scopeKind: "supplier_catalog", sourceIds: [] }

test("supplier grant requests preserve explicit all/none ranges and default to none", async () => {
  const previous = globalThis.fetch
  const observed: { path: string; body: unknown }[] = []
  globalThis.fetch = async (input, init) => {
    assert.equal(init?.credentials, "include")
    observed.push({ path: String(input), body: JSON.parse(String(init?.body)) })
    return Response.json({ data: { grant: row, token: "opa_one_time_secret" } })
  }
  try {
    for (const sourceIds of [undefined, [], null, ["source-1"]]) {
      const created = await createAutomationGrant("supplier_catalog", { name: "assistant", actions: ["supplier:read"], expiresInDays: 30, sourceIds })
      assert.equal(created.token, "opa_one_time_secret")
    }
    assert.deepEqual(observed.map((request) => (request.body as { sourceIds: unknown }).sourceIds), [[], [], null, ["source-1"]])
    assert.ok(observed.every((request) => request.path === route("adminSupplierAutomationGrants")))
  } finally { globalThis.fetch = previous }
})

test("catalog uses account routes and later views contain only a prefix", async () => {
  const previous = globalThis.fetch
  const observed: string[] = []
  globalThis.fetch = async (input, init) => {
    observed.push(`${init?.method} ${String(input)}`)
    if (init?.method === "POST") return Response.json({ data: { id: "grant-id", revoked: true } })
    return Response.json({ data: { grants: [{ ...row, scopeKind: "catalog", actions: ["catalog:read"], sourceIds: null }] } })
  }
  try {
    const grants = await listAutomationGrants("catalog")
    assert.equal(grants[0]?.scopeKind, "catalog")
    assert.equal("token" in grants[0]!, false)
    await revokeAutomationGrant("catalog", "grant-id")
    assert.deepEqual(observed, [`GET ${route("meCatalogAutomationGrants")}`, `POST ${route("meCatalogAutomationGrantsByIdRevoke", { id: "grant-id" })}`])
  } finally { globalThis.fetch = previous }
})

import assert from "node:assert/strict"
import test from "node:test"

import { integrationsHttp } from "./http-integrations"

type Fetch = typeof globalThis.fetch

function stubFetch(next: Fetch): () => void {
  const previous = globalThis.fetch
  globalThis.fetch = next
  return () => {
    globalThis.fetch = previous
  }
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  })
}

/** Only the roster fields `executableStore` reads: uuid, status, credential. */
const roster = {
  stores: [
    {
      uuid: "cloud-1",
      status: "active",
      credential_configured: true,
      credential_key_expires_at_ms: 1_000,
      revision: 3,
      credential_revision: 2,
      permissions: { manage_store: true, edit_name: true, manage_key_grants: true, manage_tags: true, test_key: true, manage_key: true, delete_store: true },
      assignee_key_manage: false,
      tags: [],
    },
  ],
  store_limit: 1,
  stores_used: 1,
  suspended: false,
  tags: [],
  tombstones: [],
}

test("a lapsed Seller key is refused before any Ozon round trip", async (t) => {
  const calls: string[] = []
  const restore = stubFetch(async (input, init) => {
    calls.push(`${init?.method ?? "GET"} ${String(input)}`)
    return jsonResponse({ data: roster })
  })
  t.after(restore)

  await assert.rejects(
    () => integrationsHttp.integrationsTestOzonStore({ id: "cloud-1" }),
    (reason: unknown) =>
      typeof reason === "object" &&
      reason !== null &&
      (reason as { code?: string }).code === "workspace_store_credential_expired",
  )
  // Cloud's own 409 is `CREDENTIAL_EXPIRED`; the refusal must fire before the
  // credential test POST, so only the roster read leaves the browser.
  assert.deepEqual(calls, ["GET /api/workspaces/stores"])
})

test("a future expiry and a legacy never-expiring key still test", async (t) => {
  const routes: string[] = []
  const restore = stubFetch(async (input, init) => {
    const method = init?.method ?? "GET"
    const path = String(input)
    routes.push(`${method} ${path}`)
    if (path.endsWith("/credential/test")) return jsonResponse({ data: {} })
    return jsonResponse({
      data: {
        ...roster,
        stores: [
          { ...roster.stores[0], credential_key_expires_at_ms: Date.now() + 60_000 },
        ],
      },
    })
  })
  t.after(restore)

  await integrationsHttp.integrationsTestOzonStore({ id: "cloud-1" })
  assert.ok(routes.includes("POST /api/workspaces/stores/cloud-1/credential/test"))
})

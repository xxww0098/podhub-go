import assert from "node:assert/strict"
import test from "node:test"

import { integrationsHttp } from "./http-integrations"
import { route } from "@/api/routes"
import type { components } from "@/api/schema"

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

test("AI account settings read the mounted admin configuration endpoint", async (t) => {
  const config: components["schemas"]["AdminIntegrationConfigView"] = {
    schema_version: 1,
    revision: 3,
    cache_ttl_seconds: 300,
    ai_default_model: "qwen3.7-flash",
    ai_runtime: { max_concurrency_global: 0, max_concurrency_user: 0, max_concurrency_account: 0, user_rate_per_minute: 0, lease_ttl_seconds: 90, allow_public_egress: false },
    ai_accounts: [{
      id: "qa-ai-account",
      label: "QA recognition",
      base_url: "https://example.test/v1",
      api_format: "chat_completions",
      model: "qwen3.7-flash",
      active: true,
      thinking: "disabled",
      thinking_format: "enable_thinking",
      priority: 0,
      purpose: "ocr",
    }],
  }
  const restore = stubFetch(async (input, init) => {
    assert.equal(String(input), route("adminIntegrationsConfig"))
    assert.equal(init?.method, "GET")
    assert.equal(init?.credentials, "include")
    return jsonResponse({ data: config })
  })
  t.after(restore)

  const overview = await integrationsHttp.integrationsGetCredentials()
  assert.equal(overview.ai_default_model, config.ai_default_model)
  assert.equal(overview.ai_accounts[0]?.id, "qa-ai-account")
  assert.equal(overview.ai_accounts[0]?.thinking, false)
  assert.equal(overview.ai_accounts[0]?.configured, true)
})

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
      permissions: { manage_store: true, edit_name: true, manage_tags: true, test_key: true, manage_key: true, delete_store: true },

      tags: [],
    },
  ],
  store_limit: 1,
  stores_used: 1,
  suspended: false,
  tags: [],
  tombstones: [],
}

test("Workspace roster decodes the bare DTO used by the store gate", async (t) => {
  const restore = stubFetch(async (input, init) => {
    assert.equal(init?.credentials, "include")
    if (String(input) === route("viewAccountOverview")) {
      return jsonResponse({ data: { active_workspace: { uuid: "workspace-1" } } })
    }
    assert.equal(String(input), route("workspacesStores"))
    return jsonResponse({ ...roster, stores: [{ ...roster.stores[0], name: "QA store" }] })
  })
  t.after(restore)
  const result = await integrationsHttp.integrationsListOzonStores()
  assert.equal(result.store_limit, 1)
  assert.equal(result.stores[0]?.label, "QA store")
  assert.equal(result.stores[0]?.cloud_store_uuid, "cloud-1")
  assert.equal(result.stores[0]?.configured, true)
})

test("a lapsed Seller key is refused before any Ozon round trip", async (t) => {
  const calls: string[] = []
  const restore = stubFetch(async (input, init) => {
    calls.push(`${init?.method ?? "GET"} ${String(input)}`)
    return jsonResponse(roster)
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
  assert.deepEqual(calls, [`GET ${route("workspacesStores")}`])
})

test("a future expiry and a legacy never-expiring key still test", async (t) => {
  const routes: string[] = []
  const restore = stubFetch(async (input, init) => {
    const method = init?.method ?? "GET"
    const path = String(input)
    routes.push(`${method} ${path}`)
    if (path.endsWith("/credential/test")) return jsonResponse({ data: {} })
    if (path === route("viewAccountOverview")) return jsonResponse({ data: {} })
    return jsonResponse({
      ...roster,
      stores: [
        { ...roster.stores[0], credential_key_expires_at_ms: Date.now() + 60_000 },
      ],
    })
  })
  t.after(restore)

  await integrationsHttp.integrationsTestOzonStore({ id: "cloud-1" })
  assert.ok(routes.includes(`POST ${route("workspacesStoresByUuidCredentialTest", { uuid: "cloud-1" })}`))
})

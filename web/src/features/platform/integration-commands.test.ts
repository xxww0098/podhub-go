import { aiAccountsHttp } from "@/bindings/http-ai-accounts"
import { applyAiDefaultModel } from "@/bindings/integration-ai-writes"
/**
 * Integrations writes are read-modify-write compositions over two Cloud
 * snapshots — the Workspace Store roster and the platform integration config — so
 * the test stubs `globalThis.fetch` and asserts the routes, the methods and
 * the bodies each composition produces, including the refusals that must
 * never reach Cloud.
 */
import { route } from "@/api/routes"
import assert from "node:assert/strict"
import test from "node:test"

import { integrationsHttp } from "@/bindings/http-integrations"

type Call = { url: string, method: string, body: unknown }

function recordFetch(
  reply: (call: Call) => unknown,
  failOn?: (call: Call) => string | undefined,
): { calls: Call[], restore: () => void } {
  const previous = globalThis.fetch
  const calls: Call[] = []
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const raw = init?.body
    const call: Call = {
      url: String(input),
      method: init?.method ?? "GET",
      body:
        raw === undefined || raw instanceof Uint8Array ? raw : JSON.parse(String(raw)),
    }
    calls.push(call)
    const refusal = failOn?.(call)
    if (refusal) {
      return new Response(JSON.stringify({ error: refusal, code: "CONFLICT" }), {
        status: 409,
        headers: { "Content-Type": "application/json" },
      })
    }
    const value = reply(call)
    const body = call.url.startsWith(route("workspacesStores")) ? value : { data: value }
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    })
  }) as typeof globalThis.fetch
  return { calls, restore: () => { globalThis.fetch = previous } }
}

const overview = {
  session: { authenticated: true, role: "super_admin" },
  workspaces: [],
  active_workspace: { id: 1, uuid: "workspace-uuid", name: "示例", plan: "pro", role: "owner", is_owned: true },
  owned_count: 1,
  owned_limit: 3,
}

const store = {
  uuid: "store-1",
  name: "旧名字",
  client_id: "12345",
  create_order: 1,
  credential_configured: true,
  credential_revision: 4,
  credential_verified_operators: 1,
  manual_disabled: false,
  quota_suspended: false,
  revision: 7,
  status: "active",

  permissions: {
    manage_store: true,
    edit_name: true,

    test_key: true,
    manage_key: true,
    manage_tags: true,
    delete_store: true,
  },
}

function rosterReply(
  stores: unknown[],
  tombstones: unknown[] = [],
  tags?: unknown[],
  groups?: unknown[],
): unknown {
  return { stores, store_limit: 3, stores_used: stores.length, suspended: 0, tombstones, tags, groups }
}

const config = {
  schema_version: 1,
  ai_default_model: "gpt-test",
  system_storage: [],
  revision: 12,
  cache_ttl_seconds: 300,
  ai_runtime: { max_concurrency_global: 0, max_concurrency_user: 0, max_concurrency_account: 0, user_rate_per_minute: 0, lease_ttl_seconds: 90, allow_public_egress: false },
  ai_accounts: [
    {
      id: "ai_one",
      label: "主力",
      base_url: "https://api.example.test/v1",
      api_format: "chat_completions" as const,
      model: "gpt-test",
      active: true,
      thinking: "disabled" as const,
      thinking_format: "enable_thinking" as const,
      priority: 0,
      purpose: "ocr" as const,
    },
  ],
}

function integrationsReply(call: Call): unknown {
  if (call.url === route("viewAccountOverview")) return overview
  if (call.url.startsWith(route("workspacesStores"))) {
    return call.method === "GET" ? rosterReply([store]) : { store, ok: true }
  }
  return config
}

test("name lookup only sends credentials to the read-only resolve route", async () => {
  const stub = recordFetch(() => ({ name: "Seller 店铺名" }))
  try {
    assert.deepEqual(await integrationsHttp.integrationsResolveOzonStoreName({ client_id: "12345", api_key: "fixture-key" }), { name: "Seller 店铺名" })
    assert.deepEqual(stub.calls, [{ url: route("workspacesStoresCredentialsResolveName"), method: "POST", body: { client_id: "12345", api_key: "fixture-key" } }])
  } finally { stub.restore() }
})

test("a blank new Store name stays automatic and returns the Seller fill outcome", async () => {
  const created = { ...store, uuid: "new-store", name: "新店铺", client_id: null, credential_configured: false }
  const stub = recordFetch((call) => {
    if (call.url === route("viewAccountOverview")) return overview
    if (call.method === "GET") return rosterReply(call.url === route("workspacesStores") ? [] : [created])
    if (call.url.endsWith("/credential")) return { name_filled: true }
    return { store: created }
  })
  try {
    const result = await integrationsHttp.integrationsUpsertOzonStore({ id: "", label: "  ", client_id: "12345", api_key: "fixture-key" })
    assert.equal(result.name_filled, true)
    assert.deepEqual(stub.calls.find((call) => call.method === "POST" && call.url === route("workspacesStores"))?.body, { name: "" })
  } finally { stub.restore() }
})

test("saving an existing Store re-keys it through the credential route", async () => {
  const stub = recordFetch(integrationsReply)
  try {
    await integrationsHttp.integrationsUpsertOzonStore({
      id: "store-1",
      label: "新名字",
      client_id: "12345",
      api_key: "seller-key",
    })
    assert.deepEqual(
      stub.calls.map((call) => `${call.method} ${call.url}`),
      [
        "GET /api/workspaces/stores",
        "POST /api/workspaces/stores/store-1/credential",
        "GET /api/workspaces/stores",
        "GET /api/view/account-overview",
      ],
    )
    assert.deepEqual(stub.calls[1].body, {
      client_id: "12345",
      api_key: "seller-key",
      confirm_upload: true,
      expected_store_revision: 7,
      expected_credential_revision: 4,
    })
  } finally {
    stub.restore()
  }
})

test("new Store identity comes from its creation response even with concurrent stores", async () => {
  const created = { ...store, uuid: "created-here", name: "新店" }
  const concurrent = { ...store, uuid: "created-elsewhere", name: "新店" }
  const stub = recordFetch((call) => {
    if (call.url === route("viewAccountOverview")) return overview
    if (call.method === "POST") return { store: created }
    return rosterReply([store, concurrent, created])
  })
  try {
    const result = await integrationsHttp.integrationsCreateOzonStore({ label: "新店" })
    assert.equal(result.id, "created-here")
    assert.deepEqual(result.roster.stores.map((row) => row.id), ["store-1", "created-elsewhere", "created-here"])
    assert.equal(stub.calls.filter((call) => call.method === "POST").length, 1)
  } finally {
    stub.restore()
  }
})

test("renaming a Store uses the profile route without touching credentials", async () => {
  const stub = recordFetch(integrationsReply)
  try {
    await integrationsHttp.integrationsRenameOzonStore({ id: "store-1", name: "新名字" })
    assert.deepEqual(stub.calls.map((call) => `${call.method} ${call.url}`), [
      "GET /api/workspaces/stores",
      "PUT /api/workspaces/stores/store-1",
      "GET /api/workspaces/stores",
      "GET /api/view/account-overview",
    ])
    assert.deepEqual(stub.calls[1].body, { name: "新名字", revision: 7 })
  } finally {
    stub.restore()
  }
})

test("a Client ID the roster already carries is adopted rather than minted twice", async () => {
  const stub = recordFetch(integrationsReply)
  try {
    await integrationsHttp.integrationsUpsertOzonStore({
      id: "leftover-local-id",
      label: "旧名字",
      client_id: "12345",
      api_key: "seller-key",
    })
    assert.deepEqual(
      stub.calls.map((call) => `${call.method} ${call.url}`),
      [
        "GET /api/workspaces/stores",
        "POST /api/workspaces/stores/store-1/credential",
        "GET /api/workspaces/stores",
        "GET /api/view/account-overview",
      ],
    )
  } finally {
    stub.restore()
  }
})

test("changing the Client ID without a key never reaches Cloud", async () => {
  const stub = recordFetch(integrationsReply)
  try {
    await assert.rejects(
      integrationsHttp.integrationsUpsertOzonStore({
        id: "store-1",
        label: "旧名字",
        client_id: "99999",
        api_key: "  ",
      }),
      /修改 Client ID 时必须同时输入 Seller API Key/,
    )
    assert.deepEqual(stub.calls.map((call) => `${call.method} ${call.url}`), [
      "GET /api/workspaces/stores",
    ])
  } finally {
    stub.restore()
  }
})

test("a Store minted for a save that fails is deleted again", async () => {
  const stub = recordFetch(
    (call) => (call.url === route("workspacesStores") && call.method === "POST"
      ? { store: { ...store, uuid: "minted", name: "新店铺", client_id: null, credential_configured: false, credential_revision: 0, revision: 1 } }
      : integrationsReply(call)),
    (call) => (call.url.endsWith("/credential") && call.method === "POST" ? "Seller 拒绝" : undefined),
  )
  try {
    await assert.rejects(
      integrationsHttp.integrationsUpsertOzonStore({
        id: "",
        label: "新店铺",
        client_id: "77777",
        api_key: "seller-key",
      }),
      /Seller 拒绝/,
    )
    assert.deepEqual(
      stub.calls.map((call) => `${call.method} ${call.url}`),
      [
        "GET /api/workspaces/stores",
        "POST /api/workspaces/stores",
        "POST /api/workspaces/stores/minted/credential",
        "DELETE /api/workspaces/stores/minted",
      ],
    )
    assert.deepEqual(stub.calls[3].body, { revision: 1 })
  } finally {
    stub.restore()
  }
})

test("batch import creates, adopts and cleans up per line", async () => {
  const stub = recordFetch(
    (call) => {
      if (call.method === "POST" && call.url === route("workspacesStores")) {
        const body = call.body as { name: string, client_id: string }
        return {
          store: {
            ...store,
            uuid: `minted-${body.client_id}`,
            name: body.name,
            client_id: body.client_id,
            credentialConfigured: false,
            credentialRevision: 0,
            revision: 1,
          },
        }
      }
      if (call.method === "POST" && call.url.endsWith("/credential")) {
        return {
          store_uuid: "x",
          credential_revision: 5,
          revision: 9,
          fingerprint_changed: true,
          rotated: false,
        }
      }
      return integrationsReply(call)
    },
    (call) =>
      call.method === "POST" && call.url.endsWith("/credential") && call.url.includes("minted-88888")
        ? "Seller 拒绝"
        : undefined,
  )
  try {
    const outcome = await integrationsHttp.integrationsImportOzonStores({
      items: [
        { source_ref: "1", name: "改名", client_id: "12345", api_key: "k-1" },
        { source_ref: "2", name: "新店", client_id: "77777", api_key: "k-2" },
        { source_ref: "3", name: "坏店", client_id: "88888", api_key: "k-3" },
      ],
    })
    assert.deepEqual(
      stub.calls.map((call) => `${call.method} ${call.url}`),
      [
        "GET /api/workspaces/stores",
        "POST /api/workspaces/stores/store-1/credential",
        "POST /api/workspaces/stores",
        "POST /api/workspaces/stores/minted-77777/credential",
        "POST /api/workspaces/stores",
        "POST /api/workspaces/stores/minted-88888/credential",
        "DELETE /api/workspaces/stores/minted-88888",
        "GET /api/workspaces/stores",
        "GET /api/view/account-overview",
      ],
    )
    // The adopted line re-keys the existing Store instead of minting another.
    assert.equal(stub.calls[1].body && (stub.calls[1].body as { expected_credential_revision: number }).expected_credential_revision, 4)
    assert.deepEqual(
      outcome.results.map((row) => [row.source_ref, row.status, row.uuid]),
      [
        ["1", "updated", "store-1"],
        ["2", "created", "minted-77777"],
        ["3", "failed", null],
      ],
    )
    assert.equal(outcome.results[2].reason, "Seller 拒绝")
  } finally {
    stub.restore()
  }
})

test("a repeated Client ID inside one batch adopts the Store the first line minted", async () => {
  const stub = recordFetch((call) => {
    if (call.method === "POST" && call.url === route("workspacesStores")) {
      return {
        store: {
          ...store,
          uuid: "minted-77777",
          client_id: null,
          credential_configured: false,
          credential_revision: 0,
          revision: 1,
        },
      }
    }
    if (call.method === "POST" && call.url.endsWith("/credential")) {
      return {
        store_uuid: "x",
        credential_revision: 5,
        revision: 9,
        fingerprint_changed: true,
        rotated: false,
      }
    }
    return integrationsReply(call)
  })
  try {
    const outcome = await integrationsHttp.integrationsImportOzonStores({
      items: [
        { source_ref: "1", name: "一店", client_id: "77777", api_key: "k-1" },
        { source_ref: "2", name: "同店", client_id: "77777", api_key: "k-2" },
      ],
    })
    assert.deepEqual(
      stub.calls.map((call) => `${call.method} ${call.url}`),
      [
        "GET /api/workspaces/stores",
        "POST /api/workspaces/stores",
        "POST /api/workspaces/stores/minted-77777/credential",
        "POST /api/workspaces/stores/minted-77777/credential",
        "GET /api/workspaces/stores",
        "GET /api/view/account-overview",
      ],
    )
    // The second line sees the first line's fresh revisions, not the mint's.
    assert.deepEqual(stub.calls[3].body, {
      client_id: "77777",
      api_key: "k-2",
      confirm_upload: true,
      expected_store_revision: 9,
      expected_credential_revision: 5,
    })
    assert.deepEqual(outcome.results.map((row) => row.status), ["created", "updated"])
  } finally {
    stub.restore()
  }
})

test("batch import resolves the #group name, minting it when the library lacks it", async () => {
  const stub = recordFetch((call) => {
    if (call.method === "GET" && call.url === route("workspacesStores")) {
      return rosterReply([store], [], [], [{ uuid: "group-1", name: "华东", store_count: 1 }])
    }
    if (call.method === "POST" && call.url === route("workspacesStoresGroups")) {
      const body = call.body as { name: string }
      return { group: { uuid: `group-${body.name}`, name: body.name, store_count: 0 } }
    }
    if (call.method === "POST" && call.url.endsWith("/credential")) {
      return {
        store_uuid: "x",
        credential_revision: 5,
        revision: 9,
        fingerprint_changed: true,
        rotated: false,
      }
    }
    if (call.method === "PUT" && call.url.startsWith(route("workspacesStores"))) {
      return { store: { ...store, revision: 10 } }
    }
    return integrationsReply(call)
  })
  try {
    const outcome = await integrationsHttp.integrationsImportOzonStores({
      items: [
        {
          source_ref: "1",
          name: "改名",
          client_id: "12345",
          api_key: "k-1",
          group_name: "vip",
        },
      ],
    })
    assert.deepEqual(
      stub.calls.map((call) => `${call.method} ${call.url}`),
      [
        "GET /api/workspaces/stores",
        "POST /api/workspaces/stores/groups",
        "POST /api/workspaces/stores/store-1/credential",
        "PUT /api/workspaces/stores/store-1",
        "GET /api/workspaces/stores",
        "GET /api/view/account-overview",
      ],
    )
    // The PUT carries the minted group, CAS on the revision the credential
    // write returned.
    assert.deepEqual(stub.calls[1].body, { name: "vip" })
    assert.deepEqual(stub.calls[3].body, {
      group_uuid: "group-vip",
      revision: 9,
    })
    assert.equal(outcome.results[0].status, "updated")
  } finally {
    stub.restore()
  }
})

test("a line whose group cannot be created fails before any credential write", async () => {
  const stub = recordFetch(
    (call) => integrationsReply(call),
    (call) =>
      call.method === "POST" && call.url === route("workspacesStoresGroups")
        ? "需要主管权限"
        : undefined,
  )
  try {
    const outcome = await integrationsHttp.integrationsImportOzonStores({
      items: [
        { source_ref: "1", name: "店", client_id: "12345", api_key: "k", group_name: "新分组" },
      ],
    })
    assert.deepEqual(
      stub.calls.map((call) => `${call.method} ${call.url}`),
      [
        "GET /api/workspaces/stores",
        "POST /api/workspaces/stores/groups",
        "GET /api/workspaces/stores",
        "GET /api/view/account-overview",
      ],
    )
    assert.equal(outcome.results[0].status, "failed")
    assert.equal(
      outcome.results[0].reason,
      "分组「新分组」未能创建：需要主管权限",
    )
  } finally {
    stub.restore()
  }
})

test("a failed group write fails the line without deleting the minted Store", async () => {
  const stub = recordFetch(
    (call) => {
      if (call.method === "GET" && call.url === route("workspacesStores")) {
        return rosterReply([store], [], [], [{ uuid: "group-1", name: "华东", store_count: 1 }])
      }
      if (call.method === "POST" && call.url === route("workspacesStores")) {
        return {
          store: {
            ...store,
            uuid: "minted-77777",
            client_id: null,
            credential_configured: false,
            credential_revision: 0,
            revision: 1,
          },
        }
      }
      if (call.method === "POST" && call.url.endsWith("/credential")) {
        return {
          store_uuid: "x",
          credential_revision: 5,
          revision: 9,
          fingerprint_changed: true,
          rotated: false,
        }
      }
      return integrationsReply(call)
    },
    (call) =>
      call.method === "PUT" && call.url.startsWith(route("workspacesStores"))
        ? "名册已变化"
        : undefined,
  )
  try {
    const outcome = await integrationsHttp.integrationsImportOzonStores({
      items: [
        {
          source_ref: "1",
          name: "新店",
          client_id: "77777",
          api_key: "k-1",
          group_name: "华东",
        },
      ],
    })
    assert.deepEqual(
      stub.calls.map((call) => `${call.method} ${call.url}`),
      [
        "GET /api/workspaces/stores",
        "POST /api/workspaces/stores",
        "POST /api/workspaces/stores/minted-77777/credential",
        "PUT /api/workspaces/stores/minted-77777",
        "GET /api/workspaces/stores",
        "GET /api/view/account-overview",
      ],
    )
    assert.equal(outcome.results[0].status, "failed")
    assert.match(outcome.results[0].reason ?? "", /密钥已登记，但分组未能应用/)
    assert.equal(outcome.results[0].uuid, "minted-77777")
  } finally {
    stub.restore()
  }
})

test("export posts the credentials export route and returns items verbatim", async () => {
  const stub = recordFetch((call) =>
    call.url === route("workspacesStoresCredentialsExport")
      ? { items: [{ uuid: "s-1", name: "主店", client_id: "1", api_key: "k" }] }
      : integrationsReply(call),
  )
  try {
    const data = await integrationsHttp.integrationsExportOzonStores()
    assert.deepEqual(
      stub.calls.map((call) => `${call.method} ${call.url}`),
      ["POST /api/workspaces/stores/credentials/export"],
    )
    assert.deepEqual(data.items, [
      { uuid: "s-1", name: "主店", client_id: "1", api_key: "k" },
    ])
  } finally {
    stub.restore()
  }
})

test("服务端花名册不认识「当前店铺」，本浏览器的偏好覆盖在它上面", async () => {
  const storage = new Map<string, string>()
  const previousStorage = globalThis.localStorage
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => void storage.set(key, value),
    },
  })
  const stub = recordFetch(integrationsReply)
  try {
    const unpicked = await integrationsHttp.integrationsListOzonStores()
    assert.equal(unpicked.active_id, null)
    assert.equal(unpicked.stores[0]!.active, false)

    storage.set("podhub:active-store", JSON.stringify({ "workspace-uuid": "store-1" }))
    const picked = await integrationsHttp.integrationsListOzonStores()
    assert.equal(picked.active_id, "store-1")
    assert.equal(picked.stores[0]!.active, true)
  } finally {
    stub.restore()
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      value: previousStorage,
    })
  }
})

test("the roster acknowledges every tombstone it still carries", async () => {
  const stub = recordFetch((call) =>
    call.url === route("workspacesStores")
      ? rosterReply([store], [{ uuid: "gone-1", deletedAtMs: 1, revision: 2 }])
      : integrationsReply(call),
  )
  try {
    const roster = await integrationsHttp.integrationsListOzonStores()
    assert.ok(
      stub.calls.some(
        (call) =>
          call.method === "POST" &&
          call.url === route("workspacesStoresByUuidTombstoneConsumed", { uuid: "gone-1" }),
      ),
    )
    // Cloud owns the Seller key, so "configured" is the roster's own fact.
    assert.equal(roster.stores[0].secret_status, "present")
    assert.equal(roster.stores[0].can_manage, true)
    assert.equal(roster.active_id, null)
  } finally {
    stub.restore()
  }
})

test("deleting a Store reads Cloud's bare DTO and then repaints the roster", async () => {
  const stub = recordFetch((call) =>
    call.method === "DELETE"
      ? { uuid: "store-1", deleted: true, revision: 2 }
      : integrationsReply(call),
  )
  try {
    await integrationsHttp.integrationsDeleteOzonStore({ id: "store-1" })
    assert.deepEqual(
      stub.calls.map((call) => `${call.method} ${call.url}`),
      [
        "GET /api/workspaces/stores",
        "DELETE /api/workspaces/stores/store-1",
        "GET /api/workspaces/stores",
        "GET /api/view/account-overview",
      ],
    )
  } finally {
    stub.restore()
  }
})

test("setting the default model preserves account models and writes the snapshot", async () => {
  const stub = recordFetch(integrationsReply)
  try {
    await aiAccountsHttp.setDefaultModel(" gpt-test ")
    const body = stub.calls.find(
      (call) => call.method === "PUT" && call.url === route("adminIntegrationsConfig"),
    )?.body as { ai_default_model: string; ai_accounts: Array<Record<string, unknown>> }
    assert.equal(body.ai_default_model, "gpt-test")
    assert.equal(body.ai_accounts[0].model, "gpt-test")
    assert.equal(body.ai_accounts[0].base_url, "https://api.example.test/v1")
    assert.equal(body.ai_accounts[0].api_key, "")
    assert.equal(body.ai_accounts[0].purpose, "ocr")
    assert.deepEqual((body as { ai_runtime?: unknown }).ai_runtime, config.ai_runtime)
  } finally {
    stub.restore()
  }
})

test("default model requires an enabled matching account", () => {
  assert.throws(
    () => applyAiDefaultModel({ ...config, ai_accounts: [] }, "qwen3.7-flash"),
    /请先启用支持该模型/,
  )
  assert.throws(() => applyAiDefaultModel(config, "  "), /请先启用支持该模型/)
})

test("the AI models probe uses the seeded account, not a typed key", async () => {
  const stub = recordFetch(() => ({ models: [{ id: "gpt-test", owned_by: "example" }] }))
  try {
    const models = await aiAccountsHttp.listModels({
      id: "ai_one",
      base_url: "",
      api_format: "chat_completions",
      api_key: "",
    })
    assert.equal(stub.calls[0].url, route("adminIntegrationsAiModels"))
    assert.deepEqual(stub.calls[0].body, {
      account_id: "ai_one",
      base_url: null,
      api_key: null,
      api_format: "chat_completions",
    })
    assert.deepEqual(models, [{ id: "gpt-test", owned_by: "example" }])
  } finally {
    stub.restore()
  }
})

test("the AI verify probe asks about one model on the seeded account", async () => {
  const stub = recordFetch(() => ({ verified: true, model_present: false }))
  try {
    const result = await aiAccountsHttp.verifyModel({
      id: " ai_one ",
      model: " gpt-test ",
    })
    assert.equal(stub.calls[0].url, route("adminIntegrationsAiVerify"))
    assert.equal(stub.calls[0].method, "POST")
    assert.deepEqual(stub.calls[0].body, { account_id: "ai_one", model: "gpt-test" })
    assert.equal(result.verified, true)
    assert.equal(result.model_present, false)
    assert.ok(result.latency_ms >= 0)
  } finally {
    stub.restore()
  }
})

test("an AI verify probe can test a draft key before the account is saved", async () => {
  const stub = recordFetch(() => ({ verified: true, model_present: true }))
  try {
    const result = await aiAccountsHttp.verifyModel({
      model: "deepseek-flash",
      baseUrl: " https://api.deepseek.com ",
      apiKey: " sk-draft ",
      apiFormat: "chat_completions",
    })
    assert.deepEqual(stub.calls[0].body, {
      model: "deepseek-flash",
      base_url: "https://api.deepseek.com",
      api_key: "sk-draft",
      api_format: "chat_completions",
    })
    assert.equal(result.model_present, true)
  } finally {
    stub.restore()
  }
})

test("an AI verify probe without an account or model refuses before Cloud", async () => {
  const stub = recordFetch(() => ({}))
  try {
    await assert.rejects(
      aiAccountsHttp.verifyModel({ id: "  ", model: "gpt-test" }),
      /无法测试/,
    )
    await assert.rejects(
      aiAccountsHttp.verifyModel({ id: "ai_one", model: "  " }),
      /无法测试/,
    )
    assert.equal(stub.calls.length, 0)
  } finally {
    stub.restore()
  }
})

test("purging media refuses an empty prefix before it can wipe a bucket", async () => {
  const stub = recordFetch(() => ({}))
  try {
    await assert.rejects(
      integrationsHttp.integrationsPurgeMedia({ id: "s3_one", prefix: "  " }),
      /请先输入要清理的前缀/,
    )
    assert.equal(stub.calls.length, 0)
  } finally {
    stub.restore()
  }
})

import assert from "node:assert/strict"
import test from "node:test"
import type { components } from "@/api/schema"
import { route } from "@/api/routes"
import { applyAiUpsert, applyAiActive, applyAiDelete, applyAiDefaultModel, applyAiRuntime, type AiAccountDraft } from "./integration-ai-writes"
import { replaceIntegrationConfigRequest } from "./integration-writes"
import { aiAccountsHttp } from "./http-ai-accounts"
import { integrationOverview } from "./integration-config"

type Config = components["schemas"]["AdminIntegrationConfigView"]
const draft: AiAccountDraft = {
  id: null, label: "Primary", base_url: "https://example.test/v1", api_format: "chat_completions",
  model: "model-a", active: true, thinking: false, thinking_format: "none", priority: 20, apiKey: "new-secret", purpose: "ocr",
}
function fixture() {
  const row = {
    label: draft.label, base_url: draft.base_url, api_format: draft.api_format,
    model: draft.model, active: draft.active, thinking: "disabled" as const,
    thinking_format: draft.thinking_format, priority: draft.priority, purpose: "ocr" as const,
  }
  return {
    schema_version: 1, revision: 12, cache_ttl_seconds: 300, ai_default_model: "model-a",
    ai_runtime: { max_concurrency_global: 20, max_concurrency_user: 3, max_concurrency_account: 4, user_rate_per_minute: 15, lease_ttl_seconds: 120, allow_public_egress: true },
    ai_accounts: [{ ...row, id: "a" }, { ...row, id: "b", model: "model-b", priority: 1 }],
  } satisfies Config
}

test("default model switches without rewriting any account model or credential", () => {
  const config = fixture()
  const next = applyAiDefaultModel(config, " model-b ")
  assert.equal(next.ai_default_model, "model-b")
  assert.strictEqual(next.ai_accounts, config.ai_accounts)
  const request = replaceIntegrationConfigRequest(next)
  assert.equal(request.expected_revision, 12)
  assert.equal(request.ai_default_model, "model-b")
  assert.deepEqual(request.ai_accounts.map((row) => [row.model, row.api_key]), [["model-a", ""], ["model-b", ""]])
})

test("default requires an enabled exact-model Chat Completions account", () => {
  const config = fixture()
  assert.throws(() => applyAiDefaultModel(config, "other"))
  assert.throws(() => applyAiDefaultModel(applyAiActive(config, "b", false), "model-b"))
  assert.throws(() => applyAiDefaultModel({ ...config, ai_accounts: config.ai_accounts.map((row) => ({ ...row, api_format: "responses" })) }, "model-b"))
  assert.throws(() => applyAiDefaultModel({ ...config, ai_accounts: config.ai_accounts.map((row) => ({ ...row, purpose: "image" })) }, "model-b"))
})

test("account toggles are independent and deleting does not promote or rewrite another row", () => {
  const config = fixture()
  const disabled = applyAiActive(config, "a", false)
  assert.deepEqual(disabled.ai_accounts.map((row) => row.active), [false, true])
  assert.deepEqual(applyAiActive(disabled, "a", true).ai_accounts.map((row) => row.active), [true, true])
  const removed = applyAiDelete(config, "a")
  assert.equal(removed.ai_default_model, "model-a")
  assert.deepEqual(removed.ai_accounts, [config.ai_accounts[1]])
  assert.throws(() => applyAiDelete(config, "missing"))
  assert.throws(() => applyAiActive(config, "missing", true))
})

test("editing retains blank secrets, independent active state and requested priority", () => {
  const config = fixture()
  const edit = applyAiUpsert(config, { ...draft, id: "a", apiKey: "  ", active: false, priority: -10 })
  assert.equal(edit.credential, undefined)
  assert.strictEqual(edit.config.ai_accounts[1], config.ai_accounts[1])
  assert.equal(edit.config.ai_accounts[0].active, false)
  assert.equal(edit.config.ai_accounts[0].priority, -10)
  const imageConfig = { ...config, ai_accounts: [{ ...config.ai_accounts[0], purpose: "image" as const }, config.ai_accounts[1]] }
  const imageEdit = applyAiUpsert(imageConfig, { ...draft, id: "a", apiKey: "" })
  assert.equal(imageEdit.config.ai_accounts[0].purpose, "image")
  assert.equal(replaceIntegrationConfigRequest(imageEdit.config).ai_accounts[0].purpose, "image")
  assert.deepEqual(replaceIntegrationConfigRequest(imageEdit.config).ai_runtime, config.ai_runtime)
  assert.deepEqual(imageEdit.config.ai_runtime, config.ai_runtime)
  const rotated = applyAiUpsert(config, { ...draft, id: "a", apiKey: " replacement " })
  assert.deepEqual(replaceIntegrationConfigRequest(rotated.config, rotated.credential).ai_accounts.map((row) => row.api_key), ["replacement", ""])
  assert.throws(() => applyAiUpsert(config, { ...draft, id: "stale-id" }))
})

test("every request body carries each account's purpose and the stored runtime", () => {
  const config = fixture()
  const mixed = { ...config, ai_accounts: [config.ai_accounts[0], { ...config.ai_accounts[1], purpose: "image" as const }] }
  for (const next of [mixed, applyAiActive(mixed, "a", false), applyAiDelete(mixed, "a"), applyAiDefaultModel(mixed, "model-a")]) {
    const request = replaceIntegrationConfigRequest(next)
    assert.deepEqual(request.ai_runtime, config.ai_runtime)
    assert.deepEqual(request.ai_accounts.map((row) => row.purpose), next.ai_accounts.map((row) => row.purpose))
  }
})

test("old and malformed responses remain unknown and cannot produce a replacement", () => {
  const current = fixture()
  const old = { ...current, ai_runtime: undefined, ai_accounts: [{ ...current.ai_accounts[0], purpose: undefined }] } as unknown as Config
  const read = integrationOverview(old)
  assert.equal(read.ai_accounts[0]?.purpose, null)
  assert.equal(read.ai_runtime, null)
  assert.throws(() => replaceIntegrationConfigRequest(old), /运行配置未确认/)
  const missingPurpose = { ...old, ai_runtime: current.ai_runtime }
  assert.throws(() => replaceIntegrationConfigRequest(missingPurpose), /账号用途未确认/)
  const invalidRuntime = { ...current, ai_runtime: { ...current.ai_runtime, allow_public_egress: undefined } } as unknown as Config
  assert.equal(integrationOverview(invalidRuntime).ai_runtime, null)
  assert.throws(() => replaceIntegrationConfigRequest(invalidRuntime), /运行配置未确认/)
})

test("incomplete snapshots stop all AI writes before any PUT", async () => {
  const savedFetch = globalThis.fetch
  const config = fixture()
  let response: unknown = { ...config, ai_runtime: undefined }
  const calls: string[] = []
  globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    calls.push(init?.method ?? "GET")
    return new Response(JSON.stringify({ data: response }), { headers: { "Content-Type": "application/json" } })
  }) as typeof fetch
  try {
    const operations = [
      () => aiAccountsHttp.upsert({ ...draft, id: "a" }),
      () => aiAccountsHttp.setActive("a", false),
      () => aiAccountsHttp.delete("a"),
      () => aiAccountsHttp.setDefaultModel("model-a"),
      () => aiAccountsHttp.setRuntime(config.ai_runtime),
    ]
    for (const operation of operations) await assert.rejects(operation(), /运行配置未确认/)
    response = { ...config, ai_accounts: [{ ...config.ai_accounts[0], purpose: undefined }] }
    for (const operation of operations) await assert.rejects(operation(), /账号用途未确认/)
    assert.equal(calls.length, 10)
    assert.ok(calls.every((method) => method === "GET"))
  } finally { globalThis.fetch = savedFetch }
})

test("a new account joins the pool it was added from; an edit never changes the stored purpose", () => {
  const config = fixture()
  const image = applyAiUpsert(config, { ...draft, purpose: "image", model: "qwen-image-2.1-pro" })
  assert.equal(image.config.ai_accounts[2].purpose, "image")
  assert.equal(applyAiUpsert(config, draft).config.ai_accounts[2].purpose, "ocr")
  assert.equal(applyAiUpsert(config, { ...draft, id: "a", apiKey: "", purpose: "image" }).config.ai_accounts[0].purpose, "ocr")
})

test("default model is scoped to enabled Chat Completions OCR accounts", () => {
  const config = fixture()
  const mixed = { ...config, ai_accounts: [{ ...config.ai_accounts[0], purpose: "image" as const }, config.ai_accounts[1]] }
  assert.throws(() => applyAiDefaultModel(mixed, "model-a"), /请先启用/)
  assert.equal(applyAiDefaultModel(mixed, "model-b").ai_default_model, "model-b")
})

test("runtime ceilings are validated like Cloud and replace only ai_runtime", () => {
  const config = fixture()
  const ok = { max_concurrency_global: 0, max_concurrency_user: 100_000, max_concurrency_account: 1, user_rate_per_minute: 0, lease_ttl_seconds: 3600, allow_public_egress: false }
  const next = applyAiRuntime(config, ok)
  assert.deepEqual(next.ai_runtime, ok)
  assert.strictEqual(next.ai_accounts, config.ai_accounts)
  assert.equal(next.ai_default_model, config.ai_default_model)
  assert.equal(applyAiRuntime(config, { ...ok, lease_ttl_seconds: 1 }).ai_runtime.lease_ttl_seconds, 1)
  for (const key of ["max_concurrency_global", "max_concurrency_user", "max_concurrency_account", "user_rate_per_minute"] as const) {
    for (const value of [-1, 100_001, 1.5, Number.NaN]) assert.throws(() => applyAiRuntime(config, { ...ok, [key]: value }), /0 到 100000/, `${key}=${value}`)
  }
  for (const value of [0, 3601, 2.5, Number.NaN]) assert.throws(() => applyAiRuntime(config, { ...ok, lease_ttl_seconds: value }), /1 到 3600/, `lease=${value}`)
})

test("new accounts require secrets and stop at 64; existing rows remain editable at capacity", () => {
  const config = fixture()
  assert.throws(() => applyAiUpsert(config, { ...draft, apiKey: "" }))
  const full = { ...config, ai_accounts: Array.from({ length: 64 }, (_, index) => ({ ...config.ai_accounts[0], id: String(index) })) }
  assert.throws(() => applyAiUpsert(full, draft), /64/)
  assert.equal(applyAiUpsert(full, { ...draft, id: "0", apiKey: "" }).config.ai_accounts.length, 64)
  const created = applyAiUpsert(config, draft)
  assert.equal(created.config.ai_accounts.length, 3)
  assert.equal(created.config.ai_accounts[2].active, true)
  assert.deepEqual(created.credential, [created.config.ai_accounts[2].id, "new-secret"])
})

test("account validation rejects invalid endpoints, model ids and fractional priorities", () => {
  for (const base_url of ["abc", "ftp://example.test", "https://secret@example.test/v1", "https://example.test/v1?key=x"]) {
    assert.throws(() => applyAiUpsert(fixture(), { ...draft, base_url: base_url }))
  }
  for (const model of ["", "with space", "x".repeat(129)]) assert.throws(() => applyAiUpsert(fixture(), { ...draft, model }))
  assert.throws(() => applyAiUpsert(fixture(), { ...draft, priority: 1.5 }))
})

test("HTTP upsert sends CAS and one secret; a conflict is returned without silent retries", async () => {
  const savedFetch = globalThis.fetch
  const calls: { method: string; body?: Record<string, unknown> }[] = []
  let conflict = false
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    assert.equal(String(input), route("adminIntegrationsConfig"))
    const method = init?.method ?? "GET"
    const body = init?.body ? JSON.parse(String(init.body)) : undefined
    calls.push({ method, body })
    return new Response(JSON.stringify(conflict && method === "PUT" ? { error: "version conflict", code: "CONFLICT" } : { data: fixture() }), { status: conflict && method === "PUT" ? 409 : 200, headers: { "Content-Type": "application/json" } })
  }) as typeof fetch
  try {
    const overview = await aiAccountsHttp.upsert({ ...draft, id: "a" })
    assert.deepEqual(calls.map((row) => row.method), ["GET", "PUT"])
    assert.deepEqual(calls[1].body, {
      expected_revision: 12,
      ai_default_model: "model-a",
      ai_accounts: fixture().ai_accounts.map((row, index) => ({ ...row, api_key: index === 0 ? "new-secret" : "" })),
      ai_runtime: fixture().ai_runtime,
    })
    assert.equal(overview.ai_accounts[0]?.thinking, false)
    assert.equal(overview.ai_accounts[0]?.base_url, draft.base_url)
    const runtime = { ...fixture().ai_runtime, max_concurrency_global: 9, allow_public_egress: false }
    await aiAccountsHttp.setRuntime(runtime)
    assert.deepEqual(calls[3].body, { ...(calls[1].body as object), ai_accounts: fixture().ai_accounts.map((row) => ({ ...row, api_key: "" })), ai_runtime: runtime })
    assert.equal(overview.ai_runtime?.lease_ttl_seconds, 120)
    conflict = true
    await assert.rejects(aiAccountsHttp.setRuntime(runtime))
    await assert.rejects(aiAccountsHttp.setActive("a", false))
    assert.deepEqual(calls.map((row) => row.method), ["GET", "PUT", "GET", "PUT", "GET", "PUT", "GET", "PUT"])
    await assert.rejects(aiAccountsHttp.setRuntime({ ...runtime, lease_ttl_seconds: 0 }))
    assert.equal(calls.length, 9)
  } finally { globalThis.fetch = savedFetch }
})

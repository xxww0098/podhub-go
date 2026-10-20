import assert from "node:assert/strict"
import test from "node:test"
import type { components } from "@/api/schema"
import { applyAiUpsert, applyAiActive, applyAiDelete, applyAiDefaultModel, type AiAccountDraft } from "./integration-ai-writes"
import { replaceIntegrationConfigRequest } from "./integration-writes"
import { aiAccountsHttp } from "./http-ai-accounts"

type Config = components["schemas"]["IntegrationConfigData"]
const draft: AiAccountDraft = {
  id: null, label: "Primary", base_url: "https://example.test/v1", api_format: "chat_completions",
  model: "model-a", active: true, thinking: false, thinking_format: "none", priority: 20, apiKey: "new-secret",
}
function fixture() {
  const { apiKey: _key, ...row } = draft
  return {
    schema_version: 1, revision: 12, cache_ttl_seconds: 300, ai_default_model: "model-a", storage_buckets: [],
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
  const rotated = applyAiUpsert(config, { ...draft, id: "a", apiKey: " replacement " })
  assert.deepEqual(replaceIntegrationConfigRequest(rotated.config, rotated.credential).ai_accounts.map((row) => row.api_key), ["replacement", ""])
  assert.throws(() => applyAiUpsert(config, { ...draft, id: "stale-id" }))
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
  for (const baseUrl of ["abc", "ftp://example.test", "https://secret@example.test/v1", "https://example.test/v1?key=x"]) {
    assert.throws(() => applyAiUpsert(fixture(), { ...draft, base_url: baseUrl }))
  }
  for (const model of ["", "with space", "x".repeat(129)]) assert.throws(() => applyAiUpsert(fixture(), { ...draft, model }))
  assert.throws(() => applyAiUpsert(fixture(), { ...draft, priority: 1.5 }))
})

test("HTTP upsert sends CAS and one secret; a conflict is returned without silent retries", async () => {
  const savedFetch = globalThis.fetch
  const calls: { method: string; body?: Record<string, unknown> }[] = []
  let conflict = false
  globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    const method = init?.method ?? "GET"
    const body = init?.body ? JSON.parse(String(init.body)) : undefined
    calls.push({ method, body })
    return new Response(JSON.stringify(conflict && method === "PUT" ? { error: "version conflict", code: "CONFLICT" } : { data: fixture() }), { status: conflict && method === "PUT" ? 409 : 200, headers: { "Content-Type": "application/json" } })
  }) as typeof fetch
  try {
    await aiAccountsHttp.upsert({ ...draft, id: "a" })
    assert.deepEqual(calls.map((row) => row.method), ["GET", "PUT"])
    assert.equal(calls[1].body?.expected_revision, 12)
    const accounts = calls[1].body?.ai_accounts as { api_key: string }[]
    assert.deepEqual(accounts.map((row) => row.api_key), ["new-secret", ""])
    conflict = true
    await assert.rejects(aiAccountsHttp.setActive("a", false))
    assert.deepEqual(calls.map((row) => row.method), ["GET", "PUT", "GET", "PUT"])
  } finally { globalThis.fetch = savedFetch }
})

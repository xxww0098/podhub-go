/**
 * The decisions the integrations thunks make between two Cloud calls.
 *
 * Cloud publishes a Store roster and an integration-config snapshot, and every
 * write is "read the snapshot, change one row, put it back with the revision I
 * read". Which row, and which changes Cloud must refuse before it spends a
 * round trip, is what lives here. The browser holds no Secret, so the roster's
 * own `credentialConfigured` / `credentialRevision` are the "configured" fact
 * and the active-Store pointer is a per-browser preference.
 */
import type { components } from "@/api/schema"

import { refuse } from "./refusal"

type IntegrationConfig = components["schemas"]["AdminIntegrationConfigView"]
type WorkspaceStoreRoster = components["schemas"]["WorkspaceStoreRosterData"]
type ReplaceRequest = components["schemas"]["AdminIntegrationConfigWriteRequest"]

export function isAiRuntime(value: unknown): value is components["schemas"]["AdminIntegrationAiRuntime"] {
  if (!value || typeof value !== "object") return false
  const runtime = value as Record<string, unknown>
  const counts = [runtime.max_concurrency_global, runtime.max_concurrency_user, runtime.max_concurrency_account, runtime.user_rate_per_minute]
  return counts.every((count) => typeof count === "number" && Number.isInteger(count) && count >= 0 && count <= 100_000)
    && typeof runtime.lease_ttl_seconds === "number" && Number.isInteger(runtime.lease_ttl_seconds)
    && runtime.lease_ttl_seconds >= 1 && runtime.lease_ttl_seconds <= 3600
    && typeof runtime.allow_public_egress === "boolean"
}

export function requireAiConfigComplete(config: IntegrationConfig): void {
  if (!isAiRuntime(config.ai_runtime)) throw refuse("integration_ai_invalid", "AI 运行配置未确认，请更新服务并刷新后重试")
  if (!Array.isArray(config.ai_accounts) || config.ai_accounts.some((row) => row.purpose !== "ocr" && row.purpose !== "image")) {
    throw refuse("integration_ai_invalid", "账号用途未确认，请更新服务并刷新后重试")
  }
}

// --- Ozon Store upsert ------------------------------------------------------

/**
 * Which Cloud Store a "保存到平台云端配置" click means.
 *
 * `live` is the row the operator opened. `adopt` is a row the roster already
 * carries under the typed Client ID — the same Seller identity cannot become a
 * second Store. Anything else mints one.
 */
export type OzonStoreUpsertKind =
  | { kind: "live", uuid: string }
  | { kind: "adopt", uuid: string }
  | { kind: "promote" }

export function ozonStoreUpsertKind(
  id: string,
  clientId: string,
  roster: WorkspaceStoreRoster,
): OzonStoreUpsertKind {
  if (roster.stores.some((store) => store.uuid === id)) return { kind: "live", uuid: id }
  if (clientId.length > 0) {
    const adopted = roster.stores.find((store) => store.client_id === clientId)
    if (adopted) return { kind: "adopt", uuid: adopted.uuid }
  }
  return { kind: "promote" }
}

export function requireRosterStore(
  roster: WorkspaceStoreRoster,
  uuid: string,
): components["schemas"]["WorkspaceStoreView"] {
  const store = roster.stores.find((row) => row.uuid === uuid)
  if (!store) {
    throw refuse("workspace_store_not_found", "Cloud 名册已变化，请刷新店铺列表后重试")
  }
  return store
}

export function renameOzonStoreRequest(name: string, revision: number): {
  name: string
  revision: number
} {
  const trimmed = name.trim()
  if (!trimmed) throw refuse("workspace_store_invalid", "店铺名称不能为空")
  return { name: trimmed, revision }
}

/**
 * Client ID and API Key are one Seller identity: Cloud changes them together
 * through the credential route, so a new Client ID without a key is refused
 * rather than half-written. A Store Cloud holds no key for is refused too —
 * there is nothing to keep.
 */
export function requireCredentialForIdentity(options: {
  identityChanged: boolean
  apiKey: string
  credentialConfigured: boolean
}): void {
  if (options.apiKey.length > 0) return
  if (options.identityChanged) {
    throw refuse(
      "workspace_store_identity_requires_api_key",
      "修改 Client ID 时必须同时输入 Seller API Key",
    )
  }
  if (!options.credentialConfigured) {
    throw refuse("workspace_store_cloud_credential_missing", "Cloud 尚未登记 Seller API Key，请重新输入")
  }
}

// --- Active Store preference ------------------------------------------------

/**
 * Which Store this browser last picked, per Workspace. A convenience, never truth:
 * Cloud decides what a Store may execute, and a pick that is no longer in the
 * roster simply does not paint (the pointer is reconciled against the roster
 * on every read).
 */
const ACTIVE_STORE_KEY = "podhub:active-store"

function activeStoreMap(): Record<string, string> {
  try {
    const raw = globalThis.localStorage?.getItem(ACTIVE_STORE_KEY)
    const parsed: unknown = raw ? JSON.parse(raw) : null
    return typeof parsed === "object" && parsed !== null
      ? (parsed as Record<string, string>)
      : {}
  } catch {
    return {}
  }
}

export function readActiveStore(workspaceUuid: string): string | null {
  return activeStoreMap()[workspaceUuid] ?? null
}

/**
 * Rebuild the staff write rows from the read views, attaching key material to
 * exactly the account being edited. Every other row travels with an empty
 * secret, which Cloud reads as "keep the stored one". Every write carries the
 * snapshot's own `purpose` per row and its `ai_runtime`, so no write can
 * reset either to a default.
 */
export function replaceIntegrationConfigRequest(
  config: IntegrationConfig,
  aiCredential?: [string, string],
): ReplaceRequest {
  requireAiConfigComplete(config)
  return {
    expected_revision: config.revision,
    ai_default_model: config.ai_default_model,
    ai_accounts: config.ai_accounts.map((view) => ({
      id: view.id,
      label: view.label,
      base_url: view.base_url,
      api_format: view.api_format,
      model: view.model,
      api_key: aiCredential && aiCredential[0] === view.id ? aiCredential[1] : "",
      active: view.active,
      thinking: view.thinking,
      thinking_format: view.thinking_format,
      priority: view.priority,
      purpose: view.purpose,
    })),
    ai_runtime: config.ai_runtime,
  }
}

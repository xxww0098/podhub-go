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

type IntegrationConfig = components["schemas"]["IntegrationConfigData"]
type MediaAccount = components["schemas"]["IntegrationMediaAccountView"]
type WorkspaceStoreRoster = components["schemas"]["WorkspaceStoreRosterData"]
type ReplaceRequest = components["schemas"]["ReplaceIntegrationConfigRequest"]

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

export function writeActiveStore(workspaceUuid: string, storeId: string): void {
  try {
    const next = { ...activeStoreMap(), [workspaceUuid]: storeId }
    globalThis.localStorage?.setItem(ACTIVE_STORE_KEY, JSON.stringify(next))
  } catch {
    // A browser that refuses storage still gets a working screen; the pick
    // just does not survive the reload.
  }
}

// --- Media accounts ---------------------------------------------------------

export type UpsertMediaAccount = {
  role: components["schemas"]["IntegrationMediaRole"]
  label: string
  provider: components["schemas"]["IntegrationMediaProvider"]
  endpoint: string
  region: string
  bucket: string
  key_prefix: string
  public_base_url: string
  force_path_style: boolean
  access_key_id: string
  secret_access_key: string
  session_token: string
}

export type MediaCredential = [string, string, string, string]

export function applyMediaUpsert(
  config: IntegrationConfig,
  request: UpsertMediaAccount,
): { config: IntegrationConfig, credential?: MediaCredential } {
  const accessKeyId = request.access_key_id.trim()
  const secretAccessKey = request.secret_access_key.trim()
  const replaceCredentials = accessKeyId.length > 0 || secretAccessKey.length > 0
  const role = request.role
  const existing = config.storage_buckets.find((item) => item.role === role)
  if (!existing && !replaceCredentials) {
    throw refuse("integration_media_invalid", "首次配置必须填写 Access Key / Secret Key")
  }
  const view: MediaAccount = {
    id: existing?.id ?? `s3_${role}`,
    label: request.label.trim(),
    role,
    provider: request.provider,
    endpoint: request.endpoint.trim(),
    region: request.region.trim(),
    bucket: request.bucket.trim(),
    key_prefix: request.key_prefix.trim(),
    public_base_url: request.public_base_url.trim(),
    force_path_style: request.force_path_style,
    active: true,
  }
  const storage_buckets = existing
    ? config.storage_buckets.map((item) => (item.role === role ? view : item))
    : [...config.storage_buckets, view]
  return {
    config: { ...config, storage_buckets },
    credential: replaceCredentials
      ? [view.id, accessKeyId, secretAccessKey, request.session_token.trim()]
      : undefined,
  }
}

/** One account per role: a role is present or it is not. */
export function applyMediaDelete(config: IntegrationConfig, role: IntegrationConfig["storage_buckets"][number]["role"]): IntegrationConfig {
  if (!config.storage_buckets.some((row) => row.role === role)) {
    throw refuse("integration_media_invalid", "存储桶未配置")
  }
  return {
    ...config,
    storage_buckets: config.storage_buckets.filter((row) => row.role !== role),
  }
}

/**
 * Rebuild the staff write rows from the read views, attaching key material to
 * exactly the account being edited. Every other row travels with an empty
 * secret, which Cloud reads as "keep the stored one".
 *
 * `supplierDbStorage` / `delegateAssetsStorage` ride every write: the snapshot
 * replace treats an absent section as "not configured", so leaving one off
 * would silently wipe that bucket on any unrelated save.
 */
export function replaceIntegrationConfigRequest(
  config: IntegrationConfig,
  aiCredential?: [string, string],
  mediaCredential?: MediaCredential,
): ReplaceRequest {
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
    })),
    storage_buckets: config.storage_buckets.map((view) => {
      const own = mediaCredential && mediaCredential[0] === view.id ? mediaCredential : undefined
      return {
        id: view.id,
        label: view.label,
        role: view.role,
        provider: view.provider,
        endpoint: view.endpoint,
        region: view.region,
        bucket: view.bucket,
        key_prefix: view.key_prefix,
        public_base_url: view.public_base_url,
        force_path_style: view.force_path_style,
        access_key_id: own?.[1] ?? "",
        secret_access_key: own?.[2] ?? "",
        session_token: own?.[3] ?? "",
        active: view.active,
      }
    }),
  }
}

/**
 * The 1×1 PNG Cloud identifies a connection test by
 * (`src/media/object_key.rs` `HEALTHCHECK_PNG`). A divergent copy would be billed
 * and collected as if it were seller media, so these are exactly those bytes.
 */
export const HEALTHCHECK_PNG = Uint8Array.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
  0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4,
  0x89, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x44, 0x41, 0x54, 0x08, 0xd7, 0x63, 0xf8, 0xcf, 0xc0, 0xf0,
  0x1f, 0x00, 0x05, 0x00, 0x01, 0xff, 0x89, 0x99, 0x3d, 0x1d, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45,
  0x4e, 0x44, 0xae, 0x42, 0x60, 0x82,
])

/** Lowercase SHA-256 of the health-check PNG — the digest Cloud keys the probe on. */
export async function healthcheckDigest(): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", HEALTHCHECK_PNG)
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("")
}

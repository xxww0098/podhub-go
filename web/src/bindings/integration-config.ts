import { api } from "@/api/client"
import { route } from "@/api/routes"
import type { components } from "@/api/schema"
import type { IntegrationCredentialsOverview } from "./commands"
import { replaceIntegrationConfigRequest, type MediaCredential } from "./integration-writes"
type IntegrationConfigData = components["schemas"]["IntegrationConfigData"]

/**
 * The console's read model of the platform integrations. Key material never
 * appears: Cloud stores an account only with a key, so a row that is in the
 * snapshot is a configured row.
 */
export function integrationOverview(
  config: IntegrationConfigData,
): IntegrationCredentialsOverview {
  const ai_accounts = config.ai_accounts.map((row) => ({
    id: row.id,
    label: row.label,
    ref_id: row.id,
    configured: true,
    active: row.active,
    base_url: row.base_url,
    api_format: row.api_format,
    model: row.model,
    thinking: row.thinking ?? "provider_default",
    thinking_format: row.thinking_format ?? "none",
    priority: row.priority ?? 0,
  }));
  const media_accounts = config.storage_buckets.map((row) => ({
    id: row.id,
    label: row.label,
    role: row.role,
    provider: row.provider ?? "cloudflare",
    ref_id: row.id,
    configured: true,
    active: row.active,
    endpoint: row.endpoint,
    region: row.region,
    bucket: row.bucket,
    key_prefix: row.key_prefix,
    public_base_url: row.public_base_url,
    force_path_style: row.force_path_style,
  }));
  return {
    ai_default_model: config.ai_default_model,
    ai_accounts,
    media_accounts,
  };
}

/** Read-modify-write on the shared snapshot; `expected_revision` is the CAS. */
export async function writeIntegrationConfig(
  config: IntegrationConfigData,
  aiCredential?: [string, string],
  mediaCredential?: MediaCredential,
): Promise<IntegrationCredentialsOverview> {
  return integrationOverview(
    await api.put<IntegrationConfigData>(
      route("adminIntegrationsConfig"),
      replaceIntegrationConfigRequest(config, aiCredential, mediaCredential),
    ),
  );
}


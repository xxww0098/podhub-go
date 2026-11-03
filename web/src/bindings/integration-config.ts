import { api } from "@/api/client"
import { route } from "@/api/routes"
import type { components } from "@/api/schema"
import type { IntegrationCredentialsOverview } from "./commands"
import { isAiRuntime, replaceIntegrationConfigRequest } from "./integration-writes"
import { refuse } from "./refusal"
type IntegrationConfigData = components["schemas"]["AdminIntegrationConfigView"]

/**
 * The console's read model of the platform integrations. Key material never
 * appears: Cloud stores an account only with a key, so a row that is in the
 * snapshot is a configured row.
 */
export function integrationOverview(
  config: IntegrationConfigData,
): IntegrationCredentialsOverview {
  if (!Array.isArray(config.ai_accounts)) throw refuse("integration_ai_invalid", "AI 账号列表未确认，请更新服务并刷新后重试")
  const ai_accounts = config.ai_accounts.map((row) => ({
    id: row.id,
    label: row.label,
    ref_id: row.id,
    configured: true,
    active: row.active,
    base_url: row.base_url,
    api_format: row.api_format,
    model: row.model,
    thinking: row.thinking === "disabled" ? false as const : row.thinking,
    thinking_format: row.thinking_format,
    priority: row.priority ?? 0,
    purpose: row.purpose === "ocr" || row.purpose === "image" ? row.purpose : null,
  }));
  return {
    ai_default_model: config.ai_default_model,
    ai_accounts,
    ai_runtime: isAiRuntime(config.ai_runtime) ? config.ai_runtime : null,
  };
}

/** Read-modify-write on the shared snapshot; `expected_revision` is the CAS. */
export async function writeIntegrationConfig(
  config: IntegrationConfigData,
  aiCredential?: [string, string],
): Promise<IntegrationCredentialsOverview> {
  return integrationOverview(
    await api.put<IntegrationConfigData>(
      route("adminIntegrationsConfig"),
      replaceIntegrationConfigRequest(config, aiCredential),
    ),
  );
}


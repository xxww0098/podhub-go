import { api } from "@/api/client"
import { route } from "@/api/routes"
import type { components } from "@/api/schema"
import type { AiApiFormat, ListAiModelsRequest } from "./commands"
import { writeIntegrationConfig } from "./integration-config"
import { applyAiUpsert, applyAiActive, applyAiDelete, applyAiDefaultModel, type AiAccountDraft } from "./integration-ai-writes"
import { refuse } from "./refusal"

type Config = components["schemas"]["IntegrationConfigData"]
const snapshot = () => api.get<Config>(route("integrationsConfig"))

export const aiAccountsHttp = {
  upsert: async (draft: AiAccountDraft) => {
    const next = applyAiUpsert(await snapshot(), draft)
    return writeIntegrationConfig(next.config, next.credential)
  },
  setActive: async (id: string, active: boolean) => writeIntegrationConfig(applyAiActive(await snapshot(), id, active)),
  delete: async (id: string) => writeIntegrationConfig(applyAiDelete(await snapshot(), id)),
  setDefaultModel: async (model: string) => writeIntegrationConfig(applyAiDefaultModel(await snapshot(), model)),
  listModels: async (probe: ListAiModelsRequest) =>
    (
      await api.post<components["schemas"]["AiModelsData"]>(
        route("adminIntegrationsAiModels"),
        {
          account_id: probe.id?.trim() || null,
          base_url: probe.base_url?.trim() || null,
          api_key: probe.api_key?.trim() || null,
          api_format: probe.api_format,
        },
      )
    ).models.map((model) => ({ id: model.id, owned_by: model.owned_by })),
  /**
   * Probe one model: the credential authenticates and the model appears in
   * the upstream catalogue. A stored account id reuses its key; a draft key
   * and address test a replacement before it is saved. The probe reads
   * `GET {base}/models`, so it neither sends an OCR request nor spends tokens.
   */
  verifyModel: async (probe: {
    id?: string | null
    model: string
    baseUrl?: string | null
    apiKey?: string | null
    apiFormat?: AiApiFormat | null
  }) => {
    const accountId = probe.id?.trim() ?? ""
    const model = probe.model.trim()
    const apiKey = probe.apiKey?.trim() ?? ""
    if (!model || (!accountId && !apiKey)) {
      throw refuse(
        "integration_ai_probe_invalid",
        "AI 账号或模型未就绪，无法测试",
      )
    }
    const body: components["schemas"]["AiProbeRequest"] = { model }
    if (accountId) body.account_id = accountId
    if (apiKey) body.api_key = apiKey
    const baseUrl = probe.baseUrl?.trim()
    if (baseUrl) body.base_url = baseUrl
    if (probe.apiFormat) body.api_format = probe.apiFormat
    const startedAt = performance.now()
    const result = await api.post<components["schemas"]["AiVerifyData"]>(
      route("adminIntegrationsAiVerify"),
      body,
    )
    return { ...result, latency_ms: Math.round(performance.now() - startedAt) }
  },
}

// Isolated, dev-only fixture. All reads/writes remain local to this page.
import { createRoot } from "react-dom/client"
import type { AiAccountView, IntegrationCredentialsOverview } from "@/bindings/commands"
import { aiAccountsHttp } from "@/bindings/http-ai-accounts"
import { integrationsHttp } from "@/bindings/http-integrations"
import { PlatformAiAccountsScreen } from "@/features/platform/ai-accounts-screen"
import { Toaster } from "@/components/ui/toast"
import "../src/index.css"

const account: AiAccountView = { id: "qwen", ref_id: "qwen", label: "Qwen · 主账号", base_url: "https://dashscope.aliyuncs.com/compatible-mode/v1", model: "qwen3.7-flash", active: true, configured: true, api_format: "chat_completions", thinking: false, thinking_format: "enable_thinking", priority: 10 }
let overview: IntegrationCredentialsOverview = { ai_default_model: account.model, ai_accounts: [account, { ...account, id: "go", label: "OpenCode · 备用账号", model: "glm-5.3-flash", base_url: "https://opencode.ai/zen/go/v1", thinking_format: "reasoning_effort", thinking: "low", priority: 0 }, { ...account, id: "disabled", label: "Qwen · 测试账号", active: false, priority: 0 }], media_accounts: [] }
window.fetch = async () => { throw new Error("Visual fixture forbids network requests") }
integrationsHttp.integrationsGetCredentials = async () => overview
aiAccountsHttp.setActive = async (id, active) => { overview = { ...overview, ai_accounts: overview.ai_accounts.map((row) => row.id === id ? { ...row, active } : row) }; return overview }
aiAccountsHttp.delete = async (id) => { overview = { ...overview, ai_accounts: overview.ai_accounts.filter((row) => row.id !== id) }; return overview }
aiAccountsHttp.listModels = async () => [
  { id: "deepseek-v4", owned_by: "deepseek" },
  { id: "glm-5.3", owned_by: "zhipu" },
  { id: "glm-5.3-flash", owned_by: "zhipu" },
  { id: "qwen3.7-flash", owned_by: "qwen" },
]
aiAccountsHttp.verifyModel = async () => ({ verified: true, model_present: true, latency_ms: 18 })
aiAccountsHttp.upsert = async (draft) => {
  const id = draft.id ?? "new"
  const row: AiAccountView = { id, ref_id: id, label: draft.label, base_url: draft.base_url, model: draft.model, api_format: draft.api_format, thinking: draft.thinking, thinking_format: draft.thinking_format, active: draft.active, configured: true, priority: draft.priority }
  overview = { ...overview, ai_accounts: [...overview.ai_accounts.filter((item) => item.id !== id), row] }
  return overview
}
if (new URLSearchParams(location.search).has("dark")) document.documentElement.classList.add("dark")
createRoot(document.getElementById("fixture")!).render(<main className="mx-auto max-w-5xl p-4 sm:p-6"><PlatformAiAccountsScreen initialOverview={overview} onOpenModels={() => {}} /><Toaster /></main>)

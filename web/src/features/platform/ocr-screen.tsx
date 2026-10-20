import { aiAccountsHttp } from "@/bindings/http-ai-accounts"
import { accountForModel } from "./ai-account-model"
import { Button } from "@/components/ui/button"
import { useEffect, useState } from "react"
import { ScanText } from "lucide-react"

import type {
  AiPriceView,
  IntegrationCredentialsOverview,
} from "@/bindings/commands"
import { adminHttp } from "@/bindings/http-admin"
import { integrationsHttp } from "@/bindings/http-integrations"
import { PlatformAdminSurface } from "@/components/platform-admin-surface"
import { StateChip } from "@/components/state-chip"
import { Spinner } from "@/components/ui/spinner"
import { AiAllowlist } from "@/features/platform/ai-prices"
import { notifyCommandError, notifySuccess } from "@/lib/notify"

/**
 * SuperAdmin-only OCR settings screen.
 * Displays current recognition model, status, and published model retail prices.
 */
export function PlatformOcrScreen({
  initialOverview,
  onOpenAccounts,
}: {
  initialOverview?: IntegrationCredentialsOverview
  onOpenAccounts?: () => void
} = {}) {
  const [overview, setOverview] = useState<IntegrationCredentialsOverview | undefined>(
    initialOverview,
  )
  const [prices, setPrices] = useState<AiPriceView[]>()
  const [reload, setReload] = useState(0)
  const [failed, setFailed] = useState(false)
  const [busy, setBusy] = useState(false)
  const [loading, setLoading] = useState(!initialOverview)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setFailed(false)
    async function load() {
      try {
        const [credResult, priceResult] = await Promise.allSettled([
          initialOverview && reload === 0
            ? Promise.resolve(initialOverview)
            : integrationsHttp.integrationsGetCredentials(),
          adminHttp.adminListAiPrices(),
        ])
        if (cancelled) return
        if (credResult.status === "fulfilled") {
          setOverview(credResult.value)
        } else {
          setFailed(true)
          notifyCommandError(credResult.reason, "无法读取 AI 识图配置。")
        }
        if (priceResult.status === "fulfilled") {
          setPrices(priceResult.value)
        } else {
          setFailed(true)
          notifyCommandError(priceResult.reason, "无法读取模型价格，请重试。")
        }
      } finally {
        if (!cancelled) setLoading(false)
      }
    }
    void load()
    return () => {
      cancelled = true
    }
  }, [initialOverview, reload])

  async function handleSetDefaultModel(model: string) {
    if (busy || !prices?.some((price) => price.model === model) || !accountForModel(overview?.ai_accounts, model)) return
    setBusy(true)
    try {
      const nextOverview = await aiAccountsHttp.setDefaultModel(model)
      setOverview(nextOverview)
      notifySuccess("识图模型已切换", {
        description: `之后的识图使用「${model}」。`,
      })
    } catch (reason) {
      notifyCommandError(reason, "切换识图模型失败，请稍后重试。")
    } finally {
      setBusy(false)
    }
  }

  async function handleDeletePrice(model: string): Promise<boolean> {
    if (busy || model === overview?.ai_default_model) return false
    setBusy(true)
    try {
      setPrices(await adminHttp.adminDeleteAiPrice(model))
      notifySuccess("识图模型已下架", {
        description: `「${model}」已退出可售列表，新的识图请求会被拒绝。`,
      })
      return true
    } catch (reason) {
      notifyCommandError(reason, "下架失败，该模型仍在可售列表中。")
      return false
    } finally {
      setBusy(false)
    }
  }

  const defaultModel = overview?.ai_default_model ?? ""
  const readyAccount = accountForModel(overview?.ai_accounts, defaultModel)
  const defaultUnpublished =
    Boolean(defaultModel) && prices !== undefined && !prices.some((p) => p.model === defaultModel)

  return (
    <div className="flex w-full flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-compact text-muted-foreground">先定价，再选择默认模型。切换仅影响后续识图。</p>
        {onOpenAccounts ? <Button variant="outline" onClick={onOpenAccounts}>管理 AI 账号</Button> : null}
      </div>
      <PlatformAdminSurface
        summary={
          <div className="flex w-full flex-wrap items-center gap-x-4 gap-y-1">
            <span className="flex min-w-0 flex-wrap items-center gap-1.5">
              <ScanText className="size-3.5 text-muted-foreground" aria-hidden />
              当前识图：<strong className="break-all font-mono text-foreground">{defaultModel || "—"}</strong>
            </span>
            {defaultUnpublished ? (
              <StateChip status="unknown" label="未定价，识图会被拒绝" />
            ) : defaultModel && readyAccount && prices !== undefined ? (
              <StateChip status="good" label="已就绪" />
            ) : (
              <StateChip status="idle" label="待配置" />
            )}
            <span className="ml-auto text-meta text-muted-foreground">
              {prices !== undefined ? `${prices.length} 个已定价模型` : "正在读取…"}
            </span>
          </div>
        }
      >
        {loading ? (
          <div className="grid min-h-48 place-items-center">
            <Spinner aria-label="正在读取 OCR 设置" />
          </div>
        ) : failed ? (
          <div className="flex justify-center p-5"><Button variant="outline" onClick={() => setReload((value) => value + 1)}>重试</Button></div>
        ) : (
          <AiAllowlist
            hideModelSummary
            accounts={overview?.ai_accounts ?? []}
            defaultModel={defaultModel}
            prices={prices ?? []}
            busy={busy}
            onPrices={setPrices}
            onDefaultModel={(model) => void handleSetDefaultModel(model)}
            onDeletePrice={handleDeletePrice}
          />
        )}
      </PlatformAdminSurface>
    </div>
  )
}

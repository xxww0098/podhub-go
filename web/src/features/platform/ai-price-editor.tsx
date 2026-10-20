import type { AiAccountView } from "@/bindings/commands"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { Spinner } from "@/components/ui/spinner"
import { Tabs, TabsIndicator, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Save } from "lucide-react"
import { accountForModel } from "./ai-account-model"
import { publishRequestFromBilling, estimateDraftYuan, formatYuan, type AiBillingDraft } from "./ai-price-billing"

export type PriceDraft = {
  model: string
  billing: AiBillingDraft
  existing: boolean
  /** 保存成功后把该模型设为当前识图。 */
  setCurrent: boolean
}

export function PriceEditor({
  draft,
  accounts,
  defaultModel,
  busy,
  onChange,
  onSave,
}: {
  draft: PriceDraft
  accounts: AiAccountView[]
  defaultModel: string
  busy: boolean
  onChange: (draft: PriceDraft) => void
  onSave: () => void
}) {
  const modelKey = draft.model.trim()
  const request = publishRequestFromBilling(modelKey, draft.billing)
  const estimate = estimateDraftYuan(draft.billing)
  const supported = Boolean(accountForModel(accounts, modelKey))

  return (
    <div className="flex min-h-0 flex-col gap-3 overflow-y-auto p-5">
        <div className="grid grid-cols-1 gap-2">
          <FieldLabel htmlFor="ai-price-model">
            模型
          </FieldLabel>
          <div className="flex min-w-0 items-center gap-2">
            <Input id="ai-price-model" value={draft.model} onChange={(event) => onChange({ ...draft, model: event.target.value, setCurrent: false })} placeholder="模型 id" disabled={busy || draft.existing} />
          </div>
        </div>

        <Tabs
          value={draft.billing.mode}
          onValueChange={(next) => {
            if (!next) return
            onChange({
              ...draft,
              billing: { ...draft.billing, mode: next as AiBillingDraft["mode"] },
            })
          }}
        >
          <TabsList variant="line" aria-label="计费模式">
            <TabsIndicator variant="line" />
            <TabsTrigger variant="line" value="token">
              按 token 计费
            </TabsTrigger>
            <TabsTrigger variant="line" value="per_request">
              按次计费
            </TabsTrigger>
          </TabsList>
        </Tabs>

        {draft.billing.mode === "token" ? (
          <>
            <BillingYuanInput
              id="ai-rate-input"
              label="输入"
              unit="元/百万"
              value={draft.billing.rateInput}
              onChange={(rateInput) =>
                onChange({ ...draft, billing: { ...draft.billing, rateInput } })
              }
            />
            <BillingYuanInput
              id="ai-rate-cached"
              label="缓存输入"
              unit="元/百万"
              value={draft.billing.rateCachedInput}
              onChange={(rateCachedInput) =>
                onChange({ ...draft, billing: { ...draft.billing, rateCachedInput } })
              }
            />
            <BillingYuanInput
              id="ai-rate-output"
              label="输出"
              unit="元/百万"
              value={draft.billing.rateOutput}
              onChange={(rateOutput) =>
                onChange({ ...draft, billing: { ...draft.billing, rateOutput } })
              }
            />
            <BillingYuanInput
              id="ai-rate-reasoning"
              label="思考输出"
              unit="元/百万"
              value={draft.billing.rateReasoning}
              onChange={(rateReasoning) =>
                onChange({ ...draft, billing: { ...draft.billing, rateReasoning } })
              }
            />
            <BillingYuanInput
              id="ai-rate-hold"
              label="预占上限"
              unit="元/请求"
              value={draft.billing.holdYuan}
              onChange={(holdYuan) =>
                onChange({ ...draft, billing: { ...draft.billing, holdYuan } })
              }
            />
          </>
        ) : (
          <BillingYuanInput
            id="ai-rate-per-request"
            label="单次价格"
            unit="元/次"
            value={draft.billing.perRequestYuan}
            onChange={(perRequestYuan) =>
              onChange({ ...draft, billing: { ...draft.billing, perRequestYuan } })
            }
          />
        )}
        {supported && modelKey !== defaultModel ? (
          <label className="flex w-fit cursor-pointer items-center gap-2 text-compact text-muted-foreground">
            <Checkbox
              checked={draft.setCurrent}
              onCheckedChange={(checked) =>
                onChange({ ...draft, setCurrent: checked === true })
              }
            />
            发布后设为当前识图
          </label>
        ) : null}
        <p className="flex flex-wrap items-baseline justify-between gap-3 text-meta text-muted-foreground">
          <span>保存后立即按此价格计费。</span>
          {estimate !== undefined ? (
            <span
              className="shrink-0 font-mono tabular-nums"
              title="按典型识图 4 万输入 + 3.5 千输出估算"
            >
              ≈ ¥{formatYuan(estimate)}/次
            </span>
          ) : null}
        </p>
        <Button type="button" className="w-full cursor-pointer" disabled={busy || !request} onClick={onSave}>
          {busy ? <Spinner data-icon="inline-start" /> : <Save data-icon="inline-start" />}
          发布价格
        </Button>
    </div>
  )
}

function BillingYuanInput({
  id,
  label,
  unit,
  value,
  onChange,
}: {
  id: string
  label: string
  unit: string
  value: string
  onChange: (value: string) => void
}) {
  return (
    <label htmlFor={id} className="grid grid-cols-2 items-center gap-2 sm:flex">
      <span className="text-compact text-muted-foreground sm:w-20 sm:shrink-0">{label}</span>
      <Input
        id={id}
        inputMode="decimal"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className="col-span-2 row-start-2 min-w-0 font-mono tabular-nums sm:flex-1"
        placeholder="0"
      />
      <span className="col-start-2 row-start-1 text-right text-meta text-muted-foreground sm:w-24 sm:shrink-0">
        {unit}
      </span>
    </label>
  )
}

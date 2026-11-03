import { useState } from "react"
import { Save } from "lucide-react"
import type { AiRuntime, IntegrationCredentialsOverview } from "@/bindings/commands"
import { aiAccountsHttp } from "@/bindings/http-ai-accounts"
import { aiRuntimeProblem } from "@/bindings/integration-ai-writes"
import { Button } from "@/components/ui/button"
import { FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { Spinner } from "@/components/ui/spinner"
import { Switch } from "@/components/ui/switch"
import { notifyCommandError, notifyError, notifySuccess } from "@/lib/notify"

type NumericField = Exclude<keyof AiRuntime, "allow_public_egress">

const FIELDS: { key: NumericField; label: string; hint: string; max: number; min: number }[] = [
  { key: "max_concurrency_global", label: "全局并发上限", hint: "0 为不限", min: 0, max: 100000 },
  { key: "max_concurrency_user", label: "单用户并发上限", hint: "0 为不限", min: 0, max: 100000 },
  { key: "max_concurrency_account", label: "单账号并发上限", hint: "0 为不限", min: 0, max: 100000 },
  { key: "user_rate_per_minute", label: "单用户每分钟请求数", hint: "0 为不限", min: 0, max: 100000 },
  { key: "lease_ttl_seconds", label: "并发租约时长（秒）", hint: "1 至 3600", min: 1, max: 3600 },
]

const toDraft = (runtime: AiRuntime): Record<NumericField, string> => ({
  max_concurrency_global: String(runtime.max_concurrency_global),
  max_concurrency_user: String(runtime.max_concurrency_user),
  max_concurrency_account: String(runtime.max_concurrency_account),
  user_rate_per_minute: String(runtime.user_rate_per_minute),
  lease_ttl_seconds: String(runtime.lease_ttl_seconds),
})

/** An empty or non-numeric field is NaN, which the shared range check refuses. */
const fromDraft = (draft: Record<NumericField, string>, allowPublic: boolean): AiRuntime => {
  const parse = (value: string) => (value.trim() === "" ? Number.NaN : Number(value))
  return {
    max_concurrency_global: parse(draft.max_concurrency_global),
    max_concurrency_user: parse(draft.max_concurrency_user),
    max_concurrency_account: parse(draft.max_concurrency_account),
    user_rate_per_minute: parse(draft.user_rate_per_minute),
    lease_ttl_seconds: parse(draft.lease_ttl_seconds),
    allow_public_egress: allowPublic,
  }
}

/**
 * The platform-wide AI ceilings and the public-endpoint switch, stored with
 * the accounts in one snapshot. The form starts from the stored values; Save
 * writes them back through the same revision check as every account write, so
 * a concurrent edit is refused rather than overwritten. The parent keys this
 * form on the stored runtime, so a saved or reloaded value remounts it.
 */
export function AiRuntimeForm({ runtime, busy, onBusy, onOverview }: {
  runtime: AiRuntime
  busy: boolean
  onBusy: (busy: boolean) => void
  onOverview: (overview: IntegrationCredentialsOverview) => void
}) {
  const [draft, setDraft] = useState(() => toDraft(runtime))
  const [allowPublic, setAllowPublic] = useState(runtime.allow_public_egress)
  const [submitted, setSubmitted] = useState(false)
  const next = fromDraft(draft, allowPublic)
  const problem = aiRuntimeProblem(next)
  const dirty = JSON.stringify(next) !== JSON.stringify(runtime)

  async function save() {
    if (busy) return
    setSubmitted(true)
    if (problem) {
      notifyError(problem)
      return
    }
    onBusy(true)
    try {
      onOverview(await aiAccountsHttp.setRuntime(next))
      notifySuccess("运行限制已保存")
    } catch (reason) {
      notifyCommandError(reason, "运行限制保存失败，请刷新后重试。")
    } finally {
      onBusy(false)
    }
  }

  return (
    <form
      aria-label="AI 运行限制"
      noValidate
      aria-busy={busy}
      className="flex flex-col gap-4 rounded-xl border border-border bg-card p-4"
      onSubmit={(event) => { event.preventDefault(); void save() }}
    >
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {FIELDS.map((field) => {
          const value = next[field.key]
          const invalid = submitted && (!Number.isInteger(value) || value < field.min || value > field.max)
          return (
            <div key={field.key} className="flex flex-col gap-2">
              <FieldLabel htmlFor={`ai-runtime-${field.key}`}>{field.label}</FieldLabel>
              <Input
                id={`ai-runtime-${field.key}`}
                type="number"
                inputMode="numeric"
                step={1}
                min={field.min}
                max={field.max}
                value={draft[field.key]}
                disabled={busy}
                aria-invalid={invalid}
                aria-describedby={`ai-runtime-${field.key}-hint`}
                onChange={(event) => setDraft((current) => ({ ...current, [field.key]: event.target.value }))}
              />
              <p id={`ai-runtime-${field.key}-hint`} className="text-meta text-muted-foreground">{field.hint}</p>
            </div>
          )
        })}
      </div>
      <div className="flex items-center justify-between gap-3 rounded-xl border border-border px-3.5 py-3">
        <FieldLabel htmlFor="ai-runtime-allow-public-egress">允许模型列表与连接测试访问公网地址</FieldLabel>
        <Switch id="ai-runtime-allow-public-egress" checked={allowPublic} disabled={busy} onCheckedChange={(checked) => setAllowPublic(checked === true)} />
      </div>
      <div className="flex justify-end">
        <Button type="submit" disabled={busy || !dirty}>
          {busy ? <Spinner aria-hidden /> : <Save data-icon="inline-start" />}保存
        </Button>
      </div>
    </form>
  )
}

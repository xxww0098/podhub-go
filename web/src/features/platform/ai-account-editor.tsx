import { AI_CUSTOM_CHOICE, AI_MODEL_CHOICES, DEFAULT_AI_MODEL_CHOICE, type AiModelChoice } from "@/lib/ai-model-presets"
import { useRef, useState, type FormEvent } from "react"
import type { AiAccountView, AiApiFormat, AiThinking, AiThinkingFormat } from "@/bindings/commands"
import type { AiAccountDraft } from "@/bindings/integration-ai-writes"
import { aiAccountsHttp } from "@/bindings/http-ai-accounts"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { FieldLabel } from "@/components/ui/field"
import { InputGroup, InputGroupAddon, InputGroupButton, InputGroupInput } from "@/components/ui/input-group"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Spinner } from "@/components/ui/spinner"
import { Switch } from "@/components/ui/switch"
import { notifyCommandError, notifyError, notifyInfo, notifySuccess } from "@/lib/notify"
import { ChevronDown, RefreshCw } from "lucide-react"
import {
  accountLabelFollowsChoice,
  connectionProbe,
  endpointIdentity,
  matchModelChoice,
  modelCatalogueProbe,
} from "./ai-account-model"
import { AiConnectionChip, type AiConnectionState } from "./ai-account-status"

const thinkingLabels: Record<Exclude<AiThinking, false>, string> = {
  provider_default: "跟随服务商",
  low: "低",
  medium: "中",
  high: "高",
}
const thinkingValue = (value: AiThinking): string => (value === false ? "off" : value)
const thinkingOf = (value: string): AiThinking => (value === "off" ? false : value as AiThinking)
const thinkingFormatLabels: Record<AiThinkingFormat, string> = {
  none: "不额外传参",
  reasoning_effort: "推理强度",
  enable_thinking: "思考开关",
  thinking_type: "思考类型",
  anthropic_budget: "Anthropic 预算",
  anthropic_adaptive: "Anthropic 自适应",
}
const apiFormatLabels: Record<AiApiFormat, string> = {
  chat_completions: "对话补全，可用于识图",
  anthropic_messages: "Anthropic 消息，不能用于识图",
  responses: "Responses，不能用于识图",
}

function draftFromAccount(account: AiAccountView): AiAccountDraft {
  return {
    id: account.id, label: account.label, base_url: account.base_url, api_format: account.api_format,
    model: account.model, apiKey: "", active: account.active, thinking: account.thinking,
    thinking_format: account.thinking_format, priority: account.priority,
  }
}

function draftFromChoice(choice: AiModelChoice): AiAccountDraft {
  return {
    id: null, label: choice.accountLabel, base_url: choice.baseUrl, api_format: "chat_completions",
    model: choice.model, apiKey: "", active: true, thinking: choice.thinking,
    thinking_format: choice.thinkingFormat, priority: 0,
  }
}

export function AiAccountEditor({ account, busy, onSave, onCancel }: {
  account?: AiAccountView
  busy: boolean
  onSave: (draft: AiAccountDraft) => void | Promise<void>
  onCancel?: () => void
}) {
  const [draft, setDraft] = useState<AiAccountDraft>(() => account ? draftFromAccount(account) : draftFromChoice(DEFAULT_AI_MODEL_CHOICE))
  const [choiceId, setChoiceId] = useState(() => account ? (matchModelChoice(account)?.id ?? AI_CUSTOM_CHOICE) : DEFAULT_AI_MODEL_CHOICE.id)
  const [advancedOpen, setAdvancedOpen] = useState(false)
  const [submitted, setSubmitted] = useState(false)
  const [saving, setSaving] = useState(false)
  const [probing, setProbing] = useState(false)
  const [connection, setConnection] = useState<AiConnectionState>("idle")
  const submitting = useRef(false)
  const locked = busy || saving || probing
  const choice = AI_MODEL_CHOICES.find((item) => item.id === choiceId)
  const connectionChanged = Boolean(account && (
    endpointIdentity(draft.base_url) !== endpointIdentity(account.base_url) ||
    draft.api_format !== account.api_format
  ))
  const keyRequired = !account || connectionChanged
  const keyInvalid = keyRequired && !draft.apiKey.trim() && (submitted || connectionChanged)
  const thinkingFormats = draft.api_format === "chat_completions"
    ? ["none", "reasoning_effort", "enable_thinking", "thinking_type"] as const
    : ["none", "reasoning_effort", "enable_thinking", "thinking_type", "anthropic_budget", "anthropic_adaptive"] as const

  function change(patch: Partial<AiAccountDraft>) {
    const next = { ...draft, ...patch }
    setDraft(next)
    if ("base_url" in patch || "model" in patch || "thinking" in patch || "thinking_format" in patch || "api_format" in patch) {
      setChoiceId(matchModelChoice({
        model: next.model,
        base_url: next.base_url,
        api_format: next.api_format,
        thinking: next.thinking,
        thinking_format: next.thinking_format,
      })?.id ?? AI_CUSTOM_CHOICE)
    }
    if ("base_url" in patch || "model" in patch || "api_format" in patch || "apiKey" in patch) setConnection("idle")
  }

  function selectChoice(id: string | null) {
    if (!id) return
    if (id === AI_CUSTOM_CHOICE) {
      setChoiceId(AI_CUSTOM_CHOICE)
      setAdvancedOpen(true)
      setConnection("idle")
      return
    }
    const next = AI_MODEL_CHOICES.find((item) => item.id === id)
    if (!next) return
    setChoiceId(next.id)
    setConnection("idle")
    setDraft((current) => ({
      ...current,
      label: accountLabelFollowsChoice(current.label) ? next.accountLabel : current.label,
      base_url: next.baseUrl,
      api_format: "chat_completions",
      model: next.model,
      thinking: next.thinking,
      thinking_format: next.thinkingFormat,
    }))
  }

  const [catalogue, setCatalogue] = useState<{ id: string; owned_by: string }[]>()
  const [catalogueKey, setCatalogueKey] = useState<string>()
  const [catalogueLoading, setCatalogueLoading] = useState(false)
  const [catalogueOpen, setCatalogueOpen] = useState(false)
  const [catalogueQuery, setCatalogueQuery] = useState("")
  const currentCatalogueKey = `${draft.api_format}|${endpointIdentity(draft.base_url)}|${draft.apiKey.trim() ? "draft-key" : "stored"}`
  const catalogueStale = catalogueKey !== currentCatalogueKey
  const catalogueProbe = () => modelCatalogueProbe({
    account, baseUrl: draft.base_url, apiKey: draft.apiKey, apiFormat: draft.api_format,
  })

  async function loadCatalogue() {
    if (catalogueLoading) return
    const probe = catalogueProbe()
    if (probe.status === "blocked") {
      notifyError(probe.reason)
      return
    }
    setCatalogueLoading(true)
    try {
      const models = await aiAccountsHttp.listModels(probe.request)
      setCatalogue(models)
      setCatalogueKey(currentCatalogueKey)
      if (models.length === 0) notifyInfo("上游未返回模型目录。可以手动填写模型标识。")
    } catch (reason) {
      notifyCommandError(reason, "模型列表拉取失败，请检查服务地址与密钥。")
    } finally {
      setCatalogueLoading(false)
    }
  }

  function openCatalogue(open: boolean) {
    if (!open) {
      setCatalogueOpen(false)
      return
    }
    setCatalogueQuery("")
    if (catalogueStale) {
      const probe = catalogueProbe()
      if (probe.status === "blocked") {
        notifyError(probe.reason)
        return
      }
      setCatalogueOpen(true)
      void loadCatalogue()
    } else {
      setCatalogueOpen(true)
    }
  }

  const catalogueNeedle = catalogueQuery.trim().toLocaleLowerCase()
  const catalogueRows = catalogue?.filter((row) => row.id.toLocaleLowerCase().includes(catalogueNeedle)) ?? []

  async function testConnection() {
    if (locked) return
    const probe = connectionProbe({
      accountId: account?.id,
      stored: account,
      baseUrl: draft.base_url,
      apiKey: draft.apiKey,
      apiFormat: draft.api_format,
      model: draft.model,
    })
    if (probe.status === "blocked") {
      notifyError(probe.reason)
      if (probe.reason.includes("服务地址")) setAdvancedOpen(true)
      return
    }
    setProbing(true)
    try {
      const result = await aiAccountsHttp.verifyModel(probe.request)
      setConnection(result.model_present ? "ok" : "missing")
      if (result.model_present) {
        notifySuccess("连接正常", { description: `密钥有效，目录中有该模型。${result.latency_ms} ms。未发起识图。` })
      } else {
        notifyInfo("密钥有效，但目录未列出该模型", { description: "部分服务不公开目录，识图仍可能可用。" })
      }
    } catch (reason) {
      setConnection("failed")
      notifyCommandError(reason, "连接测试失败，请检查密钥、服务地址和网络。")
    } finally {
      setProbing(false)
    }
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (locked || submitting.current) return
    setSubmitted(true)
    const form = event.currentTarget
    const missingKey = keyRequired && !draft.apiKey.trim()
    const invalid = form.querySelector<HTMLInputElement>("input:invalid")
    if (missingKey || invalid || !draft.label.trim() || !draft.model.trim()) {
      const target = missingKey ? form.querySelector<HTMLInputElement>("#ai-key")
        : invalid ?? form.querySelector<HTMLInputElement>(!draft.label.trim() ? "#ai-label" : "#ai-model")
      if (target?.closest("details")) setAdvancedOpen(true)
      requestAnimationFrame(() => target?.focus())
      notifyError(missingKey ? "请填写密钥。更换服务地址或接口格式后需要重新填写。" : "请检查必填项。")
      return
    }
    submitting.current = true
    setSaving(true)
    try {
      await onSave(draft)
    } catch (reason) {
      notifyCommandError(reason, "账号保存失败，请重试。")
    } finally {
      submitting.current = false
      setSaving(false)
    }
  }

  const choiceItems = [
    ...AI_MODEL_CHOICES.map((item) => ({ value: item.id, label: item.label })),
    { value: AI_CUSTOM_CHOICE, label: "自定义" },
  ]

  return (
    <form className="flex min-h-0 flex-col" noValidate aria-busy={locked} onSubmit={(event) => void submit(event)}>
      <div className="flex min-h-0 flex-col gap-4 overflow-y-auto p-5">
        <div className="flex flex-col gap-2">
          <FieldLabel htmlFor="ai-choice">模型</FieldLabel>
          <Select items={choiceItems} value={choiceId} onValueChange={selectChoice} disabled={locked}>
            <SelectTrigger id="ai-choice" aria-describedby="ai-choice-help"><SelectValue /></SelectTrigger>
            <SelectContent>
              {AI_MODEL_CHOICES.map((item) => <SelectItem key={item.id} value={item.id}>{item.label}</SelectItem>)}
              <SelectItem value={AI_CUSTOM_CHOICE}>自定义</SelectItem>
            </SelectContent>
          </Select>
          <p id="ai-choice-help" className="text-meta text-muted-foreground">
            {choice ? choice.summary : "自定义请在高级设置中填写服务地址和模型标识。"}
          </p>
        </div>
        <div className="flex flex-col gap-2">
          <FieldLabel htmlFor="ai-key">密钥{keyRequired ? "（必填）" : ""}</FieldLabel>
          <Input id="ai-key" type="password" autoComplete="new-password" value={draft.apiKey}
            onChange={(event) => change({ apiKey: event.target.value })}
            placeholder={account && !connectionChanged ? "留空则保留已保存的密钥" : "粘贴服务商密钥"}
            required={keyRequired} aria-invalid={keyInvalid} aria-describedby="ai-key-help" disabled={locked} />
          <p id="ai-key-help" className="text-meta text-muted-foreground">
            {connectionChanged ? "服务地址或接口格式已改变，需要重新填写密钥。" : "密钥不会回显。编辑时留空表示保留已保存的密钥。"}
          </p>
        </div>
        <div className="flex items-center justify-between gap-3">
          <FieldLabel htmlFor="ai-active">启用</FieldLabel>
          <Switch id="ai-active" checked={draft.active} disabled={locked} onCheckedChange={(active) => change({ active: active === true })} />
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button type="button" variant="outline" disabled={locked} onClick={() => void testConnection()}>
            {probing ? <Spinner aria-hidden /> : null}测试连接
          </Button>
          <AiConnectionChip state={connection} />
        </div>

        <details open={advancedOpen} onToggle={(event) => setAdvancedOpen(event.currentTarget.open)} className="border-y border-border">
          <summary className="cursor-pointer py-3 text-compact font-medium focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring">
            高级设置<span className="mt-1 block text-meta font-normal text-muted-foreground sm:ml-2 sm:mt-0 sm:inline">名称、服务地址、思考与优先级</span>
          </summary>
          <div className="flex flex-col gap-4 pb-4">
            <div className="flex flex-col gap-2">
              <FieldLabel htmlFor="ai-label">账号名称</FieldLabel>
              <Input id="ai-label" value={draft.label} onChange={(event) => change({ label: event.target.value })}
                placeholder="例如：识图主账号" required disabled={locked} aria-invalid={submitted && !draft.label.trim()} />
            </div>
            <div className="flex flex-col gap-2">
              <FieldLabel htmlFor="ai-url">服务地址</FieldLabel>
              <Input id="ai-url" type="url" value={draft.base_url} onChange={(event) => change({ base_url: event.target.value })}
                placeholder="https://api.example.com/v1" maxLength={512} required disabled={locked}
                aria-invalid={submitted && !URL.canParse(draft.base_url)} />
            </div>
            <div className="flex flex-col gap-2">
              <FieldLabel htmlFor="ai-model">模型标识</FieldLabel>
              <InputGroup>
                <InputGroupInput id="ai-model" value={draft.model} onChange={(event) => change({ model: event.target.value })}
                  maxLength={128} pattern="\S+" required disabled={locked} aria-invalid={submitted && (!draft.model.trim() || /\s/.test(draft.model))} />
                <InputGroupAddon align="inline-end">
                  <Popover open={catalogueOpen} onOpenChange={openCatalogue}>
                    <PopoverTrigger render={<InputGroupButton size="icon-xs" aria-label="从服务目录拉取并选择模型" disabled={locked || catalogueLoading} />}>
                      {catalogueLoading ? <Spinner aria-hidden /> : <ChevronDown aria-hidden />}
                    </PopoverTrigger>
                    <PopoverContent align="end" className="flex w-80 flex-col gap-2 p-2">
                      <Input type="search" aria-label="筛选模型" placeholder="筛选模型标识" value={catalogueQuery}
                        onChange={(event) => setCatalogueQuery(event.target.value)} disabled={catalogueLoading || !catalogue} />
                      <ul aria-label="上游模型目录" className="flex max-h-64 flex-col gap-0.5 overflow-y-auto p-1">
                        {catalogueLoading ? (
                          <li className="flex items-center gap-2 px-2 py-3 text-compact text-muted-foreground"><Spinner aria-hidden />正在拉取模型目录…</li>
                        ) : !catalogue ? (
                          <li className="px-2 py-3 text-compact text-muted-foreground">目录尚未拉取。</li>
                        ) : catalogue.length === 0 ? (
                          <li className="px-2 py-3 text-compact text-muted-foreground">上游目录为空，可手动填写模型标识。</li>
                        ) : catalogueRows.length === 0 ? (
                          <li className="px-2 py-3 text-compact text-muted-foreground">没有匹配的模型。</li>
                        ) : catalogueRows.map((row) => (
                          <li key={row.id}>
                            <Button type="button" variant="ghost" aria-label={`选择模型 ${row.id}`} className="flex w-full cursor-pointer justify-between gap-2 font-normal"
                              onClick={() => { change({ model: row.id }); setCatalogueOpen(false) }}>
                              <span className="min-w-0 break-all font-mono">{row.id}</span>
                              {row.owned_by ? <span className="shrink-0 text-meta text-muted-foreground">{row.owned_by}</span> : null}
                            </Button>
                          </li>
                        ))}
                      </ul>
                      <div className="flex items-center justify-between gap-2 px-1 text-meta text-muted-foreground">
                        <span>{catalogue ? `上游目录 ${catalogueRows.length}/${catalogue.length}` : "只读取模型目录，不消耗额度"}</span>
                        <Button type="button" variant="ghost" size="icon-xs" aria-label="重新拉取模型目录" disabled={catalogueLoading} onClick={() => void loadCatalogue()}>
                          <RefreshCw aria-hidden />
                        </Button>
                      </div>
                    </PopoverContent>
                  </Popover>
                </InputGroupAddon>
              </InputGroup>
            </div>
            {account && account.api_format !== "chat_completions" ? (
              <div className="flex flex-col gap-2">
                <FieldLabel htmlFor="ai-format">接口格式</FieldLabel>
                <Select items={apiFormatLabels} value={draft.api_format} onValueChange={(value) => {
                  if (value === "chat_completions" || value === account.api_format) {
                    change({ api_format: value, thinking: "provider_default", thinking_format: "none" })
                  }
                }} disabled={locked}>
                  <SelectTrigger id="ai-format"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="chat_completions">{apiFormatLabels.chat_completions}</SelectItem>
                    <SelectItem value={account.api_format}>{apiFormatLabels[account.api_format]}</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            ) : <p className="text-meta text-muted-foreground">接口格式：对话补全，可用于识图。</p>}
            {draft.api_format !== "chat_completions" ? (
              <p className="text-compact text-muted-foreground">当前格式不能用于识图。可改为对话补全，并重新填写密钥。</p>
            ) : null}
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <div className="flex flex-col gap-2">
                <FieldLabel htmlFor="ai-thinking">思考</FieldLabel>
                <Select items={{ ...thinkingLabels, off: "关闭" }} value={thinkingValue(draft.thinking)} onValueChange={(value) => { if (value) change({ thinking: thinkingOf(value) }) }} disabled={locked}>
                  <SelectTrigger id="ai-thinking"><SelectValue /></SelectTrigger>
                  <SelectContent>{Object.entries({ ...thinkingLabels, off: "关闭" }).map(([value, label]) => <SelectItem key={value} value={value}>{label}</SelectItem>)}</SelectContent>
                </Select>
              </div>
              <div className="flex flex-col gap-2">
                <FieldLabel htmlFor="ai-thinking-format">思考参数</FieldLabel>
                <Select items={thinkingFormats.map((value) => ({ value, label: thinkingFormatLabels[value] }))} value={draft.thinking_format} onValueChange={(value) => { if (value) change({ thinking_format: value as AiThinkingFormat }) }} disabled={locked}>
                  <SelectTrigger id="ai-thinking-format"><SelectValue /></SelectTrigger>
                  <SelectContent>{thinkingFormats.map((value) => <SelectItem key={value} value={value}>{thinkingFormatLabels[value]}</SelectItem>)}</SelectContent>
                </Select>
              </div>
            </div>
            <div className="flex flex-col gap-2">
              <FieldLabel htmlFor="ai-priority">优先级</FieldLabel>
              <Input id="ai-priority" type="number" step={1} min={-2147483648} max={2147483647}
                value={Number.isNaN(draft.priority) ? "" : draft.priority}
                onChange={(event) => change({ priority: event.target.valueAsNumber })} required disabled={locked}
                aria-invalid={submitted && (!Number.isInteger(draft.priority) || draft.priority < -2147483648 || draft.priority > 2147483647)}
                aria-describedby="ai-priority-help" />
              <p id="ai-priority-help" className="text-meta text-muted-foreground">同一模型按数字从高到低使用，相同数字轮流使用。</p>
            </div>
          </div>
        </details>
      </div>
      <div className="flex shrink-0 flex-wrap justify-end gap-2 border-t border-border px-5 py-4">
        {onCancel ? <Button type="button" variant="outline" disabled={locked} onClick={onCancel}>取消</Button> : null}
        <Button type="submit" disabled={locked}>
          {saving ? <Spinner aria-hidden /> : null}{saving ? "保存中…" : "保存"}
        </Button>
      </div>
    </form>
  )
}

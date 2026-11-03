import { useEffect, useMemo, useState } from "react"
import { ChevronRight, CircleDollarSign, Copy, CreditCard, Eye, EyeOff, Globe, RotateCcw, Save, ShieldCheck, Smartphone, WalletCards, type LucideIcon } from "lucide-react"

import { route } from "@/api/routes"
import type { PaymentConfigData, ReplacePaymentProviderConfig } from "@/bindings/commands"
import { integrationsHttp } from "@/bindings/http-integrations"
import { PlatformAdminSurface } from "@/components/platform-admin-surface"
import { Button } from "@/components/ui/button"
import { IconButton } from "@/components/ui/icon-button"
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { Spinner } from "@/components/ui/spinner"
import { Switch } from "@/components/ui/switch"
import { Textarea } from "@/components/ui/textarea"
import { errorMessage } from "@/lib/error-message"
import { clearLive, notifyCommandError, notifyLive, notifySuccess } from "@/lib/notify"
import { cn } from "@/lib/utils"

const PAYMENT_CONFIG_LIVE = "payment-config-load"

const BILLING_CALLBACK = route("billingCallback")
const BILLING_CALLBACK_COMPLETE = route("billingCallbackComplete")
const providerWebhook = (provider: string) =>
  route("billingWebhooksByProvider", { provider })

type FieldSpec = {
  key: string
  label: string
  placeholder?: string
  description?: string
  secret?: boolean
  multiline?: boolean
  /**
   * Path on the console's own origin. Empty drafts prefill with the absolute
   * URL so a notify/return address never has to be typed by hand — the same
   * auto-fill the Sub2API provider form applies from the site domain.
   */
  defaultPath?: string
}

type ProviderSpec = {
  key: string
  label: string
  icon: LucideIcon
  iconClassName: string
  description: string
  /** Provider-facing notify endpoint on this deployment, shown for copy. */
  webhook: { path: string; method: string }
  fields: FieldSpec[]
}

const PROVIDERS: ProviderSpec[] = [
  {
    key: "alipay",
    label: "支付宝",
    icon: WalletCards,
    iconClassName: "bg-[#1677ff] text-white",
    description: "支付宝开放平台当面付，桌面端展示付款码。",
    webhook: { path: BILLING_CALLBACK, method: "POST" },
    fields: [
      { key: "appId", label: "AppID" },
      { key: "gateway", label: "API 地址", description: "生产环境使用支付宝官方网关；联调可使用官方沙箱。" },
      { key: "privateKey", label: "应用私钥", secret: true, multiline: true },
      { key: "alipayPublicKey", label: "支付宝公钥", secret: true, multiline: true },
      { key: "notifyUrl", label: "回调地址", defaultPath: BILLING_CALLBACK },
    ],
  },
  {
    key: "wechat",
    label: "微信支付",
    icon: Smartphone,
    iconClassName: "bg-[#07a940] text-white",
    description: "微信支付 API v3 Native 模式，桌面端展示扫码付款。",
    webhook: { path: providerWebhook("wechat"), method: "POST" },
    fields: [
      { key: "appId", label: "AppID" },
      { key: "mchId", label: "商户号 MchID" },
      { key: "privateKey", label: "商户 API 私钥", secret: true, multiline: true },
      { key: "apiV3Key", label: "APIv3 Key", secret: true },
      { key: "certSerial", label: "商户证书序列号" },
      { key: "publicKey", label: "微信支付公钥", secret: true, multiline: true },
      { key: "publicKeyId", label: "微信支付公钥 ID" },
      { key: "notifyUrl", label: "回调地址", defaultPath: providerWebhook("wechat") },
    ],
  },
  {
    key: "easypay",
    label: "易支付",
    icon: CircleDollarSign,
    iconClassName: "bg-brand text-brand-foreground",
    description: "聚合支付宝与微信支付，兼容易支付协议。",
    webhook: { path: providerWebhook("easypay"), method: "GET 或 POST" },
    fields: [
      { key: "pid", label: "商户 PID" },
      { key: "pkey", label: "商户密钥", secret: true },
      { key: "apiBase", label: "API 地址", placeholder: "https://pay.example.com/" },
      { key: "notifyUrl", label: "回调地址", defaultPath: providerWebhook("easypay") },
      { key: "returnUrl", label: "支付返回地址", defaultPath: BILLING_CALLBACK_COMPLETE },
      { key: "cidAlipay", label: "支付宝通道 ID（可选）" },
      { key: "cidWxpay", label: "微信通道 ID（可选）" },
    ],
  },
  {
    key: "stripe",
    label: "Stripe",
    icon: CreditCard,
    iconClassName: "bg-[#635bff] text-white",
    description: "Stripe Checkout 托管收银台，支持银行卡及账户已开通的本地方式。",
    webhook: { path: providerWebhook("stripe"), method: "POST" },
    fields: [
      { key: "secretKey", label: "Secret Key", secret: true },
      { key: "publishableKey", label: "Publishable Key" },
      { key: "webhookSecret", label: "Webhook Secret", secret: true },
      { key: "currency", label: "币种", placeholder: "cny" },
      { key: "returnUrl", label: "支付返回地址", defaultPath: BILLING_CALLBACK_COMPLETE },
    ],
  },
  {
    key: "airwallex",
    label: "Airwallex",
    icon: Globe,
    iconClassName: "bg-[#285078] text-white",
    description: "Airwallex 一次性 Payment Link 托管收银台。",
    webhook: { path: providerWebhook("airwallex"), method: "POST" },
    fields: [
      { key: "clientId", label: "Client ID" },
      { key: "apiKey", label: "API Key", secret: true },
      { key: "webhookSecret", label: "Webhook Secret", secret: true },
      { key: "apiBase", label: "API 地址", description: "生产与沙箱密钥必须匹配对应的官方 API 地址。" },
      { key: "currency", label: "币种", placeholder: "CNY" },
      { key: "countryCode", label: "国家/地区", placeholder: "CN" },
      { key: "accountId", label: "Account ID（可选）" },
    ],
  },
]

/** Same-origin SPA: the console's own origin is where callbacks must reach. */
function siteOrigin(): string {
  return typeof window === "undefined" ? "" : window.location.origin
}

function toDraft(config: PaymentConfigData, origin: string): ReplacePaymentProviderConfig[] {
  return PROVIDERS.map((spec) => {
    const saved = config.providers.find((provider) => provider.provider === spec.key)
    return {
      provider: spec.key,
      enabled: saved?.enabled ?? false,
      values: Object.fromEntries(
        spec.fields.map((field) => [
          field.key,
          saved?.values[field.key] ||
            (field.defaultPath ? `${origin}${field.defaultPath}` : ""),
        ]),
      ),
    }
  })
}

/** SuperAdmin-only 平台管理 → 支付 pane. */
export function PlatformPaymentScreen() {
  return (
    <>
      <PlatformAdminSurface bodyClassName="border-t-0">
        <PaymentConfigPanel />
      </PlatformAdminSurface>
    </>
  )
}

export function PaymentConfigPanel({ initialConfig }: { initialConfig?: PaymentConfigData } = {}) {
  const [config, setConfig] = useState(initialConfig)
  const [draft, setDraft] = useState<ReplacePaymentProviderConfig[]>(() =>
    initialConfig ? toDraft(initialConfig, siteOrigin()) : [],
  )
  const [active, setActive] = useState("alipay")
  const [busy, setBusy] = useState(false)
  const [loadError, setLoadError] = useState(false)
  const origin = siteOrigin()

  async function load() {
    setLoadError(false)
    clearLive(PAYMENT_CONFIG_LIVE)
    try {
      const next = await integrationsHttp.integrationsGetPaymentConfig()
      setConfig(next)
      setDraft(toDraft(next, origin))
    } catch (reason) {
      setLoadError(true)
      notifyLive({
        id: PAYMENT_CONFIG_LIVE,
        type: "error",
        reason,
        title: errorMessage(reason, "无法读取支付配置，请稍后重试。"),
        action: { label: "重试", onClick: () => void load() },
      })
    }
  }

  useEffect(() => {
    if (initialConfig) return
    void load()
    return () => clearLive(PAYMENT_CONFIG_LIVE)
  }, [initialConfig])

  const spec = useMemo(() => PROVIDERS.find((provider) => provider.key === active) ?? PROVIDERS[0], [active])
  const current = draft.find((provider) => provider.provider === spec.key)
  const saved = config?.providers.find((provider) => provider.provider === spec.key)

  if (!config || !current) {
    return loadError ? (
      <div role="alert" className="flex flex-wrap items-center justify-center gap-3 rounded-xl border border-border bg-card p-6">
        <span className="text-sm text-muted-foreground">无法读取支付配置。</span>
        <Button type="button" variant="outline" onClick={() => void load()}><RotateCcw data-icon="inline-start" />重试</Button>
      </div>
    ) : <p role="status" className="flex items-center justify-center gap-2 rounded-xl border border-border bg-card p-6 text-compact text-muted-foreground"><Spinner className="size-3.5" />正在读取支付配置…</p>
  }

  const webhookUrl = `${origin}${spec.webhook.path}`
  const complete = config.providers.length === PROVIDERS.length && PROVIDERS.every(
    (provider) => config.providers.filter((row) => row.provider === provider.key).length === 1,
  )

  function update(provider: ReplacePaymentProviderConfig) {
    setDraft((rows) => rows.map((row) => row.provider === provider.provider ? provider : row))
  }

  async function copyWebhook() {
    try {
      await navigator.clipboard.writeText(webhookUrl)
      notifySuccess("通知地址已复制", { description: webhookUrl })
    } catch {
      notifyCommandError(undefined, "复制失败，请手动选择地址。")
    }
  }

  async function save() {
    setBusy(true)
    try {
      const next = await integrationsHttp.integrationsReplacePaymentConfig({ expectedRevision: config!.revision, providers: draft })
      setConfig(next)
      setDraft(toDraft(next, origin))
      notifySuccess("支付配置已保存", { description: `已启用 ${next.providers.filter((provider) => provider.enabled).length} 个支付服务商。` })
    } catch (reason) {
      notifyCommandError(reason, "无法保存支付配置，请检查字段后重试。")
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="grid min-w-0 overflow-hidden rounded-xl border border-border bg-card md:grid-cols-[20rem_minmax(0,1fr)]">
        <div className="border-b border-border p-3 md:border-r md:border-b-0" aria-label="支付服务商">
          <p className="rounded-lg bg-muted/40 px-4 py-4 text-lg font-semibold">支付服务商</p>
          <div className="mt-2 grid gap-2 min-[450px]:grid-cols-2 md:grid-cols-1">
            {PROVIDERS.map((provider) => {
              const state = config.providers.find((row) => row.provider === provider.key)
              const Icon = provider.icon
              return (
                <button key={provider.key} type="button" aria-pressed={active === provider.key} onClick={() => setActive(provider.key)} className={cn("flex min-w-0 cursor-pointer items-center gap-3 rounded-lg border border-border px-4 py-3 text-left transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring", active === provider.key ? "border-brand/30 border-l-4 border-l-brand bg-brand-soft text-brand-ink" : "bg-card hover:bg-muted/40")}>
                  <span className={cn("flex size-12 shrink-0 items-center justify-center rounded-lg", provider.iconClassName)}><Icon className="size-6" aria-hidden /></span>
                  <span className="flex min-w-0 flex-1 flex-col items-start gap-1"><span className="max-w-full truncate text-md font-semibold">{provider.label}</span><ProviderStatus provider={state} /></span>
                  <ChevronRight className="size-4 shrink-0 text-brand" aria-hidden />
                </button>
              )
            })}
          </div>
        </div>

        <section aria-label={`${spec.label}配置`} className="min-w-0 p-4 sm:p-6">
          <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-3">
            <div className="flex min-w-0 flex-1 basis-56 items-center gap-4">
              <span className={cn("flex size-13 shrink-0 items-center justify-center rounded-lg", spec.iconClassName)}><spec.icon className="size-7" aria-hidden /></span>
              <div className="min-w-0"><h3 className="text-xl font-semibold">{spec.label}</h3><ProviderStatus provider={saved} /><p className="mt-1 text-sm text-muted-foreground">{spec.description}</p></div>
            </div>
            <Field orientation="horizontal" className="w-auto items-center"><FieldLabel htmlFor={`payment-enabled-${spec.key}`}>启用</FieldLabel><Switch id={`payment-enabled-${spec.key}`} checked={current.enabled} disabled={busy} onCheckedChange={(enabled) => update({ ...current, enabled })} /></Field>
          </div>
          <div className="mt-6 overflow-hidden rounded-lg border border-border">
            <h4 className="bg-muted/40 px-4 py-3 text-lg font-semibold">基础配置</h4>
            <div className="flex flex-col gap-6 p-4">
            {spec.fields.map((field) => field.secret ? (
              <SecretField key={`${spec.key}-${field.key}`} id={`payment-${spec.key}-${field.key}`} field={field} value={current.values[field.key] ?? ""} configured={saved?.secretFieldsConfigured.includes(field.key) ?? false} disabled={busy} onChange={(value) => update({ ...current, values: { ...current.values, [field.key]: value } })} />
            ) : (
              <Field key={field.key}>
                <FieldLabel htmlFor={`payment-${spec.key}-${field.key}`}><span className="text-md">{field.label}</span></FieldLabel>
                <Input id={`payment-${spec.key}-${field.key}`} autoComplete="off" value={current.values[field.key] ?? ""} disabled={busy} placeholder={field.placeholder ?? `请输入${field.label}`} onChange={(event) => update({ ...current, values: { ...current.values, [field.key]: event.target.value } })} />
                {field.description ? <FieldDescription>{field.description}</FieldDescription> : null}
              </Field>
            ))}
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg bg-muted/40 px-3 py-2">
                <span className="shrink-0 text-xs text-muted-foreground">通知地址 · {spec.webhook.method}</span>
                <code className="min-w-0 flex-1 basis-48 break-all font-mono text-xs text-foreground">{webhookUrl}</code>
                <IconButton icon={Copy} label={`复制${spec.label}通知地址`} size="icon-sm" onClick={() => void copyWebhook()} />
              </div>
              <div className="flex flex-wrap items-center gap-4 border-t border-border pt-4">
                <Button type="button" variant="brand" disabled={busy || !complete} onClick={() => void save()}>{busy ? <Spinner data-icon="inline-start" /> : <Save data-icon="inline-start" />}保存全部支付配置</Button>
                <p className="flex min-w-0 flex-1 basis-56 items-start gap-2 text-xs text-muted-foreground"><ShieldCheck className="size-4 shrink-0" aria-hidden />未结清订单保留原商户身份；可修复同商户密钥与回调配置。</p>
              </div>
              {!complete ? <p role="alert" className="text-sm text-destructive">部分支付渠道未读取，无法保存。请保留已输入内容后刷新页面重试。</p> : null}
            </div>
          </div>
        </section>
    </div>
  )
}

function ProviderStatus({ provider }: { provider?: PaymentConfigData["providers"][number] }) {
  const label = !provider ? "未知" : provider.enabled ? "已启用" : provider.configured ? "已停用" : "未配置"
  return <span className="inline-flex items-center gap-2 text-sm text-muted-foreground"><span aria-hidden className={cn("size-2 rounded-full", !provider ? "bg-muted-foreground" : provider.enabled ? "bg-st-good" : provider.configured ? "bg-st-idle" : "bg-st-bad")} />{label}</span>
}

function SecretField({ id, field, value, configured, disabled, onChange }: { id: string; field: FieldSpec; value: string; configured: boolean; disabled: boolean; onChange: (value: string) => void }) {
  const [visible, setVisible] = useState(false)
  useEffect(() => { setVisible(false) }, [id])
  useEffect(() => { if (!value) setVisible(false) }, [value])
  const control = field.multiline ? (
    <Textarea id={id} rows={2} spellCheck={false} autoComplete="new-password" className={cn("resize-y", !visible && "[-webkit-text-security:disc]")} value={value} disabled={disabled} onChange={(event) => onChange(event.target.value)} placeholder={configured ? "已安全保存；留空保持不变" : `粘贴${field.label}`} />
  ) : (
    <Input id={id} type={visible ? "text" : "password"} autoComplete="new-password" value={value} disabled={disabled} onChange={(event) => onChange(event.target.value)} placeholder={configured ? "已安全保存；留空保持不变" : `输入${field.label}`} />
  )
  return (
    <Field>
      <FieldLabel htmlFor={id}><span className="text-md">{field.label}</span></FieldLabel>
      <div className="flex items-start gap-2">{control}<IconButton icon={visible ? EyeOff : Eye} label={visible ? `隐藏${field.label}` : `显示${field.label}`} size="icon-sm" className="shrink-0" disabled={disabled || !value} aria-pressed={visible} onClick={() => setVisible((current) => !current)} /><Button type="button" variant="outline" size="sm" aria-label={`清空${field.label}输入`} disabled={disabled || !value} onClick={() => onChange("")}>清空</Button></div>
      <FieldDescription>{configured ? "已配置；只有轮换时才重新输入。" : "首次启用前必填。"}</FieldDescription>
    </Field>
  )
}

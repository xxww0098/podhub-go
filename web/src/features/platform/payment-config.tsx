import { useEffect, useMemo, useState } from "react"
import { Copy, Eye, EyeOff, Save, ShieldCheck } from "lucide-react"

import { route } from "@/api/routes"
import type { PaymentConfigData, ReplacePaymentProviderConfig } from "@/bindings/commands"
import { integrationsHttp } from "@/bindings/http-integrations"
import { PlatformAdminSurface } from "@/components/platform-admin-surface"
import { StateChip } from "@/components/state-chip"
import { Button } from "@/components/ui/button"
import { Field, FieldDescription, FieldGroup, FieldLabel } from "@/components/ui/field"
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
  description: string
  /** Provider-facing notify endpoint on this deployment, shown for copy. */
  webhook: { path: string; method: string }
  fields: FieldSpec[]
}

const PROVIDERS: ProviderSpec[] = [
  {
    key: "easypay",
    label: "EasyPay",
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
    key: "alipay",
    label: "支付宝",
    description: "支付宝开放平台当面付，桌面端展示付款码。",
    webhook: { path: BILLING_CALLBACK, method: "POST" },
    fields: [
      { key: "appId", label: "AppID" },
      { key: "privateKey", label: "应用私钥", secret: true, multiline: true },
      { key: "alipayPublicKey", label: "支付宝公钥", secret: true, multiline: true },
      { key: "notifyUrl", label: "回调地址", defaultPath: BILLING_CALLBACK },
      { key: "gateway", label: "网关地址", description: "生产环境使用支付宝官方网关；联调可使用官方沙箱。" },
    ],
  },
  {
    key: "wechat",
    label: "微信支付",
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
    key: "stripe",
    label: "Stripe",
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
      <PlatformAdminSurface>
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
  const [active, setActive] = useState("easypay")
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
      <div className="flex items-center gap-3 px-5 py-8">
        <Button type="button" variant="outline" size="sm" onClick={() => void load()}>重试</Button>
      </div>
    ) : <p role="status" className="px-5 py-8 text-sm text-muted-foreground"><Spinner className="mr-2 inline size-3.5" />正在读取支付配置…</p>
  }

  const enabledCount = config.providers.filter((provider) => provider.enabled).length
  const configuredCount = config.providers.filter((provider) => provider.configured).length
  const webhookUrl = `${origin}${spec.webhook.path}`

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
    <div className="divide-y divide-border">
      <div className="flex flex-wrap items-center justify-between gap-3 px-5 py-3">
        <p className="text-compact text-muted-foreground">凭证加密保存，留空保留已有密钥。</p>
        <p className="text-compact text-muted-foreground">
          已启用 <span className="font-mono tabular-nums text-foreground">{enabledCount}</span> · 已配置 <span className="font-mono tabular-nums text-foreground">{configuredCount}</span> / {PROVIDERS.length}
        </p>
      </div>

      <div className="grid min-w-0 md:grid-cols-4">
        <div className="border-b border-border p-2 md:border-r md:border-b-0" aria-label="支付服务商">
          {PROVIDERS.map((provider) => {
            const state = config.providers.find((row) => row.provider === provider.key)
            return (
              <button key={provider.key} type="button" aria-pressed={active === provider.key} onClick={() => setActive(provider.key)} className={cn("flex w-full items-center justify-between gap-2 rounded-md px-3 py-2.5 text-left text-compact transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring", active === provider.key ? "bg-brand-soft font-medium text-brand-ink" : "hover:bg-muted")}>
                <span>{provider.label}</span>
                <StateChip status={state?.enabled ? "present" : state?.configured ? "no" : "absent"} label={state?.enabled ? "启用" : state?.configured ? "停用" : "未配"} />
              </button>
            )
          })}
        </div>

        <section aria-label={`${spec.label}配置`} className="min-w-0 md:col-span-3">
          <div className="flex flex-wrap items-start justify-between gap-4 border-b border-border px-5 py-4">
            <div><p className="text-sm font-medium">{spec.label}</p><p className="mt-1 text-sm text-muted-foreground">{spec.description}</p></div>
            <Field orientation="horizontal" className="w-auto items-center"><FieldLabel htmlFor={`payment-enabled-${spec.key}`}>启用</FieldLabel><Switch id={`payment-enabled-${spec.key}`} checked={current.enabled} disabled={busy} onCheckedChange={(enabled) => update({ ...current, enabled })} /></Field>
          </div>
          <div className="flex flex-wrap items-center gap-2 border-b border-border px-5 py-2.5">
            <span className="shrink-0 text-compact text-faint-foreground">通知地址 · {spec.webhook.method}</span>
            <code className="min-w-0 flex-1 truncate font-mono text-xs text-muted-foreground">{webhookUrl}</code>
            <Button type="button" variant="ghost" size="icon-sm" aria-label={`复制${spec.label}通知地址`} onClick={() => void copyWebhook()}>
              <Copy aria-hidden />
            </Button>
          </div>
          <div className="p-5"><FieldGroup className="grid gap-5 xl:grid-cols-2">
            {spec.fields.map((field) => field.secret ? (
              <SecretField key={field.key} id={`payment-${spec.key}-${field.key}`} field={field} value={current.values[field.key] ?? ""} configured={saved?.secretFieldsConfigured.includes(field.key) ?? false} disabled={busy} onChange={(value) => update({ ...current, values: { ...current.values, [field.key]: value } })} />
            ) : (
              <Field key={field.key}>
                <FieldLabel htmlFor={`payment-${spec.key}-${field.key}`}>{field.label}</FieldLabel>
                <Input id={`payment-${spec.key}-${field.key}`} autoComplete="off" value={current.values[field.key] ?? ""} disabled={busy} placeholder={field.placeholder} onChange={(event) => update({ ...current, values: { ...current.values, [field.key]: event.target.value } })} />
                {field.description ? <FieldDescription>{field.description}</FieldDescription> : null}
              </Field>
            ))}
          </FieldGroup></div>
        </section>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3 px-5 py-4">
        <p className="flex min-w-0 items-start gap-2 text-meta text-muted-foreground"><ShieldCheck className="size-4 shrink-0" aria-hidden />未结清订单保留原商户身份；可修复同商户密钥与回调配置。</p>
        <Button type="button" disabled={busy} onClick={() => void save()}>{busy ? <Spinner data-icon="inline-start" /> : <Save data-icon="inline-start" />}保存全部支付配置</Button>
      </div>
    </div>
  )
}

function SecretField({ id, field, value, configured, disabled, onChange }: { id: string; field: FieldSpec; value: string; configured: boolean; disabled: boolean; onChange: (value: string) => void }) {
  const [visible, setVisible] = useState(false)
  useEffect(() => { setVisible(false) }, [id])
  useEffect(() => { if (!value) setVisible(false) }, [value])
  const control = field.multiline ? (
    <Textarea id={id} rows={4} spellCheck={false} autoComplete="new-password" className={cn("min-h-24 resize-y font-mono", !visible && "[-webkit-text-security:disc]")} value={value} disabled={disabled} onChange={(event) => onChange(event.target.value)} placeholder={configured ? "已安全保存；留空保持不变" : `粘贴${field.label}`} />
  ) : (
    <Input id={id} type={visible ? "text" : "password"} autoComplete="new-password" className="font-mono" value={value} disabled={disabled} onChange={(event) => onChange(event.target.value)} placeholder={configured ? "已安全保存；留空保持不变" : `输入${field.label}`} />
  )
  return (
    <Field className={field.multiline ? "xl:col-span-2" : undefined}>
      <FieldLabel htmlFor={id}>{field.label}</FieldLabel>
      <div className="flex items-start gap-2">{control}<Button type="button" variant="ghost" size="icon-sm" className="shrink-0" disabled={disabled || !value} aria-label={visible ? `隐藏${field.label}` : `显示${field.label}`} aria-pressed={visible} onClick={() => setVisible((current) => !current)}>{visible ? <EyeOff aria-hidden /> : <Eye aria-hidden />}</Button></div>
      <FieldDescription>{configured ? "已配置；只有轮换时才重新输入。" : "首次启用前必填。"}</FieldDescription>
    </Field>
  )
}

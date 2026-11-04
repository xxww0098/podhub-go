import { useState } from "react"
import { Cloud } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Spinner } from "@/components/ui/spinner"
import { R2BucketFields, r2BucketNameValid, type R2BucketValues } from "@/components/r2-bucket-fields"
import type { SliceStorageInput } from "./workspace-storage-api"

const cloudflareLinks = {
  login: "https://dash.cloudflare.com/login",
  register: "https://dash.cloudflare.com/sign-up",
  r2: "https://dash.cloudflare.com/?to=/:account/r2/overview",
  tokens: "https://developers.cloudflare.com/r2/api/tokens/",
  cors: "https://developers.cloudflare.com/r2/buckets/cors/",
  pricing: "https://developers.cloudflare.com/r2/pricing/",
  payment: "https://developers.cloudflare.com/billing/understand/billing-policy/",
}

const linkClass = "text-brand-ink underline underline-offset-4"

function ExternalLink({ href, children }: { href: string; children: string }) {
  return <a href={href} target="_blank" rel="noreferrer" className={linkClass}>{children}<span className="sr-only">（在新窗口打开）</span></a>
}

const emptyForm: R2BucketValues = { endpoint: "", bucket: "", public_base_url: "", access_key_id: "", secret_access_key: "" }

export function WorkspaceStorageSetup({ busy, create }: {
  busy: boolean
  create: (input: SliceStorageInput) => void
}) {
  const [form, setForm] = useState<R2BucketValues>(emptyForm)
  const [consent, setConsent] = useState(false)
  const invalidName = form.bucket !== "" && !r2BucketNameValid(form.bucket)
  const complete = form.endpoint.trim() !== "" && form.bucket.trim() !== "" && form.public_base_url.trim() !== "" && form.access_key_id.trim() !== "" && form.secret_access_key !== ""
  const update = (key: keyof R2BucketValues, value: string) => setForm((previous) => ({ ...previous, [key]: value }))
  return <div className="flex flex-col gap-6 py-2">
    <div className="flex items-center gap-3"><Cloud aria-hidden className="size-6 text-muted-foreground" /><div><p className="font-semibold">此工作空间尚未配置存储桶</p><p className="mt-1 text-sm text-muted-foreground">一个空间一个桶，成员共用，由所有者填写 R2 配置。</p></div></div>
    <form className="flex flex-col gap-5 rounded-xl border border-border bg-card p-4 sm:p-5" onSubmit={(event) => { event.preventDefault(); if (complete && consent && !invalidName) create({ ...form, endpoint: form.endpoint.trim(), bucket: form.bucket.trim(), public_base_url: form.public_base_url.trim(), access_key_id: form.access_key_id.trim() }) }}>
      <p className="max-w-prose text-sm leading-relaxed text-muted-foreground">在 Cloudflare 创建存储桶并开启公开访问，再创建仅限该桶的 R2 API 令牌。保存前会实际写入、读取、列举并删除测试对象。</p>
      <R2BucketFields idPrefix="workspace-r2" value={form} onChange={update} disabled={busy} />
      <label htmlFor="workspace-r2-public-consent" className="flex max-w-prose items-start gap-3 text-sm font-normal leading-relaxed"><Checkbox id="workspace-r2-public-consent" checked={consent} onCheckedChange={(value) => setConsent(value === true)} disabled={busy} className="mt-1 shrink-0" /><span>确认切片图片可通过该公开地址读取，且存储桶允许本站来源的 GET、PUT 请求及所需请求头。</span></label>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2"><Button type="submit" variant="brand" className="w-fit" disabled={busy || !complete || !consent || invalidName}>{busy ? <Spinner aria-hidden /> : <Cloud aria-hidden />}{busy ? "正在验证并保存" : "验证并保存配置"}</Button><ExternalLink href={cloudflareLinks.tokens}>创建 R2 API 令牌</ExternalLink><ExternalLink href={cloudflareLinks.cors}>配置 CORS</ExternalLink></div>
    </form>
    <div className="flex flex-col gap-2 text-sm text-muted-foreground">
      <p><ExternalLink href={cloudflareLinks.login}>登录 Cloudflare</ExternalLink> · <ExternalLink href={cloudflareLinks.register}>注册账号</ExternalLink> · <ExternalLink href={cloudflareLinks.r2}>开通 R2</ExternalLink></p>
      <p className="max-w-prose leading-relaxed">R2 开通需要有效付款方式（信用卡、PayPal 等），标准存储每月含 10 GB-month 免费额度，同一 Cloudflare 账户的桶共享额度。 <ExternalLink href={cloudflareLinks.pricing}>免费额度与价格</ExternalLink> · <ExternalLink href={cloudflareLinks.payment}>支持的付款方式</ExternalLink></p>
    </div>
  </div>
}

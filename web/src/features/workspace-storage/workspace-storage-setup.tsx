import type { ReactNode } from "react"
import { Cloud, ExternalLink } from "lucide-react"
import { Button, buttonVariants } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Label } from "@/components/ui/label"
import { Input } from "@/components/ui/input"
import { Spinner } from "@/components/ui/spinner"
import type { WorkspaceStorage } from "./workspace-storage-api"

export const cloudflareLinks = {
  login: "https://dash.cloudflare.com/login",
  register: "https://dash.cloudflare.com/sign-up",
  r2: "https://dash.cloudflare.com/?to=/:account/r2/overview",
  pricing: "https://developers.cloudflare.com/r2/pricing/",
  payment: "https://developers.cloudflare.com/billing/understand/billing-policy/",
}

function Link({ href, children }: { href: string; children: ReactNode }) {
  return <a href={href} target="_blank" rel="noreferrer" className={`${buttonVariants({ variant: "outline", size: "sm" })} w-fit`}>{children}<ExternalLink aria-hidden className="size-3.5" /><span className="sr-only">（在新窗口打开）</span></a>
}

type ConnectionProps = {
  storage: WorkspaceStorage
  busy: boolean
  authorize: () => void
  disconnect: () => void
  reconnect: () => void
}

export function CloudflareConnection({ storage, busy, authorize, disconnect, reconnect }: ConnectionProps) {
  return <div className="flex flex-col gap-2">
    {storage.cloudflare_connected ? <>
      <div className="flex flex-wrap items-center gap-2"><span className="mr-2 text-sm font-medium">Cloudflare 设置授权已连接</span><Button type="button" variant="outline" size="sm" disabled={busy} onClick={disconnect}>退出授权</Button><Button type="button" variant="outline" size="sm" disabled={busy} onClick={reconnect}>重新登录并授权</Button></div>
      <p className="text-sm text-muted-foreground">设置授权最多保留 15 分钟；退出授权不会删除存储桶或切片。切换 Cloudflare 登录账号时，请先在 <a href={cloudflareLinks.login} target="_blank" rel="noreferrer" className="text-brand-ink underline underline-offset-4">Cloudflare 控制台<span className="sr-only">（在新窗口打开）</span></a>退出。</p>
    </> : <>
      {storage.configured ? <p className="text-sm text-muted-foreground">Cloudflare 设置授权未连接，现有存储桶配置不受影响。</p> : null}
      {storage.oauth_available ? <><Button type="button" variant="brand" className="w-fit" disabled={busy} onClick={authorize}>{busy ? <Spinner aria-hidden /> : <Cloud aria-hidden />}登录并授权 Cloudflare</Button><p className="text-sm text-muted-foreground">在 Cloudflare 授权页启用「Account API Tokens Write」，用于创建本桶专用凭据。</p></> : <><Link href={cloudflareLinks.login}>登录 Cloudflare</Link><p role="status" className="text-sm text-muted-foreground">平台尚未完成 Cloudflare 应用接入，暂时无法连接或创建存储桶。</p></>}
    </>}
  </div>
}

export function WorkspaceStorageSetup({ storage, accounts, accountsLoaded, account, setAccount, bucketName, setBucketName, consent, setConsent, busy, authorize, disconnect, reconnect, create }: ConnectionProps & {
  accounts: { id: string; name: string }[]
  accountsLoaded: boolean
  account: string
  setAccount: (value: string) => void
  bucketName: string
  setBucketName: (value: string) => void
  consent: boolean
  setConsent: (value: boolean) => void
  create: () => void
}) {
  const name = storage.provision?.bucket ?? bucketName
  const invalidName = name !== "" && !/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(name)
  const accountAvailable = accounts.some((item) => item.id === account)
  return <div className="flex flex-col gap-6 py-2">
    <div className="flex items-center gap-3"><Cloud aria-hidden className="size-6 text-muted-foreground" /><div><p className="font-semibold">此工作空间尚未创建存储桶</p><p className="mt-1 text-sm text-muted-foreground">一个空间一个桶，成员共用，由所有者创建和管理。</p></div></div>
    {!storage.can_manage ? <p role="status" className="text-sm text-muted-foreground">请联系工作空间所有者完成创建。成员无需单独配置 R2。</p> : <div className="flex flex-col gap-5 rounded-xl border border-border bg-card p-4 sm:p-5">
      <div className="flex flex-col gap-3">
        <div><p className="font-medium">连接 Cloudflare</p><p className="mt-1 text-sm text-muted-foreground">已有账号可直接登录并授权。创建存储桶前需开通 R2。</p></div>
        <CloudflareConnection storage={storage} busy={busy} authorize={authorize} disconnect={disconnect} reconnect={reconnect} />
        <div className="flex flex-wrap gap-2"><Link href={cloudflareLinks.register}>注册账号</Link><Link href={cloudflareLinks.r2}>开通 R2</Link></div>
        <p className="max-w-prose text-sm leading-relaxed text-muted-foreground">R2 开通需要有效付款方式，支持信用卡、PayPal 等，具体以结账页为准。标准存储每月含 10 GB-month 免费额度，同一 Cloudflare 账户下的桶共享额度，超出后按量计费。 <a href={cloudflareLinks.pricing} target="_blank" rel="noreferrer" className="text-brand-ink underline underline-offset-4">免费额度与价格</a> · <a href={cloudflareLinks.payment} target="_blank" rel="noreferrer" className="text-brand-ink underline underline-offset-4">支持的付款方式</a></p>
      </div>
      {storage.cloudflare_connected ? <div className="flex flex-col gap-3 border-t border-border pt-5">
        <p className="font-medium">创建工作空间存储桶</p>
        <p className="text-sm text-muted-foreground">权限、公开地址和跨域规则由系统配置，无需填写密钥。</p>
        <div className="grid max-w-md gap-2"><Label htmlFor="workspace-r2-account">Cloudflare 账户</Label><Select value={account || null} onValueChange={(value) => setAccount(value ?? "")} disabled={busy || !!storage.provision || accounts.length === 0}><SelectTrigger id="workspace-r2-account" className="w-full"><SelectValue placeholder="选择已授权的账户">{(value) => accounts.find((item) => item.id === value)?.name ?? value}</SelectValue></SelectTrigger><SelectContent>{accounts.map((item) => <SelectItem key={item.id} value={item.id}>{item.name}</SelectItem>)}</SelectContent></Select></div>
        {accountsLoaded && accounts.length === 0 ? <p role="status" className="text-sm text-muted-foreground">未找到可用的 Cloudflare 账户，请检查授权或重新登录。</p> : null}
        {storage.provision && accounts.length > 0 && !accountAvailable ? <p role="alert" className="text-sm text-destructive">继续创建需要原 Cloudflare 账户，请重新登录并授权该账户。</p> : null}
        <div className="grid max-w-md gap-2"><Label htmlFor="workspace-r2-bucket">存储桶名称（可选）</Label><Input id="workspace-r2-bucket" value={name} onChange={(event) => setBucketName(event.target.value)} placeholder="留空，自动生成 podhub-随机ID" autoComplete="off" autoCapitalize="none" spellCheck={false} minLength={3} maxLength={63} pattern="[a-z0-9](?:[a-z0-9]|-){1,61}[a-z0-9]" disabled={busy || !!storage.provision} aria-invalid={invalidName} aria-describedby={invalidName ? "workspace-r2-bucket-error" : "workspace-r2-bucket-help"} /><p id="workspace-r2-bucket-help" className="text-sm text-muted-foreground">3–63 个字符，仅限小写字母、数字和连字符，首尾须为字母或数字。创建开始后名称固定。</p>{invalidName ? <p id="workspace-r2-bucket-error" role="alert" className="text-sm text-destructive">桶名格式不正确，不可包含中文、大写字母或空格。</p> : null}</div>
        <Label htmlFor="workspace-r2-public" className="flex max-w-prose items-start gap-3 text-sm font-normal leading-relaxed"><Checkbox id="workspace-r2-public" checked={consent} onCheckedChange={(value) => setConsent(value === true)} disabled={busy} className="mt-1 shrink-0" /><span>允许通过公开链接读取此桶中的切片图片，供电商平台取图。系统使用有限速的 r2.dev 开发地址；长期高流量使用需在 Cloudflare 绑定自有域名。</span></Label>
        <Button type="button" variant="brand" className="w-fit" disabled={busy || !accountAvailable || !consent || invalidName || storage.provision?.phase === "blocked" || storage.provision?.phase === "token_creating"} onClick={create}>{busy ? <Spinner aria-hidden /> : <Cloud aria-hidden />}{busy ? "正在创建并验证" : storage.provision ? "继续创建并核对" : "创建工作空间存储桶"}</Button>
      </div> : null}
      {storage.provision ? <p role="status" className="break-all text-sm text-muted-foreground">{storage.provision.bucket} · {storage.provision.phase === "verifying" ? "待完成上传与回读验证" : storage.provision.phase === "creating" ? "创建结果待核对" : storage.provision.phase === "blocked" || storage.provision.phase === "token_creating" ? "需要在 Cloudflare 核对上次操作" : "配置尚未完成"}</p> : null}
    </div>}
  </div>
}

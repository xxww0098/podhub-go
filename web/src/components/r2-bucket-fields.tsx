import { Field, FieldDescription, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"

export type R2BucketValues = {
  endpoint: string
  bucket: string
  public_base_url: string
  access_key_id: string
  secret_access_key: string
}

export function r2BucketNameValid(value: string): boolean {
  return /^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(value)
}

const bucketRule = "3–63 个字符，仅限小写字母、数字和连字符，首尾须为字母或数字。"

// The same five R2 parameters everywhere a bucket is configured. The public
// URL only exists for buckets that serve objects over HTTP.
export function R2BucketFields({ idPrefix, value, onChange, disabled, showPublic = true, configured = false, bucketPlaceholder }: {
  idPrefix: string
  value: R2BucketValues
  onChange: (key: keyof R2BucketValues, value: string) => void
  disabled?: boolean
  showPublic?: boolean
  configured?: boolean
  bucketPlaceholder?: string
}) {
  const invalidName = value.bucket !== "" && !r2BucketNameValid(value.bucket)
  const credentialPlaceholder = configured ? "留空保留已保存的凭据" : undefined
  return <div className="grid min-w-0 gap-4 sm:grid-cols-2">
    <Field className="sm:col-span-2">
      <FieldLabel htmlFor={`${idPrefix}-endpoint`}>R2 端点</FieldLabel>
      <Input id={`${idPrefix}-endpoint`} value={value.endpoint} onChange={(event) => onChange("endpoint", event.target.value)} placeholder="https://<32 位账户 ID>.r2.cloudflarestorage.com" autoComplete="off" autoCapitalize="none" spellCheck={false} required disabled={disabled} />
      <FieldDescription>Cloudflare 账户详情中的 S3 API 地址，必须使用 HTTPS。</FieldDescription>
    </Field>
    <Field className={showPublic ? undefined : "sm:col-span-2"}>
      <FieldLabel htmlFor={`${idPrefix}-bucket`}>存储桶名称</FieldLabel>
      <Input id={`${idPrefix}-bucket`} value={value.bucket} onChange={(event) => onChange("bucket", event.target.value)} placeholder={bucketPlaceholder} autoComplete="off" autoCapitalize="none" spellCheck={false} minLength={3} maxLength={63} pattern="[a-z0-9](?:[a-z0-9]|-){1,61}[a-z0-9]" required disabled={disabled} aria-invalid={invalidName} aria-describedby={invalidName ? `${idPrefix}-bucket-error` : `${idPrefix}-bucket-help`} />
      {invalidName ? <p id={`${idPrefix}-bucket-error`} role="alert" className="text-sm text-destructive">桶名格式不正确，不可包含中文、大写字母或空格。</p> : <FieldDescription id={`${idPrefix}-bucket-help`}>{bucketRule}</FieldDescription>}
    </Field>
    {showPublic ? <Field>
      <FieldLabel htmlFor={`${idPrefix}-public`}>公开访问地址</FieldLabel>
      <Input id={`${idPrefix}-public`} value={value.public_base_url} onChange={(event) => onChange("public_base_url", event.target.value)} placeholder="https://pub-xxxxxxxx.r2.dev" autoComplete="off" autoCapitalize="none" spellCheck={false} required disabled={disabled} />
      <FieldDescription>r2.dev 开发地址或已绑定到该桶的自有域名，不含路径。</FieldDescription>
    </Field> : null}
    <Field>
      <FieldLabel htmlFor={`${idPrefix}-access-key`}>Access Key ID</FieldLabel>
      <Input id={`${idPrefix}-access-key`} value={value.access_key_id} onChange={(event) => onChange("access_key_id", event.target.value)} placeholder={credentialPlaceholder} autoComplete="off" spellCheck={false} required={!configured} disabled={disabled} />
    </Field>
    <Field>
      <FieldLabel htmlFor={`${idPrefix}-secret-key`}>Secret Access Key</FieldLabel>
      <Input id={`${idPrefix}-secret-key`} type="password" value={value.secret_access_key} onChange={(event) => onChange("secret_access_key", event.target.value)} placeholder={credentialPlaceholder} autoComplete="new-password" spellCheck={false} required={!configured || value.access_key_id.trim() !== ""} disabled={disabled} />
      <FieldDescription>加密保存，不再回显。</FieldDescription>
    </Field>
  </div>
}

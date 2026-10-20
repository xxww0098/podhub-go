import { PlatformAdminDialogFooter } from "@/components/platform-admin-dialog"
import { Save } from "lucide-react"
import type { IntegrationMediaProvider, IntegrationMediaRole } from "@/bindings/commands"
import { Button } from "@/components/ui/button"
import { Field, FieldDescription, FieldGroup, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Spinner } from "@/components/ui/spinner"
import { Switch } from "@/components/ui/switch"
import { S3_PROVIDER_ITEMS, S3_PROVIDERS, providerById } from "./s3-providers"

export type MediaDraft = {
  role: IntegrationMediaRole
  label: string
  provider: IntegrationMediaProvider
  endpoint: string
  region: string
  bucket: string
  keyPrefix: string
  publicBaseUrl: string
  forcePathStyle: boolean
  accessKey: string
  secretKey: string
  sessionToken: string
}

export function MediaEditor({
  draft,
  busy,
  onChange,
  onSave,
  hasStoredSecret,
}: {
  draft: MediaDraft
  busy: boolean
  onChange: (draft: MediaDraft) => void
  onSave: () => void
  /** A row already exists for this role, so an empty secret keeps it. */
  hasStoredSecret: boolean
}) {
  const keepHint = hasStoredSecret ? "留空保留" : undefined
  const provider = providerById(draft.provider)

  return (
    <>
    <div className="grid min-h-0 flex-1 overflow-y-auto md:grid-cols-2">
      <div className="border-border p-5 md:border-r"><FieldGroup className="gap-4">
        <Field className="gap-1.5">
          <FieldLabel htmlFor="s3-label">名称</FieldLabel>
          <Input
            id="s3-label"
            value={draft.label}
            onChange={(e) => onChange({ ...draft, label: e.target.value })}
          />
        </Field>
        <Field className="gap-1.5">
          <FieldLabel htmlFor="s3-provider">厂商</FieldLabel>
          <Select
            items={S3_PROVIDER_ITEMS}
            value={draft.provider === "legacy_s3" ? undefined : draft.provider}
            onValueChange={(next) => {
              const picked = S3_PROVIDERS.find((row) => row.id === next)
              if (!picked) return
              onChange({
                ...draft,
                provider: picked.id,
                region: picked.region,
                forcePathStyle: picked.forcePathStyle,
              })
            }}
          >
            <SelectTrigger id="s3-provider">
              <SelectValue placeholder="请选择供应商" />
            </SelectTrigger>
            <SelectContent>
              {S3_PROVIDERS.map((row) => (
                <SelectItem key={row.id} value={row.id}>
                  {row.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {draft.provider !== "legacy_s3" && provider.hint ? (
            <FieldDescription>{provider.hint}</FieldDescription>
          ) : null}
        </Field>
        <Field className="gap-1.5">
          <FieldLabel htmlFor="s3-endpoint">S3 端点</FieldLabel>
          <Input
            id="s3-endpoint"
            placeholder={
              draft.provider === "legacy_s3" ? "请先选择供应商" : provider.endpointPlaceholder
            }
            value={draft.endpoint}
            onChange={(e) => onChange({ ...draft, endpoint: e.target.value })}
            className="font-mono"
          />
        </Field>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field className="gap-1.5">
            <FieldLabel htmlFor="s3-region">区域</FieldLabel>
            <Input
              id="s3-region"
              value={draft.region}
              onChange={(e) => onChange({ ...draft, region: e.target.value })}
              className="font-mono"
            />
          </Field>
          <Field className="gap-1.5">
            <FieldLabel htmlFor="s3-bucket">空间名</FieldLabel>
            <Input
              id="s3-bucket"
              value={draft.bucket}
              onChange={(e) => onChange({ ...draft, bucket: e.target.value })}
              className="font-mono"
            />
          </Field>
        </div>
        <Field className="gap-1.5">
          <FieldLabel htmlFor="s3-public">公开访问域名</FieldLabel>
          <Input
            id="s3-public"
            value={draft.publicBaseUrl}
            onChange={(e) => onChange({ ...draft, publicBaseUrl: e.target.value })}
            className="font-mono"
            disabled={draft.role === "private"}
            placeholder={draft.role === "private" ? "私有桶没有公开域名" : ""}
          />
        </Field>
        <Field className="gap-1.5">
          <FieldLabel htmlFor="s3-prefix">对象路径前缀</FieldLabel>
          <Input
            id="s3-prefix"
            value={draft.keyPrefix}
            onChange={(e) => onChange({ ...draft, keyPrefix: e.target.value })}
            className="font-mono"
          />
        </Field>
      </FieldGroup></div>

      <aside className="flex flex-col border-t border-border md:border-t-0">
        <div className="border-b border-border px-4 py-3">
          <p className="text-compact font-medium text-foreground">
            密钥
          </p>
        </div>
        <div className="flex-1 p-5"><FieldGroup className="gap-4">
          <Field className="gap-1.5">
            <FieldLabel htmlFor="s3-ak">Access Key</FieldLabel>
            <Input
              id="s3-ak"
              type="password"
              autoComplete="new-password"
              value={draft.accessKey}
              onChange={(e) => onChange({ ...draft, accessKey: e.target.value })}
              placeholder={keepHint}
            />
          </Field>
          <Field className="gap-1.5">
            <FieldLabel htmlFor="s3-sk">Secret Key</FieldLabel>
            <Input
              id="s3-sk"
              type="password"
              autoComplete="new-password"
              value={draft.secretKey}
              onChange={(e) => onChange({ ...draft, secretKey: e.target.value })}
              placeholder={keepHint}
            />
            {hasStoredSecret ? (
              <FieldDescription>两项留空可保留现有密钥。</FieldDescription>
            ) : null}
          </Field>
          <label className="flex h-10 cursor-pointer items-center justify-between gap-3 rounded-lg border border-border px-3">
            <span className="text-compact">path-style</span>
            <Switch
              checked={draft.forcePathStyle}
              onCheckedChange={(next) => onChange({ ...draft, forcePathStyle: next })}
              aria-label="path-style（七牛等兼容端点常需开启）"
            />
          </label>
        </FieldGroup></div>

      </aside>
    </div>
        <PlatformAdminDialogFooter>
          <Button
            type="button"
            className="w-full sm:w-auto"
            disabled={
              busy ||
              draft.provider === "legacy_s3" ||
              !draft.label.trim() ||
              !draft.endpoint.trim() ||
              !draft.region.trim() ||
              !draft.bucket.trim() ||
              (draft.role !== "private" && !draft.publicBaseUrl.trim()) ||
              (!hasStoredSecret && (!draft.accessKey.trim() || !draft.secretKey.trim()))
            }
            onClick={onSave}
          >
            {busy ? <Spinner data-icon="inline-start" /> : <Save data-icon="inline-start" />}
            保存配置
          </Button>
        </PlatformAdminDialogFooter>
    </>
  )
}

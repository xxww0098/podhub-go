import type { IntegrationCredentialsOverview, IntegrationMediaRole } from "@/bindings/commands"
import { integrationsHttp } from "@/bindings/http-integrations"
import { PlatformAdminDialog } from "@/components/platform-admin-dialog"
import { MediaEditor, type MediaDraft } from "./media-editor"

type Props = {
  draft?: MediaDraft
  setDraft: (draft: MediaDraft | undefined) => void
  busy: boolean
  hasStoredSecret: boolean
  apply: (next: Promise<IntegrationCredentialsOverview>, ok?: { title: string; description?: string }) => Promise<boolean>
}

const titles: Record<IntegrationMediaRole, { title: string; description: string; saved: string }> = {
  transit: {
    title: "中转桶",
    description: "wasm 渲染产物投递目标；固定上海时间每天 04:00 清空整桶。",
    saved: "中转桶已保存。切片写入后最长保留一天。",
  },
  assets: {
    title: "素材库桶",
    description: "公开的长期素材：厂家图集 / PSD / 视频与平台目录图片。",
    saved: "素材库桶已保存。公开域名必须是 https://assets.podhub.si。",
  },
  private: {
    title: "私有数据桶",
    description: "组织私有的长期数据：委托原图、PSD 模板与用户文件；没有公开域名。",
    saved: "私有数据桶已保存。所有读取都走短时签名 URL。",
  },
}

export function MediaDialog({ draft, setDraft, busy, hasStoredSecret, apply }: Props) {
  const copy = draft ? titles[draft.role] : undefined
  return (
    <PlatformAdminDialog
      open={Boolean(draft)}
      onOpenChange={(open) => {
        if (!open) setDraft(undefined)
      }}
      title={copy?.title ?? "存储桶"}
      description={copy?.description}
      width="sm:max-w-3xl"
    >
      {draft && copy ? (
        <MediaEditor
          draft={draft}
          busy={busy}
          hasStoredSecret={hasStoredSecret}
          onChange={setDraft}
          onSave={() => {
            if (draft.provider === "legacy_s3") return
            void apply(
              integrationsHttp.integrationsUpsertMediaAccount({
                role: draft.role,
                label: draft.label,
                provider: draft.provider,
                endpoint: draft.endpoint,
                region: draft.region,
                bucket: draft.bucket,
                key_prefix: draft.keyPrefix,
                public_base_url: draft.publicBaseUrl,
                force_path_style: draft.forcePathStyle,
                access_key_id: draft.accessKey,
                secret_access_key: draft.secretKey,
                session_token: draft.sessionToken,
              }),
              {
                title: copy.title + "已保存",
                description: copy.saved,
              },
            ).then((ok) => {
              if (ok) setDraft(undefined)
            })
          }}
        />
      ) : null}
    </PlatformAdminDialog>
  )
}

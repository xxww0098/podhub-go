/**
 * 对象存储厂商预设。
 *
 * 厂商是配置快照里的显式事实，不从 endpoint 猜测。当前对象上传、列举与删除都
 * 复用 S3 兼容协议；厂商专属管理能力在需要时按这个稳定标识接入。
 */
import type { IntegrationMediaProvider } from "@/bindings/commands"

export type S3Provider = {
  id: Exclude<IntegrationMediaProvider, "legacy_s3">
  label: string
  region: string
  forcePathStyle: boolean
  endpointPlaceholder: string
  hint?: string
}

export const S3_PROVIDERS: S3Provider[] = [
  {
    id: "cloudflare",
    label: "Cloudflare R2",
    region: "auto",
    forcePathStyle: true,
    endpointPlaceholder: "https://<account-id>.r2.cloudflarestorage.com",
    hint: "区域固定 auto，出网免费。",
  },
  {
    id: "qiniu",
    label: "七牛云 Kodo",
    region: "cn-east-1",
    forcePathStyle: true,
    endpointPlaceholder: "https://s3.cn-east-1.qiniucs.com",
  },
  {
    id: "tencent",
    label: "腾讯云 COS",
    region: "ap-guangzhou",
    forcePathStyle: false,
    endpointPlaceholder: "https://cos.ap-guangzhou.myqcloud.com",
    hint: "空间名需带 APPID 后缀。",
  },
  {
    id: "aliyun",
    label: "阿里云 OSS",
    region: "oss-cn-hangzhou",
    forcePathStyle: false,
    endpointPlaceholder: "https://oss-cn-hangzhou.aliyuncs.com",
  },
  {
    id: "generic",
    label: "其他 S3 兼容",
    region: "us-east-1",
    forcePathStyle: true,
    endpointPlaceholder: "https://s3.example.com",
    hint: "自建 MinIO 等；单价未知，不做费用估算。",
  },
]

export const GENERIC_PROVIDER = S3_PROVIDERS[S3_PROVIDERS.length - 1]!

/**
 * Base UI Select 的 `items`：弹层未挂载时 `Select.Value` 也要按 label 渲染，
 * 否则触发器退化成原始 id（“cloudflare” 而不是 “Cloudflare R2”）。
 */
export const S3_PROVIDER_ITEMS = S3_PROVIDERS.map((row) => ({
  value: row.id,
  label: row.label,
}))

export function providerById(provider: IntegrationMediaProvider | undefined): S3Provider {
  return S3_PROVIDERS.find((row) => row.id === provider) ?? GENERIC_PROVIDER
}

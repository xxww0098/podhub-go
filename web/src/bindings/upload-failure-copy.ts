/**
 * Operator-facing words for a direct or multipart upload failure.
 * Status and code decide the sentence. A message that is already Chinese is kept.
 */

const CHINESE = /[\u4e00-\u9fff]/

type FailureShape = {
  status?: number
  code?: string
  name?: string
  message?: string
  outcomeUnknown?: boolean
}

function shapeOf(reason: unknown): FailureShape {
  if (!reason || typeof reason !== "object") return {}
  return reason as FailureShape
}

export function uploadFailureMessage(reason: unknown): string {
  const error = shapeOf(reason)
  const status = error.status
  const code = error.code ?? ""
  if (code === "cloud_media_upload_batch_invalid") return "上传批次已失效，请重试上传"
  if (code === "media_complete_kept_batch") return "完成确认繁忙，本机保持整批，不拆成单张"
  if (status === 429) return "请求过于频繁，存储限流"
  if (status === 403) return "上传签名已过期"
  if (code === "media_digest_mismatch" || code === "media_byte_length_mismatch") return "文件校验失败"
  if (code === "psd_etag_missing") return "对象存储没有返回分片标识"
  if (code === "psd_part_gone") return "分片已失效"
  if (status == null && (error.outcomeUnknown === true || error.name === "TypeError" || error.name === "NetworkError")) {
    return "网络已断开"
  }
  if (status === 503) return "存储暂时不可用"
  if (typeof error.message === "string" && CHINESE.test(error.message)) return error.message
  return "上传未完成"
}
